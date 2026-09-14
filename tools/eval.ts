import { readFileSync } from 'node:fs'
import { loadConfig } from '../src/config.js'
import { makeSnClient } from '../src/servicenow/client.js'
import { makeSearch } from '../src/servicenow/search.js'
import { makeStats } from '../src/servicenow/stats.js'
import { hasEnoughTokens } from '../src/guard.js'
import { makeLlm } from '../src/llm/client.js'

interface EvalQ {
  id: string
  source: string
  question: string
  expectedSysId?: string
  acceptableSysIds?: string[]
}

/** Baseline from spec §9. Falling below this is a regression. */
const BASELINE_AT1 = 26

const cfg = loadConfig()
const client = makeSnClient(cfg)
const sn = makeSearch(client)
const data = JSON.parse(readFileSync('tests/fixtures/retrieval-eval.json', 'utf8')) as {
  inScope: EvalQ[]
  outOfScope: EvalQ[]
}

/**
 * Three modes, one script:
 *   (default)      search only — deterministic, free, and the regression guard
 *   --with-retry   the full D13 path; costs Claude calls and varies run to run
 *   --metrics      composed-query correctness against tests/fixtures/metric-eval.json
 */
const METRICS = process.argv.includes('--metrics')
const WITH_RETRY = process.argv.includes('--with-retry')
const llm = METRICS || WITH_RETRY ? makeLlm(cfg) : null

const accept = (q: EvalQ) => q.acceptableSysIds ?? (q.expectedSysId ? [q.expectedSysId] : [])

/** Mirrors the server's retry branch so the eval measures what users actually get. */
async function lookup(question: string) {
  let articles = await sn.search(question)
  let retried = false

  if (llm) {
    const reply = await llm.decide({ question, articles, history: [] })
    if (reply.kind === 'search') {
      retried = true
      const second = await sn.search(reply.query)
      const seen = new Set(second.map((a) => a.id))
      articles = [...second, ...articles.filter((a) => !seen.has(a.id))]
    }
  }
  return { articles, retried }
}

/** Clause order carries no meaning: active=true^priority=1 equals priority=1^active=true. */
const clauses = (f: string) =>
  f.split('^').map((c) => c.trim()).filter(Boolean).sort().join('^')

/** --metrics: does the model compose a query that runs, against the right table? */
async function runMetrics(): Promise<void> {
  const stats = makeStats(client)
  const data = JSON.parse(readFileSync('tests/fixtures/metric-eval.json', 'utf8')) as {
    shouldAnswer: {
      id: string; question: string; table: string
      aggregate: string; field?: string; expectedFilter: string
    }[]
    shouldDecline: { id: string; question: string; why: string }[]
  }

  let executed = 0
  let exactFilter = 0
  let rightTable = 0

  console.log('=== SHOULD ANSWER ===')
  for (const q of data.shouldAnswer) {
    // Real conditions: metric questions still retrieve articles first, and those
    // articles are usually irrelevant. The model must not be distracted by them.
    const articles = await sn.search(q.question)
    const reply = await llm!.decide({ question: q.question, articles, history: [] })

    if (reply.kind !== 'metric') {
      console.log(`${q.id}  NOT A METRIC (${reply.kind})`)
      continue
    }

    const r = reply.request
    const tableOk = r.table === q.table
    const filterOk = clauses(r.filter) === clauses(q.expectedFilter)
    if (tableOk) rightTable++
    if (tableOk && filterOk) exactFilter++

    let value: string | number | 'ERROR' = 'ERROR'
    try {
      value = (await stats.run(r)).value
      executed++
    } catch (e) {
      console.log(`         execution failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    console.log(
      `${q.id}  ${tableOk ? 'table ok' : `table BAD(${r.table})`} ` +
        `${filterOk ? 'filter ok' : 'filter ~'}  = ${value}`,
    )
    if (!filterOk) {
      console.log(`         expected: ${q.expectedFilter}`)
      console.log(`         actual  : ${r.filter}`)
    }
  }

  console.log('\n=== SHOULD DECLINE ===')
  let declined = 0
  for (const q of data.shouldDecline) {
    const articles = await sn.search(q.question)
    const reply = await llm!.decide({ question: q.question, articles, history: [] })
    const ok = reply.kind !== 'metric'
    if (ok) declined++
    console.log(`${q.id}  ${ok ? 'declined' : 'INVENTED A QUERY <- investigate'}  (${q.why})`)
  }

  const n = data.shouldAnswer.length
  console.log('\n=== SUMMARY ===')
  console.log(`Executed cleanly  : ${executed}/${n}   <- the floor; 15/15 measured by hand`)
  console.log(`Right table       : ${rightTable}/${n}`)
  console.log(`Exact filter      : ${exactFilter}/${n}`)
  console.log(`Correctly declined: ${declined}/${data.shouldDecline.length}`)
  console.log('\nA "filter ~" is not automatically wrong — read it. Different clauses can be')
  console.log('equally defensible. What matters is that it executes and says what it counted.')

  if (executed < n) {
    console.error(`\nREGRESSION: ${n - executed} composed queries failed to execute`)
    process.exit(1)
  }
}

async function main() {
  if (METRICS) return runMetrics()

  const ranks: { id: string; rank: number; source: string }[] = []

  console.log(`=== IN-SCOPE ${WITH_RETRY ? '(with D13 retry)' : '(search only)'} ===`)
  let retryCount = 0
  for (const q of data.inScope) {
    const { articles: results, retried } = await lookup(q.question)
    if (retried) retryCount++
    const ok = accept(q)
    const rank = results.findIndex((a) => ok.includes(a.id)) + 1
    ranks.push({ id: q.id, rank, source: q.source })
    console.log(
      `${q.id.padEnd(9)} ${(rank ? `#${rank}` : 'MISS').padEnd(6)} ` +
        `${retried ? 'retry ' : '      '}${results[0]?.label ?? '-'}`,
    )
  }

  // Rev 8 removed the coverage floor, so noise rejection is no longer a deterministic
  // property — it is Claude's judgement. Without --with-retry all we can report is
  // which questions the token guard catches for free.
  console.log('\n=== OUT-OF-SCOPE ===')
  let guarded = 0
  let declined = 0
  for (const q of data.outOfScope) {
    if (!hasEnoughTokens(q.question)) {
      guarded++
      console.log(`${q.id.padEnd(12)} guarded (no model call)`)
      continue
    }
    if (!llm) {
      console.log(`${q.id.padEnd(12)} needs a model call to judge`)
      continue
    }
    const reply = await llm.decide({
      question: q.question,
      articles: await sn.search(q.question),
      history: [],
    })
    const good = reply.kind === 'no_answer'
    if (good) declined++
    console.log(`${q.id.padEnd(12)} ${good ? 'declined' : `ANSWERED (${reply.kind}) <- check this`}`)
  }

  const n = ranks.length
  const at = (k: number) => ranks.filter((r) => r.rank >= 1 && r.rank <= k).length
  const bySrc = (s: string) => {
    const all = ranks.filter((r) => r.source === s)
    return `${all.filter((r) => r.rank >= 1).length}/${all.length}`
  }

  console.log('\n=== SUMMARY ===')
  console.log(`Mode     : ${WITH_RETRY ? 'with D13 retry' : 'search only (deterministic)'}`)
  console.log(`Recall@1 : ${at(1)}/${n} (${Math.round((100 * at(1)) / n)}%)`)
  console.log(`Recall@5 : ${at(5)}/${n} (${Math.round((100 * at(5)) / n)}%)`)
  console.log(`incident : ${bySrc('incident')}   synthetic: ${bySrc('synthetic')}`)
  console.log(`Misses   : ${ranks.filter((r) => !r.rank).map((r) => r.id).join(', ') || 'none'}`)
  console.log(`Noise    : ${guarded} guarded free${llm ? `, ${declined} declined by the model` : ''}`)
  if (WITH_RETRY) {
    console.log(`Retries  : ${retryCount}/${n} questions triggered a rewrite`)
    console.log('Baseline without retry was 26/35 (74%) recall@1 — compare against that.')
  }

  // The guard applies only to the deterministic mode. Retry varies run to run, and a
  // regression gate on a wobbling number is worse than none.
  if (!WITH_RETRY && at(1) < BASELINE_AT1) {
    console.error(`\nREGRESSION: recall@1 ${at(1)} is below the recorded baseline of ${BASELINE_AT1}`)
    process.exit(1)
  }
}

main()
