import express from 'express'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { loadConfig, type Config } from './config.js'
import type { Article } from './servicenow/types.js'
import { ServiceNowUnavailableError } from './servicenow/types.js'
import { makeSnClient } from './servicenow/client.js'
import { makeSearch } from './servicenow/search.js'
import { makeStats, type MetricRequest, type MetricResult } from './servicenow/stats.js'
import { hasEnoughTokens, tokenise } from './guard.js'
import {
  makeLlm, parseCitations, verifyCitations, stripCitationMarkup,
  type Turn, type Reply, type DecideOptions, type QuestionType, type PageFacts,
} from './llm/client.js'
import { makeDefinitions, isNoDataYet, type Kpis, type KpiMatch } from './definitions.js'
import { log } from './log.js'

const here = dirname(fileURLToPath(import.meta.url))

const MAX_MESSAGE_LENGTH = 2000
const UNAVAILABLE_TEXT = 'I cannot reach the knowledge base right now. Please try again shortly.'

/**
 * Decline wording follows what the model said the question was, not which lane a regex chose.
 * The gate reason is the page's key into its own explanation text.
 */
const DECLINES: Record<QuestionType, { gateReason: string; text: string }> = {
  knowledge: { gateReason: 'model_declined', text: 'I do not have that in the knowledge base.' },
  count: { gateReason: 'count_unmatched', text: 'No dashboard definition matches that number, and I will not guess a query for it.' },
  page: { gateReason: 'needs_page', text: 'That is answered from your queue or the open ticket. Open your queue in Resolve and ask again.' },
  other: { gateReason: 'out_of_scope', text: 'I can only answer from this instance: live counts from its dashboard definitions, or how-tos from its knowledge base.' },
}

interface Sn {
  search(query: string): Promise<Article[]>
  health(): Promise<{ ok: boolean; detail?: string }>
}

interface Stats {
  run(req: MetricRequest): Promise<MetricResult>
}

interface Llm {
  preflight(): Promise<void>
  decide(o: DecideOptions): Promise<Reply>
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
    const groups = Array.isArray(u.groups) ? (u.groups as Record<string, unknown>[]).filter((g) => typeof g?.id === 'string' && ID_RE.test(g.id as string) && typeof g?.name === 'string').slice(0, 20).map((g) => ({ id: g.id as string, name: String(g.name).slice(0, 80) })) : []
    out.user = { id: u.id, name: u.name.slice(0, 80), groups }
  }
  if (typeof r.page === 'string') out.page = r.page.slice(0, 40)
  if (typeof r.ticket === 'string' && /^[A-Z]{2,5}\d{5,10}$/.test(r.ticket)) out.ticket = r.ticket
  const facts = parseFacts(r.facts)
  if (facts) out.facts = facts
  return Object.keys(out).length ? out : undefined
}

/**
 * Relevance floor for knowledge search. The instance returns its nearest article however weak
 * the match, so an article reaches the model only if it shares a real word with the question.
 * The model is still told to decline when CONTEXT does not answer; this makes the empty case mechanical.
 */
export function relevant(question: string, articles: Article[]): Article[] {
  const terms = tokenise(question).filter((t) => t.length >= 4 && !STOP.has(t))
  if (!terms.length) return articles
  return articles.filter((a) => { const hay = `${a.title} ${a.body}`.toLowerCase(); return terms.some((t) => hay.includes(t)) })
}
const STOP = new Set(['what', 'when', 'where', 'which', 'this', 'that', 'there', 'with', 'from', 'have', 'does', 'many', 'much', 'about', 'please', 'tell', 'show', 'give', 'know', 'want', 'need', 'help', 'into', 'your', 'their', 'them', 'they', 'will', 'would', 'could', 'should'])

/** "5,513 open incidents" — or just the value when the model gave no label. */
function metricSentence(m: MetricResult): string {
  const value = typeof m.value === 'number' ? m.value.toLocaleString('en-US') : humanDuration(m.value)
  return m.label ? `${value} ${m.label}` : String(value)
}
/** ServiceNow durations arrive as "2 19:05:11" or "00:02:45"; read them as days, hours, minutes. */
export function humanDuration(v: string): string {
  const m = /^(?:(\d+) )?(\d{1,2}):(\d{2}):(\d{2})$/.exec(v.trim())
  if (!m) return v
  const d = Number(m[1] ?? 0), h = Number(m[2]), min = Number(m[3])
  const parts = [d ? `${d} d` : '', h ? `${h} h` : '', min || (!d && !h) ? `${min} min` : ''].filter(Boolean)
  return parts.join(' ')
}

export function makeApp(deps: { cfg: Config; sn: Sn; stats: Stats; llm: Llm; kpis?: Kpis; allowedTables?: () => Set<string> | null }) {
  const { cfg, sn, stats, llm, kpis, allowedTables } = deps
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
    const servicenow = await sn.health()
    res.json({
      ok: servicenow.ok,
      // Stub mode must be visible in the UI, not merely in a log file.
      model: cfg.llmMode === 'stub' ? 'STUB — no live model' : cfg.claudeModel,
      llmMode: cfg.llmMode,
      servicenow,
    })
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

      let articles: Article[] = []
      let retried = false
      let rewritten: string | null = null

      /** Declines log what the model saw, so a wrong "no" can be diagnosed from the log alone. */
      const decline = (gateReason: string, text: string, extra: Record<string, unknown> = {}) => {
        log('chat', { q: message, gate: gateReason, rewritten, candidates: articles.map((a) => a.label), retried, ms: Date.now() - started, ...extra })
        return res.json({ answer: text, kind: 'decline', sources: [], grounded: false, gateReason, retried, ...extra })
      }
      const declineAs = (about: QuestionType) => decline(DECLINES[about].gateReason, DECLINES[about].text)

      // Gate layer 1 — runs before any network call, so greeting noise never
      // reaches the instance or the model. The only free rejection there is.
      if (!hasEnoughTokens(message)) return decline('too_few_tokens', DECLINES.knowledge.text)

      const context = parseContext(req.body?.context)
      const history = conversations.get(conversationId) ?? []

      // Every question is searched: the model decides what kind it is, and a knowledge answer
      // needs the articles in the same call. For a count they are noise the prompt tells it to ignore.
      // With a ticket open, "how do I fix this?" says nothing the search can use, so the ticket's own
      // title is searched too and its results lead: they are the articles about the ticket.
      try {
        const title = context?.facts?.ticket?.title?.trim()
        const [own, byTitle] = await Promise.all([
          sn.search(message),
          title ? sn.search(title) : Promise.resolve([] as Article[]),
        ])
        const lead = title ? relevant(title, byTitle) : []
        const seen = new Set(lead.map((a) => a.id))
        articles = [...lead, ...relevant(message, own).filter((a) => !seen.has(a.id))]
      } catch (e) {
        if (!(e instanceof ServiceNowUnavailableError)) throw e
        log('chat.servicenow_unavailable', { q: message, detail: e.message })
        return res.status(503).json({
          answer: UNAVAILABLE_TEXT, kind: 'decline', sources: [], grounded: false,
          gateReason: 'servicenow_unavailable', retried: false,
        })
      }

      // Gate layer 2 — one call, five possible replies. The catalogue lets the model name a
      // dashboard definition instead of writing its own query (D-004).
      const catalogue = kpis?.catalogue()
      let reply = await llm.decide({ question: message, articles, history, context, catalogue })

      // D13: at most one rewrite, ever.
      if (reply.kind === 'search') {
        if (!cfg.retryEnabled) return declineAs('knowledge')

        retried = true
        rewritten = reply.query
        try {
          const second = relevant(rewritten, await sn.search(rewritten))
          // Union, deduped by sys_id. Rewritten results lead because they are the
          // better guess; nothing is truncated, or the first search — which usually
          // fills the limit on its own — would discard everything the rewrite found.
          const seen = new Set(second.map((a) => a.id))
          articles = [...second, ...articles.filter((a) => !seen.has(a.id))]
        } catch (e) {
          if (!(e instanceof ServiceNowUnavailableError)) throw e
          // Second search failed: decide again on what we already had.
          log('chat.retry_search_failed', { q: message, detail: e.message })
        }

        reply = await llm.decide({ question: message, articles, history, context, catalogue })
        // A second SEARCH is never honoured — no loops.
        if (reply.kind === 'search') reply = { kind: 'no_answer', about: 'knowledge' }
      }

      if (reply.kind === 'definition') {
        // The model chose; the server runs the tile's own query, so chatbot and dashboard agree.
        const kpi = kpis?.byId(reply.id) ?? null
        if (!kpi) {
          // An id that is not in the catalogue is a hallucination, declined as an unmatched count.
          log('chat.definition_unknown', { q: message, definition: reply.id })
          return declineAs('count')
        }
        const definition = { id: kpi.id, name: kpi.name, meaning: kpi.meaning }
        if (!kpi.request) {
          return decline('definition_unavailable', `"${kpi.name}" is defined, but it is not available on this instance: ${kpi.unavailable}.`, { definition })
        }
        let result: MetricResult
        try {
          if (kpi.ratio) {
            // A ratio is two counts. The value is the percentage; the filter shows both queries.
            const [n, d] = await Promise.all([stats.run(kpi.ratio.num), stats.run(kpi.ratio.den)])
            const nv = Number(n.value), dv = Number(d.value)
            result = { ...n, label: kpi.request.label, filter: `${n.filter || 'all'} ÷ ${d.filter || 'all'}`, value: dv > 0 && isFinite(nv) ? `${(100 * nv / dv).toFixed(1)}% (${nv.toLocaleString('en-US')} of ${dv.toLocaleString('en-US')})` : 'n/a, the denominator is 0' }
          } else result = await stats.run(kpi.request)
        } catch (e) {
          log('chat.definition_failed', { q: message, definition: kpi.id, detail: e instanceof Error ? e.message : String(e) })
          return decline('metric_unavailable', DECLINES.count.text, { definition })
        }
        // The tile says "no data yet" for this; the chatbot says the same rather than reading out a zero.
        if (isNoDataYet(kpi, result.value)) {
          return decline('definition_no_data', `"${kpi.name}" is defined and its table exists here, but nothing is recorded for it on this instance yet: ${kpi.meaning}.`, { definition, metric: result })
        }
        const answer = metricSentence(result)
        log('chat', { q: message, gate: 'definition', definition: kpi.id, value: result.value, retried, ms: Date.now() - started })
        // The id goes into history so "and for P2" can reuse the tile rather than compose a fresh filter.
        remember(conversationId, history, message, `${answer} (definition ${kpi.id}: ${result.table} · ${result.filter || 'no filter'})`)
        return res.json({ answer, kind: 'metric', sources: [], metric: result, definition, grounded: true, gateReason: null, retried })
      }

      if (reply.kind === 'metric') {
        // A table the instance scan did not find is a guess, not a query. Declined before it runs.
        const allowed = allowedTables?.()
        if (allowed && !allowed.has(reply.request.table)) {
          log('chat.metric_table_rejected', { q: message, table: reply.request.table })
          return decline('metric_unavailable', DECLINES.count.text)
        }
        // A composed query on a table a definition already covers may be a prompt failure: the
        // model wrote its own filter where the tile's would do. Logged, still run — "opened this
        // month" is legitimately composed on the incident table. The routing eval watches the rate.
        if (kpis?.coversTable(reply.request.table)) {
          log('chat.metric_overlaps_definition', { q: message, table: reply.request.table, filter: reply.request.filter })
        }
        let result: MetricResult
        try {
          result = await stats.run(reply.request)
        } catch (e) {
          // No repair attempt: a second guess is a second chance to be wrong.
          log('chat.metric_failed', {
            q: message, table: reply.request.table, filter: reply.request.filter,
            detail: e instanceof Error ? e.message : String(e),
          })
          return decline('metric_unavailable', DECLINES.count.text)
        }

        log('chat', {
          q: message, gate: 'metric', table: result.table, filter: result.filter,
          aggregate: result.aggregate, field: result.field, value: result.value,
          retried, ms: Date.now() - started,
        })

        const answer = metricSentence(result)
        // The filter goes into history too, so "and how many of those are P1?" can build on it.
        remember(conversationId, history, message, `${answer} (${result.table} · ${result.filter || 'no filter'})`)

        return res.json({
          answer,
          kind: 'metric',
          sources: [],
          metric: result,
          grounded: true,
          gateReason: null,
          retried,
        })
      }

      if (reply.kind === 'page') {
        // A page answer with no page facts to draw on is invented. Declined as a page question.
        if (!context?.facts) {
          log('chat.page_without_facts', { q: message })
          return declineAs('page')
        }
        // Answered from what the page had loaded. Labelled as the page's, never as a live query.
        const loadedAt = context.facts.loadedAt ?? null
        log('chat', { q: message, gate: 'page', ticket: context?.ticket ?? null, loadedAt, retried, ms: Date.now() - started })
        remember(conversationId, history, message, `${reply.text} (from the user's page)`)
        return res.json({ answer: reply.text, kind: 'page', sources: [], grounded: true, gateReason: null, retried, loadedAt })
      }

      // The decline is worded for the kind of question the model said it was.
      if (reply.kind !== 'answer') return declineAs(reply.about)

      const { sources, fabricated } = verifyCitations(parseCitations(reply.text), articles)
      if (fabricated.length) log('chat.fabricated_citation', { q: message, labels: fabricated })

      remember(conversationId, history, message, reply.text)

      log('chat', {
        q: message, rewritten, candidates: articles.map((a) => a.label), gate: 'answered',
        cited: sources.map((s) => s.label), retried, ms: Date.now() - started,
      })

      res.json({
        answer: stripCitationMarkup(reply.text),
        kind: 'article',
        sources: sources.map((s) => ({ id: s.id, label: s.label, title: s.title, url: s.url })),
        grounded: true,
        gateReason: null,
        retried,
      })
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

  if (cfg.llmMode === 'stub') {
    console.warn('\n*** LLM_MODE=stub — answers are canned, no model is being called ***\n')
  }

  const llm = makeLlm(cfg)
  await llm.preflight() // fails the boot on a bad model id or key (no-op in stub mode)

  const client = makeSnClient(cfg) // one token cache, one timeout, shared by search and stats
  const sn = makeSearch(client)
  const stats = makeStats(client)
  const health = await sn.health()
  if (!health.ok) throw new Error(`ServiceNow is not reachable: ${health.detail}`)
  log('servicenow.ok', { detail: health.detail })

  // The same definitions table the dashboard uses. The standalone server has no instance scan, so
  // tables are assumed present, open states come from OPEN_STATES, and definitions that need a
  // matched SLA record read as unavailable with that reason.
  const kpis = makeDefinitions(() => ({ params: { open_states: cfg.openStates }, tables: null, confirmed: false }))
  log('definitions.loaded', { available: kpis.rows().filter((r) => r.status === 'available').length, total: kpis.rows().length, openStates: cfg.openStates })

  makeApp({ cfg, sn, stats, llm, kpis }).listen(cfg.port, () => {
    log('listening', { port: cfg.port, model: cfg.claudeModel })
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
