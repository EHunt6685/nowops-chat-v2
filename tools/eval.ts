import { readFileSync } from 'node:fs'
import { loadConfig } from '../src/config.js'
import { makeSnClient } from '../src/servicenow/client.js'
import { makeSearch } from '../src/servicenow/search.js'
import { makeStats } from '../src/servicenow/stats.js'
import { hasEnoughTokens } from '../src/guard.js'
import { makeLlm, type Reply } from '../src/llm/client.js'
import { makeDefinitions } from '../src/definitions.js'
import { relevant, parseContext } from '../src/server.js'

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
const stats = makeStats(client)
// The same definitions the standalone server runs with: no scan, standard open states.
const kpis = makeDefinitions(() => ({ params: { open_states: cfg.openStates }, tables: null, confirmed: false }))
const catalogue = kpis.catalogue()

const data = JSON.parse(readFileSync('tests/fixtures/retrieval-eval.json', 'utf8')) as {
  inScope: EvalQ[]
  outOfScope: EvalQ[]
}

/**
 * Four modes, one script:
 *   (default)      search only — deterministic, free, and the regression guard
 *   --with-retry   the full D13 path; costs Claude calls and varies run to run
 *   --metrics      composed-query correctness against tests/fixtures/metric-eval.json
 *   --routing      does the model name the right definition, compose only where no tile fits,
 *                  and decline what it must not guess? tests/fixtures/routing-eval.json
 */
const METRICS = process.argv.includes('--metrics')
const ROUTING = process.argv.includes('--routing')
const RESOLVE = process.argv.includes('--resolve')
const WITH_RETRY = process.argv.includes('--with-retry')
const llm = METRICS || ROUTING || WITH_RETRY ? makeLlm(cfg) : null

const accept = (q: EvalQ) => q.acceptableSysIds ?? (q.expectedSysId ? [q.expectedSysId] : [])

/** Exactly what the server does before the model sees a question: search, then the relevance floor. */
const retrieve = async (question: string) => relevant(question, await sn.search(question))

type FixtureHistory = ['user' | 'assistant', string][]

type FixtureContext = { page?: string; ticket?: string; facts?: unknown }

/** One model call as the server makes it: articles, catalogue, optional history and page context, facts clamped as the server clamps them. */
const decide = (question: string, articles = [] as Awaited<ReturnType<typeof retrieve>>, context?: FixtureContext, history: FixtureHistory = []) =>
  llm!.decide({ question, articles, history: history.map(([role, content]) => ({ role, content })), catalogue, context: context ? parseContext(context) : undefined })

/** Mirrors the server's retry branch so the eval measures what users actually get. */
async function lookup(question: string) {
  let articles = await retrieve(question)
  let retried = false

  if (llm) {
    const reply = await decide(question, articles)
    if (reply.kind === 'search') {
      retried = true
      const second = await retrieve(reply.query)
      const seen = new Set(second.map((a) => a.id))
      articles = [...second, ...articles.filter((a) => !seen.has(a.id))]
    }
  }
  return { articles, retried }
}

/** Clause order carries no meaning: active=true^priority=1 equals priority=1^active=true. */
const clauses = (f: string) =>
  f.split('^').map((c) => c.trim()).filter(Boolean).sort().join('^')

const describe = (r: Reply) =>
  r.kind === 'definition' ? `DEFINITION ${r.id}` : r.kind === 'metric' ? `METRIC ${r.request.table} · ${r.request.filter || '(all)'}` : r.kind === 'no_answer' ? `NO_ANSWER ${r.about}` : r.kind.toUpperCase()

/** --routing: the guard for what the regex used to do by hand. */
async function runRouting(): Promise<void> {
  const fx = JSON.parse(readFileSync('tests/fixtures/routing-eval.json', 'utf8')) as {
    shouldPick: { id: string; question: string; definition: string; context?: FixtureContext; history?: FixtureHistory }[]
    shouldCompose: { id: string; question: string; table: string }[]
    shouldAnswerFromPage: { id: string; question: string; expect: string; context?: FixtureContext }[]
    shouldDecline: { id: string; question: string; why: string }[]
  }

  let picked = 0, composed = 0, declined = 0, fromPage = 0
  console.log('=== SHOULD PICK A DEFINITION ===')
  for (const q of fx.shouldPick) {
    const r = await decide(q.question, await retrieve(q.question), q.context, q.history)
    const ok = r.kind === 'definition' && r.id === q.definition
    if (ok) picked++
    const where = q.context ? `  (from ${q.context.page}${q.context.ticket ? ' ' + q.context.ticket : ''})` : q.history ? '  (follow-up)' : ''
    console.log(`${q.id}  ${ok ? 'ok      ' : 'WRONG   '} ${describe(r).padEnd(40)} expected ${q.definition}${where}`)
  }

  console.log('\n=== SHOULD COMPOSE (no tile fits) ===')
  for (const q of fx.shouldCompose) {
    const r = await decide(q.question, await retrieve(q.question))
    const ok = r.kind === 'metric' && r.request.table === q.table
    if (ok) composed++
    console.log(`${q.id}  ${ok ? 'ok      ' : r.kind === 'definition' ? 'REACHED FOR A TILE' : 'WRONG   '} ${describe(r).padEnd(40)} expected METRIC on ${q.table}`)
  }

  console.log('\n=== SHOULD ANSWER FROM PAGE FACTS ===')
  for (const q of fx.shouldAnswerFromPage ?? []) {
    const r = await decide(q.question, await retrieve(q.question), q.context)
    // "NO_ANSWER <type>" expects a decline of that type; anything else expects a PAGE answer carrying the fact.
    const declineOf = /^NO_ANSWER (\w+)$/.exec(q.expect)?.[1]
    const ok = declineOf ? r.kind === 'no_answer' && r.about === declineOf : r.kind === 'page' && r.text.includes(q.expect)
    if (ok) fromPage++
    console.log(`${q.id}  ${ok ? 'ok      ' : 'WRONG   '} ${(r.kind === 'page' ? `PAGE "${r.text.slice(0, 60)}"` : describe(r)).padEnd(70)} expected ${q.expect}`)
  }

  console.log('\n=== SHOULD DECLINE ===')
  for (const q of fx.shouldDecline) {
    const r = await decide(q.question, await retrieve(q.question))
    const ok = r.kind === 'no_answer'
    if (ok) declined++
    console.log(`${q.id}  ${ok ? 'declined' : 'ANSWERED <- investigate'} ${describe(r).padEnd(40)} (${q.why})`)
  }

  console.log('\n=== SUMMARY ===')
  console.log(`Picked the right definition : ${picked}/${fx.shouldPick.length}`)
  console.log(`Composed where no tile fits : ${composed}/${fx.shouldCompose.length}`)
  console.log(`Answered from page facts    : ${fromPage}/${(fx.shouldAnswerFromPage ?? []).length}`)
  console.log(`Declined what it must not guess: ${declined}/${fx.shouldDecline.length}`)
  console.log('\nA wrong pick is the quiet failure this fixture exists for: the number would look right')
  console.log('and disagree with the tile. Read every WRONG line.')

  // The gate: a wrong definition is a wrong number shown with a tile's name on it.
  if (picked < fx.shouldPick.length) {
    console.error(`\nREGRESSION: ${fx.shouldPick.length - picked} questions routed to the wrong definition or none`)
    process.exit(1)
  }
}

/** --metrics: does the model compose a query that runs, against the right table? */
async function runMetrics(): Promise<void> {
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
  let viaDefinition = 0

  console.log('=== SHOULD ANSWER ===')
  for (const q of data.shouldAnswer) {
    // Real conditions: every question retrieves articles first, and for a count they are
    // usually irrelevant. The model must not be distracted by them.
    const articles = await retrieve(q.question)
    const reply = await decide(q.question, articles)

    // A definition is the better answer when one fits: run it through the same code as the tile.
    let r: { table: string; filter: string; aggregate: string; field?: string }
    if (reply.kind === 'definition') {
      const k = kpis.byId(reply.id)
      if (!k?.request) { console.log(`${q.id}  DEFINITION ${reply.id} ${k ? `unavailable: ${k.unavailable}` : 'UNKNOWN ID'}`); continue }
      viaDefinition++
      r = k.request
    } else if (reply.kind === 'metric') {
      r = reply.request
    } else {
      console.log(`${q.id}  NOT A METRIC (${describe(reply)})`)
      continue
    }

    const tableOk = r.table === q.table
    const filterOk = clauses(r.filter) === clauses(q.expectedFilter)
    if (tableOk) rightTable++
    if (tableOk && filterOk) exactFilter++

    let value: string | number | 'ERROR' = 'ERROR'
    try {
      value = (await stats.run({ ...r, aggregate: r.aggregate as 'count' })).value
      executed++
    } catch (e) {
      console.log(`         execution failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    console.log(
      `${q.id}  ${reply.kind === 'definition' ? `def ${reply.id}` : 'composed'}  ${tableOk ? 'table ok' : `table BAD(${r.table})`} ` +
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
    const articles = await retrieve(q.question)
    const reply = await decide(q.question, articles)
    const ok = reply.kind !== 'metric' && reply.kind !== 'definition'
    if (ok) declined++
    console.log(`${q.id}  ${ok ? 'declined' : 'INVENTED A QUERY <- investigate'}  ${describe(reply).padEnd(36)} (${q.why})`)
  }

  const n = data.shouldAnswer.length
  console.log('\n=== SUMMARY ===')
  console.log(`Executed cleanly  : ${executed}/${n}   (${viaDefinition} through a definition, the rest composed)`)
  console.log(`Right table       : ${rightTable}/${n}`)
  console.log(`Exact filter      : ${exactFilter}/${n}`)
  console.log(`Correctly declined: ${declined}/${data.shouldDecline.length}`)
  console.log('\nA "filter ~" is not automatically wrong — read it. A definition\'s filter is the tile\'s,')
  console.log('and differs from the fixture\'s hand-written one on purpose. What matters is that it')
  console.log('executes and says what it counted. Baseline before rev 9 (2026-09-30): 11/15 executed.')

  // Whether the model chooses to answer wobbles run to run; a composed query that does not run does not.
  if (executed < rightTable) {
    console.error(`\nREGRESSION: ${rightTable - executed} queries on the right table failed to execute`)
    process.exit(1)
  }
}

/**
 * --resolve: are Resolve's next steps grounded? Runs against a live mockup because the ticket
 * evidence is built there. Every cited number must be in the evidence, no cited article may be about
 * another system, no cited look-alike may be a boilerplate closure, an escalated precedent must be
 * proposed as an escalation, and "nothing covers this" must be said when it is true.
 */
async function runResolve(): Promise<void> {
  const base = process.env.MOCKUP_URL ?? 'http://localhost:3100'
  const fx = JSON.parse(readFileSync('tests/fixtures/resolve-eval.json', 'utf8')) as {
    tickets: { number: string; title: string; expect: Record<string, boolean | string>; notes?: string }[]
  }
  const REF = /\b(INC\d{7}|RITM\d{7}|KB\d{7}|SOP\d{7}|KBSGC\d{7})\b/g
  let failures = 0
  for (const t of fx.tickets) {
    const detail = await (await fetch(`${base}/api/resolve/ticket/${t.number}`)).json() as {
      number: string; title: string; fields: Record<string, string>
      journal: { kind: string; text: string; at: string; nowops?: boolean }[]
      similar: { number: string; caller?: string; close_notes: string; outcome?: string }[]
      sameTitle: { number: string }[]
      kb: { number: string; title: string; match: boolean; otherSystem?: boolean }[]
    }
    const steps = await (await fetch(`${base}/api/resolve/steps/${t.number}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { source: string; steps: { text: string; source: string }[] }
    const known = new Set([detail.number, ...detail.similar.map((s) => s.number), ...detail.sameTitle.map((s) => s.number), ...detail.kb.map((k) => k.number)])
    const problems: string[] = []
    const all = steps.steps.map((s) => `${s.text} ${s.source}`).join('\n')
    for (const ref of new Set(all.match(REF) ?? [])) if (!known.has(ref)) problems.push(`cites ${ref}, not in the evidence`)
    for (const k of detail.kb) if (k.otherSystem && all.includes(k.number)) problems.push(`cites ${k.number}, about another system`)
    for (const s of detail.similar) if (s.outcome === 'hollow' && all.includes(s.number)) problems.push(`cites ${s.number}, a boilerplate closure`)
    const escalatedOnly = detail.similar.length > 0 && detail.similar.every((s) => s.outcome !== 'resolved')
    if (escalatedOnly && !/escalat/i.test(all)) problems.push('look-alikes were escalated, no step proposes escalation')
    if (escalatedOnly && /as done previously|as (?:was )?done before|reactivate .* as/i.test(all)) problems.push('claims a prior fix where the precedent only escalated')
    const matched = detail.kb.filter((k) => k.match && !k.otherSystem)
    if (!matched.length && !detail.similar.some((s) => s.outcome === 'resolved') && !/no (?:published )?(?:knowledge )?article|nothing (?:on this instance )?covers|no resolved look-alike|no precedent/i.test(all)) problems.push('no evidence exists and no step says so')
    for (const s of detail.similar) if (s.caller && s.caller !== detail.fields.caller_id && new RegExp(`\\b${s.caller.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(all) && !/different caller/i.test(all)) problems.push(`names look-alike caller ${s.caller} without saying they are a different caller`)
    for (const j of detail.journal) if (j.nowops && all.includes(`work note of ${j.at.slice(0, 10)}`)) problems.push(`reads NowOps's own note of ${j.at.slice(0, 10)} as a finding`)
    const want = t.expect.uses_matched_article
    if (typeof want === 'string' && detail.kb.some((k) => k.number === want) && !all.includes(want)) problems.push(`matched article ${want} not used`)
    if (problems.length) failures++
    console.log(`${t.number}  ${problems.length ? 'PROBLEMS' : 'ok      '}  ${t.title.slice(0, 60)}  (${steps.source}, ${steps.steps.length} steps; evidence: ${detail.similar.length} look-alikes, ${matched.length} matched articles)`)
    for (const p of problems) console.log(`           - ${p}`)
  }
  console.log(`\n=== SUMMARY ===\nGrounded: ${fx.tickets.length - failures}/${fx.tickets.length} tickets with no problems`)
  if (failures) { console.error(`\nREGRESSION: ${failures} tickets with grounding problems`); process.exit(1) }
}

async function main() {
  if (ROUTING) return runRouting()
  if (METRICS) return runMetrics()
  if (RESOLVE) return runResolve()

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

  // Noise rejection is Claude's judgement. Without a model all we can report is which
  // questions the token guard catches for free.
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
    const reply = await decide(q.question, await retrieve(q.question))
    const good = reply.kind === 'no_answer'
    if (good) declined++
    console.log(`${q.id.padEnd(12)} ${good ? `declined (${reply.about})` : `ANSWERED (${describe(reply)}) <- check this`}`)
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
