import express from 'express'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { loadConfig, type Config } from './config.js'
import { makeSnClient, type SnClient } from './servicenow/client.js'
import { makeSearch } from './servicenow/search.js'
import { hasEnoughTokens } from './guard.js'
import { makeLlm, type Turn, type PageFacts } from './llm/client.js'
import { makeDefinitions, type Kpis, type KpiMatch } from './definitions.js'
import { log } from './log.js'
import { runAgent, makeAgentModel, citedArticles, trace, type AgentModel } from './llm/agent.js'

const here = dirname(fileURLToPath(import.meta.url))

const MAX_MESSAGE_LENGTH = 2000
const TOO_FEW_TEXT = 'A word or two is not enough to go on. Ask a full question.'

interface Health {
  health(): Promise<{ ok: boolean; detail?: string }>
}

/** Who is asking and what they are looking at. Sent by the page; never trusted for authorisation. */
export interface ChatContext {
  user?: { id: string; name: string; groups: { id: string; name: string }[] }
  page?: string
  ticket?: string
  /** What the Resolve page has loaded. Shape-checked and clamped; answers from it are labelled as the page's. */
  facts?: PageFacts
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined)
const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : 0)
const list = <T,>(v: unknown, max: number, map: (x: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(v) ? (v as unknown[]).slice(0, max).map((x) => (x && typeof x === 'object' ? map(x as Record<string, unknown>) : null)).filter((x): x is T => x !== null) : []

/** Only the shape we read from the page's facts; every string clamped, every list capped. */
export function parseFacts(raw: unknown): PageFacts | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: PageFacts = {}
  const q = r.queue as Record<string, unknown> | undefined
  if (q && typeof q === 'object') {
    const first = q.first as Record<string, unknown> | undefined
    out.queue = {
      assigned_to_me: num(q.assigned_to_me), unassigned_in_my_groups: num(q.unassigned_in_my_groups), waiting_on_my_reply: num(q.waiting_on_my_reply),
      reopened: num(q.reopened), changed_last_4h: num(q.changed_last_4h), sla_breached_or_breaching_2h: num(q.sla_breached_or_breaching_2h),
      ...(first && str(first.number) ? { first: { number: str(first.number, 20)!, title: str(first.title, 120) ?? '', why: str(first.why, 300) } } : {}),
    }
  }
  const t = r.ticket as Record<string, unknown> | undefined
  if (t && typeof t === 'object' && str(t.number)) {
    out.ticket = {
      number: str(t.number, 20)!, title: str(t.title, 160) ?? '', state: str(t.state, 40), priority: str(t.priority, 40), group: str(t.group, 80),
      assigned_to: str(t.assigned_to, 80), caller: str(t.caller, 80), opened_at: str(t.opened_at, 40),
      slas: list(t.slas, 6, (s) => (str(s.name) ? { name: str(s.name, 80)!, breached: s.breached === true, pct: num(s.pct), breach_time: str(s.breach_time, 40) } : null)),
      similar: list(t.similar, 4, (s) => (str(s.number) ? { number: str(s.number, 20)!, resolved_at: str(s.resolved_at, 40), resolved_by: str(s.resolved_by, 80), close_notes: str(s.close_notes, 240) ?? '' } : null)),
      same_title: Array.isArray(t.same_title) ? (t.same_title as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10).map((x) => x.slice(0, 20)) : [],
      articles: list(t.articles, 4, (a) => (str(a.number) ? { number: str(a.number, 20)!, title: str(a.title, 120) ?? '' } : null)),
    }
  }
  if (!out.queue && !out.ticket) return undefined
  out.loadedAt = str(r.loadedAt, 40)
  return out
}

export type { Kpis, KpiMatch }

const ID_RE = /^[a-f0-9]{32}$/

/** Only the shape we read; anything else on the object is dropped. */
export function parseContext(raw: unknown): ChatContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: ChatContext = {}
  const u = r.user as Record<string, unknown> | undefined
  if (u && typeof u.id === 'string' && ID_RE.test(u.id) && typeof u.name === 'string') {
    const groups = Array.isArray(u.groups) ? (u.groups as Record<string, unknown>[]).filter((g) => typeof g?.id === 'string' && ID_RE.test(g.id as string) && typeof g?.name === 'string').slice(0, 20).map((g) => ({ id: g.id as string, name: (g.name as string).slice(0, 80) })) : []
    out.user = { id: u.id, name: u.name.slice(0, 80), groups }
  }
  if (typeof r.page === 'string') out.page = r.page.slice(0, 40)
  if (typeof r.ticket === 'string' && /^[A-Z]{2,5}\d{5,10}$/.test(r.ticket)) out.ticket = r.ticket
  const facts = parseFacts(r.facts)
  if (facts) out.facts = facts
  return Object.keys(out).length ? out : undefined
}

// The relevance floor lives in its own module so the tools can use it without importing the server.
import { relevant } from './relevance.js'
export { relevant }

/**
 * The chat server (rev 10, 2026-10-02). One route: the question goes to the model with read-only
 * tools; every number in the answer is cited to a tool result that contains it, or the answer is
 * not shown. The dashboard definitions are shared with the dashboard, so the two cannot disagree.
 */
export function makeApp(deps: { cfg: Config; sn: Health; kpis?: Kpis; allowedTables?: () => Set<string> | null; agent: AgentModel; snClient: SnClient; llm?: Health }) {
  const { cfg, sn, kpis, allowedTables, agent, snClient, llm } = deps
  // The model's reachability, checked at most once a minute: health must say when chat is down
  // while the dashboard and Resolve, which do not need the model, carry on.
  let llmStatus: { at: number; value: { ok: boolean; detail?: string } } | null = null
  async function modelHealth() {
    if (!llm) return { ok: true, detail: 'not checked' }
    if (llmStatus && Date.now() - llmStatus.at < 60_000) return llmStatus.value
    const value = await llm.health()
    llmStatus = { at: Date.now(), value }
    return value
  }
  // ponytail: grows one entry per conversationId for the process lifetime. Fine for a
  // proof on one laptop; add eviction when this runs as a shared service.
  const conversations = new Map<string, Turn[]>()
  const app = express()

  function remember(conversationId: string, history: Turn[], question: string, answer: string) {
    const turns: Turn[] = [...history, { role: 'user', content: question }, { role: 'assistant', content: answer }]
    conversations.set(conversationId, turns.slice(-12))
  }

  app.use(express.json({ limit: '64kb' }))

  app.get('/api/health', async (_req, res) => {
    const [servicenow, model] = await Promise.all([sn.health(), modelHealth()])
    // ok means the instance answers: the dashboard and Resolve work. llm.ok means chat works too.
    res.json({ ok: servicenow.ok, model: cfg.claudeModel, servicenow, llm: model })
  })

  app.post('/api/chat', async (req, res, next) => {
    const started = Date.now()
    try {
      const message = String(req.body?.message ?? '').trim()
      const conversationId = String(req.body?.conversationId ?? 'default')

      if (!message) return res.status(400).json({ error: 'message is required' })
      if (message.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `message exceeds ${MAX_MESSAGE_LENGTH} characters` })
      }

      // The one free rejection: greeting-shaped noise never reaches the instance or the model.
      if (!hasEnoughTokens(message)) {
        log('chat', { q: message, gate: 'too_few_tokens', ms: Date.now() - started })
        return res.json({ answer: TOO_FEW_TEXT, kind: 'decline', sources: [], grounded: false, gateReason: 'too_few_tokens', trace: [] })
      }

      const context = parseContext(req.body?.context)
      const history = conversations.get(conversationId) ?? []

      const out = await runAgent(agent, {
        question: message, history, context, catalogue: kpis?.catalogue(),
        ctx: { sn: snClient, kpis, scanned: allowedTables?.() ?? null, openStates: kpis?.params().open_states || cfg.openStates, params: kpis?.params(), user: context?.user, facts: context?.facts },
      })
      const steps = trace(out.results)
      const ms = Date.now() - started

      if (out.kind === 'clarify') {
        log('chat', { q: message, gate: 'clarify', steps: out.steps, ms })
        remember(conversationId, history, message, `(asked the user) ${out.text}`)
        return res.json({ answer: out.text, kind: 'clarify', sources: [], grounded: true, gateReason: null, trace: steps })
      }
      if (out.kind === 'ungrounded') {
        log('chat', { q: message, gate: 'ungrounded', missing: out.missing, steps: out.steps, ms, text: out.text.slice(0, 200) })
        return res.json({ answer: 'I could not ground every figure in this answer in a query result, so I am not showing it. Try asking for the number on its own.', kind: 'decline', sources: [], grounded: false, gateReason: 'ungrounded', trace: steps })
      }
      if (out.kind === 'failed') {
        log('chat', { q: message, gate: 'agent_failed', reason: out.reason, steps: out.steps, ms })
        return res.status(502).json({ answer: 'The chat service could not complete this question.', kind: 'decline', sources: [], grounded: false, gateReason: 'agent_failed', trace: steps })
      }

      // Citations go; so does any echo of the history note the server writes ("(tools used: ...)"),
      // which the model copied into one live answer on 2026-10-02.
      const text = out.text.replace(/\s*\[(r\d+|page)\]/g, '').replace(/\s*\(tools used:[^)]*\)\s*$/i, '').replace(/[ \t]{2,}/g, ' ').trim()
      const sources = citedArticles(out.cited).map((a) => ({ id: a.id, label: a.label, title: a.title, url: a.url }))
      // One cited number from a definition or a count renders as the metric card the page already has.
      const numeric = out.cited.filter((r) => (r.tool === 'run_definition' || r.tool === 'count') && ('value' in r.data || 'count' in r.data))
      const single = numeric.length === 1 && out.cited.length === 1 ? numeric[0]! : null
      const grounded = out.cited.length > 0
      log('chat', { q: message, gate: grounded ? 'agent' : 'agent_no_citation', steps: out.steps, cited: out.cited.map((r) => r.id), ms })
      // The tools used go into history so a follow-up ("and for Hardware") knows what ran. The prompt tells the model never to echo it.
      remember(conversationId, history, message, `${out.text}\n(tools used: ${out.results.map((r) => `${r.tool} ${JSON.stringify(r.args)}`).join('; ')})`)
      if (single) {
        const d = single.data as Record<string, unknown>
        const metric = { table: String(d.table ?? ''), filter: String(d.filter ?? ''), aggregate: String(d.aggregate ?? 'count'), field: d.field as string | undefined, value: (d.value ?? d.count) as number | string, label: String(d.label ?? ''), url: single.url ?? '' }
        const definition = d.definition as { id: string; name: string; meaning: string } | undefined
        return res.json({ answer: text, kind: 'metric', sources, metric, definition, grounded: true, gateReason: null, trace: steps })
      }
      return res.json({ answer: text, kind: grounded ? 'article' : 'decline', sources, grounded, gateReason: grounded ? null : 'model_declined', trace: steps, verify: out.cited.map((r) => r.url).filter(Boolean) })
    } catch (e) {
      next(e)
    }
  })

  app.use(express.static(join(here, '../public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }))

  app.use((err: Error & { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // body-parser's own error for unparseable JSON: the client's fault, not ours.
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'body must be JSON' })
    log('error.unhandled', { message: err.message })
    res.status(500).json({ error: 'internal error' })
  })

  return app
}

async function main() {
  const cfg = loadConfig()

  // The model is checked, not required: without it the instance is still served and chat says
  // it is down, in health and in every reply, rather than the whole server refusing to start.
  const llm = makeLlm(cfg)
  const model = await llm.health()
  if (!model.ok) log('llm.unreachable', { detail: model.detail })

  const client = makeSnClient(cfg) // one token cache, one timeout, shared by every tool
  const sn = makeSearch(client)
  const health = await sn.health()
  if (!health.ok) throw new Error(`ServiceNow is not reachable: ${health.detail}`)
  log('servicenow.ok', { detail: health.detail })

  // The same definitions table the dashboard uses. The standalone server has no instance scan, so
  // tables are assumed present, open states come from OPEN_STATES, and definitions that need a
  // matched SLA record read as unavailable with that reason.
  // ServiceNow's shipped state values, since this server has no scan to read the instance's own. The app's scan
  // classifies every state by its label and overrides all of these (D-011).
  const kpis = makeDefinitions(() => ({ params: { open_states: cfg.openStates, in_progress_states: '2', on_hold_states: '3', closed_states: '6,7', cancelled_states: '8', time_zone: 'UTC', automation_accounts: '' }, tables: null, confirmed: false }))
  log('definitions.loaded', { available: kpis.rows().filter((r) => r.status === 'available').length, total: kpis.rows().length, openStates: cfg.openStates })

  makeApp({ cfg, sn, kpis, agent: makeAgentModel(cfg), snClient: client, llm }).listen(cfg.port, () => {
    log('listening', { port: cfg.port, model: cfg.claudeModel, modelReachable: model.ok })
  })
}

// Only boot when run directly, so tests can import makeApp without starting a server.
// pathToFileURL handles the Windows form (file:///C:/...) that a hand-built string does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\nSTARTUP FAILED\n${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
}
