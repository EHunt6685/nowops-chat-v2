// The tool loop. One question, up to STEP_BUDGET tool calls at temperature 0, then a final answer
// whose every number must be cited to a tool result that contains it. Replaces the five-form
// pipeline (rev 9), which could only answer what the server had a form for. Rev 10, 2026-10-02.
import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../config.js'
import type { Article } from '../servicenow/types.js'
import type { CatalogueEntry } from '../definitions.js'
import { toolSpecs, executeTool } from '../tools/index.js'
import { makeTurn, type ToolContext, type ToolResult } from '../tools/types.js'
import { buildUserBlock, type DecideContext, type Turn } from './client.js'
import { log } from '../log.js'

export const STEP_BUDGET = 6
const MAX_TOKENS = 1500

export const AGENT_SYSTEM = `You are NowOps, an assistant for one ServiceNow instance. You answer with tools; you never answer from memory about this instance.

Today is {{TODAY}}. Dates in questions:
- A named month or year ("June", "Q2", "2025") is an absolute range written with literal dates: end_timeBETWEEN2026-06-01 00:00:00@2026-06-30 23:59:59. A month with no year is this year's, or last year's if it has not happened yet this year. Never translate a named month into "last month" or monthsAgo.
- Relative words ("this month", "last 7 days", "yesterday") use the gs date functions: gs.beginningOfThisMonth(), gs.daysAgoStart(7), gs.beginningOfYesterday().
- Say the range you used in the answer when the question was a named period, e.g. "in June 2026".
- The instance's time zone is {{TZ}}. Literal dates in filters are stored in UTC; for a whole month or quarter the UTC calendar bounds are what the dashboard uses, so use them too.

This instance's incident states, as the scan classified them from their labels: open = stateIN{{OPEN_STATES}}; in progress = {{IN_PROGRESS}}; on hold = {{ON_HOLD}}; resolved or closed = {{CLOSED}}; cancelled = {{CANCELLED}}. Use these values when you compose an incident filter; never active=true for "open" incidents, since resolved and closed records can still be active. Request items, changes and problems use active=true.

What you can do
- Numbers: run_definition for a dashboard tile (always first when a tile matches exactly), count for a filter no tile has, aggregate for breakdowns and rankings.
- Names: a group, location, service, CI, user, company or department the user names goes through resolve_reference first. Never put a name or a sys_id into a filter that resolve_reference did not return this turn. If it returns apply=false, call ask_user with the candidates; do not pick one.
- Lists: "what are the ...", "which ...", "show me", "list" ask to see the records: run list_records (it carries the true total) even when a definition covers the count; a count alone does not answer them. Quote the total, never the number of rows returned.
- Schema: describe_table and list_choices when unsure of a field or a value; validate_query if a filter was rejected.
- Procedures: search_knowledge, then get_article if the snippet is not enough. Search again with the knowledge base's own words before giving up. An article about a different system than the user's is the wrong article; a generic question with several system-specific articles is answered by naming the systems covered.
- The user's own work: get_ticket for a ticket number or "this ticket" (the USER block names the open TICKET), my_queue for "my tickets", "waiting on me".
- The USER block says where the user is (page, open TICKET). That is not what they asked about: "SLAs at risk" asked from a ticket page is the dashboard definition, not that ticket's SLAs. Only "this ticket", "this one", "my queue" refer to the page. "This ticket" with no TICKET in the USER block is a general question about such tickets: search the knowledge base, do not call get_ticket without a number.
- Scope is everything a service desk handles: tickets, SLAs, changes, problems, requests, CMDB, assets, security, and any business application or device users raise tickets about (ERP, tax, payroll, printers, VPN, portals). Search the knowledge base before deciding a how-to is out of scope. Out of scope is only non-work subjects and writing code.
- SLA breaches: the dashboard's SLA Breaches tile counts completed, type SLA, incident SLAs (stage=completed^sla.type=SLA), so it adds up with SLAs met. When you compose your own breach count or breakdown on task_sla, start from that same filter unless the user asks about SLAs still running, and say which basis you used.
- Vocabulary: "criticals" or "critical incidents" are priority 1 incidents (open_p1); "security incidents" or "secops incidents" are security_open (a table, not a group); "vulns" are vulnerable items; "requests" are request items (sc_req_item); "tickets" are incidents unless the user says otherwise.
- Follow-ups refer to the previous answer in the conversation: narrow or vary what was done before. A question asked again is answered again. When the narrowing is itself a definition (open incidents, then "how many of those are P1" is open_p1), run that definition rather than composing a count, so the figure matches the tile.

How to answer
- Every number you state must appear in a tool result from this turn, and you cite that result's id in square brackets right after it: "5,527 breached incident SLAs for the Network group [r3]". Cite articles the same way. Uncited numbers are rejected.
- A definition result's label and "narrowed" phrase are written by the server from the filter it applied: use them as given.
- Be brief: one or two sentences for a number, numbered steps for a procedure, a short list for records (number, title, one detail each). No preamble. Plain text only: no markdown emphasis, headings or tables; numbered or dashed lines are fine. Earlier assistant turns end with a "(tools used: ...)" note written by the server for your reference; never write one yourself.
- When the user asks for a share or percentage and both figures are in your results, state the percentage as well as the figures.
- When a tool says a definition is unavailable or has no data yet, say that and why. Do not substitute another count.
- When nothing on the instance answers (not ServiceNow data, nothing resolves, no article), say in one sentence what you looked for and what was missing. Never guess, never answer from general knowledge, never invent a name, field or value.
- Out of scope (weather, sport, code to write, trivia): say in one sentence that you answer only about this instance.
- If the step budget runs out, state what you found so far, with citations, and what you could not do.

Definitions (id — name) you may run with run_definition:
{{DEFINITIONS}}`

export interface AgentOptions {
  question: string
  history: Turn[]
  context?: DecideContext
  catalogue?: CatalogueEntry[]
  ctx: Omit<ToolContext, 'turn'>
}

export type AgentOutcome =
  | { kind: 'answer'; text: string; cited: ToolResult[]; results: ToolResult[]; steps: number }
  | { kind: 'clarify'; text: string; results: ToolResult[]; steps: number }
  | { kind: 'ungrounded'; text: string; missing: string[]; results: ToolResult[]; steps: number }
  | { kind: 'failed'; reason: string; results: ToolResult[]; steps: number }

/** What a model implementation must do: one step of the conversation with tools. */
export interface AgentModel {
  step(system: string, messages: Anthropic.MessageParam[], tools: Anthropic.Tool[]): Promise<Anthropic.Message>
}

export function makeAgentModel(cfg: Config): AgentModel {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey, baseURL: cfg.anthropicBaseUrl })
  return {
    step: (system, messages, tools) => client.messages.create({
      model: cfg.claudeModel, max_tokens: MAX_TOKENS, temperature: 0,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools, messages,
    }),
  }
}

/** Numbers in prose: 5,527 · 76 · 24.5% · 00:43:22. Ticket numbers, dates and list markers are not counted. */
export function numbersIn(text: string): string[] {
  const out: string[] = []
  const clean = text.replace(/\[(r\d+|page)\]/g, ' ')
  for (const line of clean.split('\n')) {
    const body = line.replace(/^\s*(\d{1,2}[.)]|[-*•])\s+/, ' ') // list markers
    for (const m of body.matchAll(/(?<![\w.:#/-])(\d[\d,]*(?:\.\d+)?)(?![\w:/-]|\.\d)/g)) {
      const raw = m[1]!
      // Years and four-digit codes inside dates are left to the date check; plain figures are kept.
      out.push(raw.replace(/,/g, ''))
    }
  }
  return [...new Set(out)]
}

/** Every numeric token a result contains, normalised the same way, so a quoted figure can be matched. */
export function numbersInResult(r: ToolResult): Set<string> {
  // A definition's description is prose, not evidence: a figure quoted from it is not grounded.
  // Seen live 2026-10-02: "96 of 625 servers" from one instance's meaning text, repeated on another instance.
  const { definition: _d, note: _n, ...evidence } = r.data as Record<string, unknown>
  const s = JSON.stringify(evidence)
  const set = new Set<string>()
  for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, '')
    set.add(raw)
    // "04" in a date or duration may be written as 4.
    set.add(raw.replace(/^0+(?=\d)/, ''))
    // "priorityIN2,3,4" in a filter is three values, not 234: each part is a figure the answer may quote.
    if (m[0].includes(',')) for (const part of m[0].split(',')) if (part) set.add(part.replace(/^0+(?=\d)/, ''))
    // "61.5%" may be written as 61.5 or 62; a rounded form of a result figure is accepted.
    if (raw.includes('.')) set.add(String(Math.round(Number(raw))))
  }
  return set
}

export function parseCited(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(r\d+|page)\]/g)].map((m) => m[1]!))]
}

/** Numbers in the answer that no cited result contains. Empty means grounded. */
export function ungrounded(text: string, cited: ToolResult[]): string[] {
  const allowed = new Set<string>()
  for (const r of cited) for (const n of numbersInResult(r)) allowed.add(n)
  return numbersIn(text).filter((n) => !allowed.has(n) && !allowed.has(n.replace(/\.0+$/, '')))
}

export function renderDefinitions(catalogue?: CatalogueEntry[]): string {
  if (!catalogue?.length) return '(none loaded)'
  return catalogue.map((d) => `${d.id} — ${d.name}${d.meaning ? `: ${d.meaning}` : ''}${d.available ? '' : ' [unavailable here]'}`).join('\n')
}

/** Tool results go back to the model as compact JSON under their id. */
function resultContent(r: ToolResult & { error?: string }): string {
  return JSON.stringify({ id: r.id, ...(r.error ? { error: r.error } : r.data), ...(r.url ? { verify_url: r.url } : {}) })
}

export async function runAgent(model: AgentModel, opts: AgentOptions): Promise<AgentOutcome> {
  const turn = makeTurn()
  const ctx: ToolContext = { ...opts.ctx, turn }
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const p = opts.ctx.params ?? {}
  const system = AGENT_SYSTEM
    .replace('{{TODAY}}', today).replace('{{TZ}}', p.time_zone || 'UTC')
    .replace(/\{\{OPEN_STATES\}\}/g, opts.ctx.openStates).replace('{{IN_PROGRESS}}', p.in_progress_states || 'unknown').replace('{{ON_HOLD}}', p.on_hold_states || 'unknown').replace('{{CLOSED}}', p.closed_states || 'unknown').replace('{{CANCELLED}}', p.cancelled_states || 'unknown')
    .replace('{{DEFINITIONS}}', renderDefinitions(opts.catalogue))
  // What the page had loaded is a result like any other, cited as [page], so a queue count quoted
  // from it passes the grounding check and is labelled as the page's rather than a live query.
  const facts = opts.context?.facts
  if (facts && (facts.queue || facts.ticket)) turn.results.push({ id: 'page', tool: 'page_facts', args: {}, data: facts as unknown as Record<string, unknown>, ms: 0 })
  const user = `${buildUserBlock(opts.context)}${facts ? 'The PAGE FACTS above may be cited as [page].\n\n' : ''}QUESTION\n${opts.question}`
  const messages: Anthropic.MessageParam[] = [...opts.history.map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: user }]
  const tools = toolSpecs() as Anthropic.Tool[]
  let steps = 0
  let groundingRetried = false

  for (;;) {
    let res: Anthropic.Message
    try { res = await model.step(system, messages, tools) }
    catch (e) { return { kind: 'failed', reason: `model call failed: ${e instanceof Error ? e.message : String(e)}`, results: turn.results, steps } }

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim()

    if (toolUses.length && steps < STEP_BUDGET) {
      messages.push({ role: 'assistant', content: res.content })
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const u of toolUses) {
        steps++
        const r = await executeTool(u.name, (u.input ?? {}) as Record<string, unknown>, ctx)
        results.push({ type: 'tool_result', tool_use_id: u.id, content: resultContent(r), ...(r.error ? { is_error: true } : {}) })
      }
      messages.push({ role: 'user', content: results })
      if (turn.clarify) return { kind: 'clarify', text: turn.clarify, results: turn.results, steps }
      continue
    }

    if (toolUses.length) {
      // Budget spent: the model asked for more. Ask it to conclude with what it has instead.
      messages.push({ role: 'assistant', content: res.content })
      messages.push({ role: 'user', content: toolUses.map((u) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: JSON.stringify({ error: 'step budget exhausted; answer now from the results you have, citing them, and say what you could not do' }), is_error: true })) })
      log('chat.budget_exhausted', { q: opts.question, steps })
      const final = await model.step(system, messages, tools).catch(() => null)
      const t = final?.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim() ?? ''
      return conclude(t || 'I ran out of steps before finding an answer.', turn.results, steps, opts.question)
    }

    // A final text. Check its grounding; one retry naming the ungrounded numbers.
    const out = conclude(text, turn.results, steps, opts.question)
    if (out.kind === 'ungrounded' && !groundingRetried) {
      groundingRetried = true
      log('chat.ungrounded_retry', { q: opts.question, missing: out.missing })
      messages.push({ role: 'assistant', content: text })
      messages.push({ role: 'user', content: `These figures are not in any tool result you cited: ${out.missing.join(', ')}. Rewrite the answer using only figures exactly as they appear in the results (dates and durations as written), each followed by its [rN] id, or run the tool that would produce them. Give the answer only; do not mention this correction.` })
      continue
    }
    return out
  }
}

function conclude(text: string, results: ToolResult[], steps: number, question: string): AgentOutcome {
  const ids = parseCited(text)
  const cited = ids.map((id) => results.find((r) => r.id === id)).filter((r): r is ToolResult => !!r && !('error' in r.data))
  const missing = ungrounded(text, cited)
  if (missing.length) return { kind: 'ungrounded', text, missing, results, steps }
  if (!text) return { kind: 'failed', reason: 'the model returned no text', results, steps }
  log('chat.agent', { q: question, steps, cited: ids, tools: results.map((r) => `${r.tool}${'error' in r.data ? '!' : ''}`) })
  return { kind: 'answer', text, cited, results, steps }
}

/** Sources for the response: articles from cited results, deduplicated. */
export function citedArticles(cited: ToolResult[]): Article[] {
  const seen = new Set<string>()
  const out: Article[] = []
  for (const r of cited) for (const a of r.articles ?? []) if (!seen.has(a.id)) { seen.add(a.id); out.push(a) }
  return out
}

/** The trace shown under an answer: one line per tool call. */
export function trace(results: ToolResult[]) {
  return results.map((r) => ({ id: r.id, tool: r.tool, args: r.args, ms: r.ms, url: r.url, error: 'error' in r.data ? String(r.data.error) : undefined, summary: summaryOf(r) }))
}
function summaryOf(r: ToolResult): string {
  const d = r.data
  if ('error' in d) return String(d.error)
  if ('count' in d) return `${String(d.count)} ${String(d.label ?? '')}`.trim()
  if ('value' in d) return `${String(d.value)} ${String(d.label ?? '')}`.trim()
  if ('total' in d && 'groups' in d) return `${String(d.total)} in ${String(d.groups_in_total)} groups`
  if ('total' in d) return `${String(d.total)} total, ${String(d.returned)} shown`
  if ('candidates' in d) return `${(d.candidates as unknown[]).length} match${(d.candidates as unknown[]).length === 1 ? '' : 'es'}, ${d.apply ? 'applied' : 'not applied'}`
  if ('articles' in d) return `${(d.articles as unknown[]).length} article${(d.articles as unknown[]).length === 1 ? '' : 's'}`
  if ('fields' in d) return `${String(d.field_count)} fields`
  if ('choices' in d) return `${(d.choices as unknown[]).length} choices`
  if ('ticket' in d) return String(d.number)
  if ('asked' in d) return 'asked the user'
  return 'ok'
}
