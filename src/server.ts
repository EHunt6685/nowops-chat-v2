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
  type Turn, type Reply,
} from './llm/client.js'
import { log } from './log.js'

const here = dirname(fileURLToPath(import.meta.url))

const MAX_MESSAGE_LENGTH = 2000
const DECLINE_TEXT = 'I do not have that in the knowledge base.'
const COUNT_DECLINE_TEXT = 'No dashboard definition matches that number, and I will not guess a query for it.'
const UNAVAILABLE_TEXT = 'I cannot reach the knowledge base right now. Please try again shortly.'

interface Sn {
  search(query: string): Promise<Article[]>
  health(): Promise<{ ok: boolean; detail?: string }>
}

interface Stats {
  run(req: MetricRequest): Promise<MetricResult>
}

interface Llm {
  preflight(): Promise<void>
  decide(o: { question: string; articles: Article[]; history: Turn[]; context?: ChatContext }): Promise<Reply>
}

/** Who is asking and what they are looking at. Sent by the page; never trusted for authorisation. */
export interface ChatContext {
  user?: { id: string; name: string; groups: { id: string; name: string }[] }
  page?: string
  ticket?: string
}

/** A NowOps definition matched to a counting question: the same query the dashboard tile runs (D-004). */
export type KpiMatch =
  | { id: string; name: string; meaning: string; request: MetricRequest; ratio?: { num: MetricRequest; den: MetricRequest }; unavailable?: undefined }
  | { id: string; name: string; meaning: string; unavailable: string; request?: undefined; ratio?: undefined }
export interface Kpis { match(question: string): KpiMatch | null }

const COUNT_RE = /\b(how many|how much|count|number of|total|what is (our|the)|what's (our|the)|show me the number)\b/i
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

      const decline = (gateReason: string, retried = false) => {
        log('chat', { q: message, gate: gateReason, retried, ms: Date.now() - started })
        return res.json({
          answer: gateReason === 'count_unmatched' ? COUNT_DECLINE_TEXT : DECLINE_TEXT, kind: 'decline', sources: [], grounded: false, gateReason, retried,
        })
      }

      // Gate layer 1 — runs before any network call, so greeting noise never
      // reaches the instance or the model. The only free rejection there is.
      if (!hasEnoughTokens(message)) return decline('too_few_tokens')

      const context = parseContext(req.body?.context)
      const counting = COUNT_RE.test(message)
      const history = conversations.get(conversationId) ?? []

      // Definitions first (D-004): a counting question that names a NowOps KPI runs the tile's own
      // query, so the chatbot and the dashboard can never disagree on "open". No model call.
      const kpi = counting && kpis ? kpis.match(message) : null
      if (kpi?.unavailable) {
        log('chat', { q: message, gate: 'definition_unavailable', definition: kpi.id, reason: kpi.unavailable, ms: Date.now() - started })
        return res.json({ answer: `"${kpi.name}" is defined, but it is not available on this instance: ${kpi.unavailable}.`, kind: 'decline', sources: [], grounded: false, gateReason: 'definition_unavailable', retried: false, definition: { id: kpi.id, name: kpi.name, meaning: kpi.meaning } })
      }
      if (kpi?.request) {
        try {
          let result: MetricResult
          if (kpi.ratio) {
            // A ratio is two counts. The value is the percentage; the filter shows both queries.
            const [n, d] = await Promise.all([stats.run(kpi.ratio.num), stats.run(kpi.ratio.den)])
            const nv = Number(n.value), dv = Number(d.value)
            result = { ...n, label: kpi.request.label, filter: `${n.filter || 'all'} ÷ ${d.filter || 'all'}`, value: dv > 0 && isFinite(nv) ? `${(100 * nv / dv).toFixed(1)}% (${nv.toLocaleString('en-US')} of ${dv.toLocaleString('en-US')})` : 'n/a, the denominator is 0' }
          } else result = await stats.run(kpi.request)
          const answer = metricSentence(result)
          log('chat', { q: message, gate: 'definition', definition: kpi.id, value: result.value, ms: Date.now() - started })
          remember(conversationId, history, message, `${answer} (${result.table} · ${result.filter || 'no filter'})`)
          return res.json({ answer, kind: 'metric', sources: [], metric: result, definition: { id: kpi.id, name: kpi.name, meaning: kpi.meaning }, grounded: true, gateReason: null, retried: false })
        } catch (e) {
          log('chat.definition_failed', { q: message, definition: kpi.id, detail: e instanceof Error ? e.message : String(e) })
          // fall through: the model may still answer
        }
      }

      // A counting question needs no articles; the search is skipped and the model sees an empty CONTEXT.
      let articles: Article[] = []
      if (!counting) {
        try {
          articles = relevant(message, await sn.search(message))
        } catch (e) {
          if (!(e instanceof ServiceNowUnavailableError)) throw e
          log('chat.servicenow_unavailable', { q: message, detail: e.message })
          return res.status(503).json({
            answer: UNAVAILABLE_TEXT, kind: 'decline', sources: [], grounded: false,
            gateReason: 'servicenow_unavailable', retried: false,
          })
        }
      }

      // Gate layer 2 — one call, four possible replies (D16).
      let reply = await llm.decide({ question: message, articles, history, context })
      let retried = false
      let rewritten: string | null = null

      // D13: at most one rewrite, ever.
      if (reply.kind === 'search') {
        if (!cfg.retryEnabled) return decline('model_declined')

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

        reply = await llm.decide({ question: message, articles, history, context })
        // A second SEARCH is never honoured — no loops.
        if (reply.kind === 'search') reply = { kind: 'no_answer' }
      }

      if (reply.kind === 'metric') {
        // A table the instance scan did not find is a guess, not a query. Declined before it runs.
        const allowed = allowedTables?.()
        if (allowed && !allowed.has(reply.request.table)) {
          log('chat.metric_table_rejected', { q: message, table: reply.request.table })
          return decline('metric_unavailable', retried)
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
          return decline('metric_unavailable', retried)
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

      // A count nobody could produce is not a knowledge-base miss; the page words the decline accordingly.
      if (reply.kind !== 'answer') return decline(counting ? 'count_unmatched' : 'model_declined', retried)

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

  app.use(express.static(join(here, '../public')))

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

  makeApp({ cfg, sn, stats, llm }).listen(cfg.port, () => {
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
