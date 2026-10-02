import { readFileSync } from 'node:fs'
import { loadConfig } from '../src/config.js'
import { makeSnClient } from '../src/servicenow/client.js'
import { makeSearch } from '../src/servicenow/search.js'
import { hasEnoughTokens } from '../src/guard.js'
import { makeDefinitions } from '../src/definitions.js'
import { relevant, parseContext } from '../src/server.js'
import { runAgent, makeAgentModel, type AgentOutcome } from '../src/llm/agent.js'

interface EvalQ {
  id: string
  source: string
  question: string
  expectedSysId?: string
  acceptableSysIds?: string[]
}

/** Recall@1 the retrieval suite must not fall below. Set 2026-10-01 after the query scrub (was 26). */
const BASELINE_AT1 = 29

const cfg = loadConfig()
const client = makeSnClient(cfg)
const sn = makeSearch(client)
// The same definitions the standalone server runs with: no scan, standard open states.
const kpis = makeDefinitions(() => ({ params: { open_states: cfg.openStates, in_progress_states: '2', on_hold_states: '3', closed_states: '6,7', cancelled_states: '8', time_zone: 'UTC', automation_accounts: '' }, tables: null, confirmed: false }))
const catalogue = kpis.catalogue()

/**
 * Three modes, one script:
 *   (default)   retrieval: search only, deterministic, free, the regression guard for the knowledge path
 *   --agent     the question fixtures through the tool loop against the live model (tests/fixtures/*-eval.json)
 *   --resolve   Resolve's next steps, grounding-checked against a live mockup (MOCKUP_URL)
 */
const AGENT = process.argv.includes('--agent')
const RESOLVE = process.argv.includes('--resolve')

const accept = (q: EvalQ) => q.acceptableSysIds ?? (q.expectedSysId ? [q.expectedSysId] : [])

/** Exactly what search_knowledge does: the scrubbed search, then the relevance floor. */
const retrieve = async (question: string) => relevant(question, await sn.search(question))

type FixtureHistory = ['user' | 'assistant', string][]
type FixtureContext = { page?: string; ticket?: string; facts?: unknown }

/**
 * --agent: every question fixture through the tool loop (rev 10). A pick is right when run_definition
 * ran with the expected id (narrowed as named); a composition when count ran on the expected table; a
 * breakdown when aggregate did; a list when list_records did; an article answer when a cited result
 * carried one of the expected articles; a page answer when the reply carries the fact; a decline when
 * the reply cited nothing, cited only a lookup, or asked the user. Every answer must be grounded.
 */
async function runAgentEval(): Promise<void> {
  type Pick = { id: string; question: string; definition: string; group?: string; narrow?: { kind: string; text: string }; context?: FixtureContext; history?: FixtureHistory }
  type Fixture = {
    shouldPick?: Pick[]
    shouldCompose?: { id: string; question: string; table: string }[]
    shouldBreakDown?: { id: string; question: string; table: string }[]
    shouldList?: { id: string; question: string; table: string; orCount?: boolean }[]
    shouldAnswerFromArticle?: { id: string; question: string; articles: string[] }[]
    shouldAnswerFromPage?: { id: string; question: string; expect: string; context?: FixtureContext }[]
    shouldDecline?: { id: string; question: string; why: string }[]
  }
  // The core fixture (the questions that broke earlier designs) plus the paraphrase fixture.
  const files = ['tests/fixtures/routing-eval.json', 'tests/fixtures/agent-eval.json'].map((f) => JSON.parse(readFileSync(f, 'utf8')) as Fixture)
  // --only=r-21,pp-0,ls- runs the ids with any of these prefixes: the misses from a full run, re-checked in minutes.
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean)
  const sel = <T extends { id: string }>(key: keyof Fixture): T[] => files.flatMap((f) => (f[key] ?? []) as unknown as T[]).filter((q) => !only?.length || only.some((p) => q.id.startsWith(p)))
  const fx = {
    shouldPick: sel<Pick>('shouldPick'),
    shouldCompose: sel<{ id: string; question: string; table: string }>('shouldCompose'),
    shouldBreakDown: sel<{ id: string; question: string; table: string }>('shouldBreakDown'),
    shouldList: sel<{ id: string; question: string; table: string; orCount?: boolean }>('shouldList'),
    shouldAnswerFromArticle: sel<{ id: string; question: string; articles: string[] }>('shouldAnswerFromArticle'),
    shouldAnswerFromPage: sel<{ id: string; question: string; expect: string; context?: FixtureContext }>('shouldAnswerFromPage'),
    shouldDecline: sel<{ id: string; question: string; why: string }>('shouldDecline'),
  }
  const model = makeAgentModel(cfg)
  const ask = (question: string, context?: FixtureContext, history?: FixtureHistory) => {
    const ctx = context ? parseContext(context) : undefined
    return runAgent(model, {
      question, history: (history ?? []).map(([role, content]) => ({ role, content })), context: ctx, catalogue,
      ctx: { sn: client, kpis, scanned: null, openStates: cfg.openStates, user: ctx?.user, facts: ctx?.facts },
    })
  }
  const tools = (o: AgentOutcome) => o.results.map((r) => `${r.tool}${'error' in r.data ? '!' : ''}${r.tool === 'run_definition' ? `(${String(r.args.id)})` : ['count', 'aggregate', 'list_records'].includes(r.tool) ? `(${String(r.args.table)})` : ''}`).join(' → ')
  const text = (o: AgentOutcome) => ('text' in o ? o.text : o.reason).replace(/\s+/g, ' ').slice(0, 90)
  const ran = (o: AgentOutcome, tool: string, pred: (r: { args: Record<string, unknown>; data: Record<string, unknown> }) => boolean) => o.results.some((r) => r.tool === tool && !('error' in r.data) && pred(r))
  let picked = 0, composed = 0, fromPage = 0, declined = 0, ungrounded = 0, brokeDown = 0, listed = 0, fromArticle = 0

  console.log('=== SHOULD RUN THE DEFINITION ===')
  for (const q of fx.shouldPick) {
    const o = await ask(q.question, q.context, q.history)
    if (o.kind === 'ungrounded') ungrounded++
    const want = (q.group ?? q.narrow?.text)?.toLowerCase()
    const hit = ran(o, 'run_definition', (r) => r.args.id === q.definition && (want ? String(r.data.narrowed ?? '').toLowerCase().includes(want) : !r.data.narrowed))
    const ok = o.kind === 'answer' && hit
    if (ok) picked++
    console.log(`${q.id}  ${ok ? 'ok      ' : 'WRONG   '} ${tools(o).padEnd(60)} expected ${q.definition}${want ? ' for ' + want : ''}  "${text(o)}"`)
  }
  console.log('\n=== SHOULD COMPOSE (no tile fits) ===')
  for (const q of fx.shouldCompose) {
    const o = await ask(q.question)
    if (o.kind === 'ungrounded') ungrounded++
    const ok = o.kind === 'answer' && (ran(o, 'count', (r) => r.args.table === q.table) || ran(o, 'aggregate', (r) => r.args.table === q.table) || ran(o, 'list_records', (r) => r.args.table === q.table))
    if (ok) composed++
    console.log(`${q.id}  ${ok ? 'ok      ' : 'WRONG   '} ${tools(o).padEnd(60)} expected a query on ${q.table}  "${text(o)}"`)
  }
  console.log('\n=== SHOULD BREAK DOWN (aggregate) ===')
  for (const q of fx.shouldBreakDown) {
    const o = await ask(q.question)
    if (o.kind === 'ungrounded') ungrounded++
    const ok = o.kind === 'answer' && ran(o, 'aggregate', (r) => r.args.table === q.table)
    if (ok) brokeDown++
    console.log(`${q.id}  ${ok ? 'ok      ' : 'WRONG   '} ${tools(o).padEnd(60)} expected aggregate on ${q.table}  "${text(o)}"`)
  }
  console.log('\n=== SHOULD LIST (list_records) ===')
  for (const q of fx.shouldList) {
    const o = await ask(q.question)
    if (o.kind === 'ungrounded') ungrounded++
    // Some "what are the X" questions read equally as a figure; orCount accepts a definition, count or aggregate on the same table.
    const asCount = q.orCount && (ran(o, 'run_definition', (r) => r.data.table === q.table) || ran(o, 'count', (r) => r.args.table === q.table) || ran(o, 'aggregate', (r) => r.args.table === q.table))
    const ok = o.kind === 'answer' && (ran(o, 'list_records', (r) => r.args.table === q.table) || !!asCount)
    if (ok) listed++
    console.log(`${q.id}  ${ok ? 'ok      ' : 'WRONG   '} ${tools(o).padEnd(60)} expected list_records on ${q.table}${q.orCount ? ' (or its figure)' : ''}  "${text(o)}"`)
  }
  console.log('\n=== SHOULD ANSWER FROM AN ARTICLE ===')
  for (const q of fx.shouldAnswerFromArticle) {
    const o = await ask(q.question)
    if (o.kind === 'ungrounded') ungrounded++
    const cited = o.kind === 'answer' ? o.cited.flatMap((r) => (r.articles ?? []).map((a) => a.label ?? '')) : []
    const ok = cited.some((l) => q.articles.includes(l))
    if (ok) fromArticle++
    console.log(`${q.id}  ${ok ? 'ok      ' : 'WRONG   '} ${tools(o).padEnd(50)} cited ${cited.join(',') || '-'}; expected one of ${q.articles.join(',')}  "${text(o)}"`)
  }
  console.log('\n=== SHOULD ANSWER FROM PAGE FACTS ===')
  for (const q of fx.shouldAnswerFromPage) {
    const o = await ask(q.question, q.context)
    if (o.kind === 'ungrounded') ungrounded++
    const declineOf = /^NO_ANSWER (\w+)$/.exec(q.expect)
    // Without page facts the loop may still answer through my_queue or get_ticket; that is progress, not a miss.
    const ok = declineOf ? o.kind !== 'ungrounded' && o.kind !== 'failed' : o.kind === 'answer' && o.text.includes(q.expect)
    if (ok) fromPage++
    console.log(`${q.id}  ${ok ? 'ok      ' : 'WRONG   '} ${tools(o).padEnd(60)} expected ${q.expect}  "${text(o)}"`)
  }
  console.log('\n=== SHOULD NOT GUESS ===')
  for (const q of fx.shouldDecline) {
    const o = await ask(q.question)
    if (o.kind === 'ungrounded') ungrounded++
    // A reply that cites only a lookup is not an answer: it either asks which candidate or says nothing matched.
    const asked = o.kind === 'answer' && o.cited.length > 0 && o.cited.every((r) => r.tool === 'resolve_reference')
    const ok = o.kind === 'clarify' || asked || (o.kind === 'answer' && o.cited.length === 0)
    if (ok) declined++
    console.log(`${q.id}  ${ok ? 'declined' : o.kind === 'answer' ? 'ANSWERED <- check' : o.kind.toUpperCase().padEnd(8)} ${tools(o).padEnd(60)} (${q.why})  "${text(o)}"`)
  }
  console.log('\n=== SUMMARY ===')
  const total = fx.shouldPick.length + fx.shouldCompose.length + fx.shouldBreakDown.length + fx.shouldList.length + fx.shouldAnswerFromArticle.length + fx.shouldAnswerFromPage.length + fx.shouldDecline.length
  const right = picked + composed + brokeDown + listed + fromArticle + fromPage + declined
  console.log(`Ran the right definition      : ${picked}/${fx.shouldPick.length}`)
  console.log(`Composed where no tile fits   : ${composed}/${fx.shouldCompose.length}`)
  console.log(`Broke down with aggregate     : ${brokeDown}/${fx.shouldBreakDown.length}`)
  console.log(`Listed with list_records      : ${listed}/${fx.shouldList.length}`)
  console.log(`Answered from the right article: ${fromArticle}/${fx.shouldAnswerFromArticle.length}`)
  console.log(`Answered from page or tools   : ${fromPage}/${fx.shouldAnswerFromPage.length}`)
  console.log(`Declined or asked              : ${declined}/${fx.shouldDecline.length}`)
  console.log(`Ungrounded answers withheld   : ${ungrounded}`)
  console.log(`\nOverall: ${right}/${total} (${Math.round(100 * right / total)}%). Readiness bar: 95% with zero wrong numbers shown.`)
  if (picked < fx.shouldPick.length) { console.error(`\nREGRESSION: ${fx.shouldPick.length - picked} questions did not run the expected definition`); process.exit(1) }
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

/** Default: retrieval recall over the live search, no model. The guard for the knowledge path. */
async function runRetrieval(): Promise<void> {
  const data = JSON.parse(readFileSync('tests/fixtures/retrieval-eval.json', 'utf8')) as { inScope: EvalQ[]; outOfScope: EvalQ[] }
  const ranks: { id: string; rank: number; source: string }[] = []

  console.log('=== IN-SCOPE (search only) ===')
  for (const q of data.inScope) {
    const results = await retrieve(q.question)
    const ok = accept(q)
    const rank = results.findIndex((a) => ok.includes(a.id)) + 1
    ranks.push({ id: q.id, rank, source: q.source })
    console.log(`${q.id.padEnd(9)} ${(rank ? `#${rank}` : 'MISS').padEnd(6)} ${results[0]?.label ?? '-'}`)
  }

  // Noise rejection is the model's judgement in the loop; here only the token guard's free catches are reported.
  console.log('\n=== OUT-OF-SCOPE ===')
  let guarded = 0
  for (const q of data.outOfScope) {
    if (!hasEnoughTokens(q.question)) { guarded++; console.log(`${q.id.padEnd(12)} guarded (no model call)`) }
    else console.log(`${q.id.padEnd(12)} judged by the model in --agent`)
  }

  const at1 = ranks.filter((r) => r.rank === 1).length
  const at5 = ranks.filter((r) => r.rank >= 1 && r.rank <= 5).length
  const by = (src: string) => { const xs = ranks.filter((r) => r.source === src); return `${xs.filter((r) => r.rank >= 1 && r.rank <= 5).length}/${xs.length}` }
  const n = ranks.length
  console.log('\n=== SUMMARY ===')
  console.log('Mode     : search only (deterministic)')
  console.log(`Recall@1 : ${at1}/${n} (${Math.round(100 * at1 / n)}%)`)
  console.log(`Recall@5 : ${at5}/${n} (${Math.round(100 * at5 / n)}%)`)
  console.log(`incident : ${by('incident')}   synthetic: ${by('synthetic')}`)
  console.log(`Misses   : ${ranks.filter((r) => !r.rank).map((r) => r.id).join(', ') || 'none'}`)
  console.log(`Noise    : ${guarded} guarded free`)
  if (at1 < BASELINE_AT1) { console.error(`\nREGRESSION: recall@1 ${at1} is below the baseline ${BASELINE_AT1}`); process.exit(1) }
}

async function main() {
  if (AGENT) return runAgentEval()
  if (RESOLVE) return runResolve()
  return runRetrieval()
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
