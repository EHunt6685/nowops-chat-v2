import express from 'express'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { loadConfig, type Config } from './config.js'
import type { Article } from './servicenow/types.js'
import { ServiceNowUnavailableError } from './servicenow/types.js'
import { makeSnClient } from './servicenow/client.js'
import { makeSearch } from './servicenow/search.js'
import { makeStats, type MetricRequest, type MetricResult } from './servicenow/stats.js'
import { hasEnoughTokens } from './guard.js'
import {
  makeLlm, parseCitations, verifyCitations, stripCitationMarkup,
  type Turn, type Reply,
} from './llm/client.js'
import { log } from './log.js'

const here = dirname(fileURLToPath(import.meta.url))

const MAX_MESSAGE_LENGTH = 2000
const DECLINE_TEXT = 'I do not have that in the knowledge base.'
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
  decide(o: { question: string; articles: Article[]; history: Turn[] }): Promise<Reply>
}

/** "5,513 open incidents" — or just the value when the model gave no label. */
function metricSentence(m: MetricResult): string {
  const value = typeof m.value === 'number' ? m.value.toLocaleString('en-US') : m.value
  return m.label ? `${value} ${m.label}` : String(value)
}

export function makeApp(deps: { cfg: Config; sn: Sn; stats: Stats; llm: Llm }) {
  const { cfg, sn, stats, llm } = deps
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
          answer: DECLINE_TEXT, kind: 'decline', sources: [], grounded: false, gateReason, retried,
        })
      }

      // Gate layer 1 — runs before any network call, so greeting noise never
      // reaches the instance or the model. The only free rejection there is.
      if (!hasEnoughTokens(message)) return decline('too_few_tokens')

      let articles: Article[]
      try {
        articles = await sn.search(message)
      } catch (e) {
        if (!(e instanceof ServiceNowUnavailableError)) throw e
        log('chat.servicenow_unavailable', { q: message, detail: e.message })
        return res.status(503).json({
          answer: UNAVAILABLE_TEXT, kind: 'decline', sources: [], grounded: false,
          gateReason: 'servicenow_unavailable', retried: false,
        })
      }

      const history = conversations.get(conversationId) ?? []

      // Gate layer 2 — one call, four possible replies (D16).
      let reply = await llm.decide({ question: message, articles, history })
      let retried = false
      let rewritten: string | null = null

      // D13: at most one rewrite, ever.
      if (reply.kind === 'search') {
        if (!cfg.retryEnabled) return decline('model_declined')

        retried = true
        rewritten = reply.query
        try {
          const second = await sn.search(rewritten)
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

        reply = await llm.decide({ question: message, articles, history })
        // A second SEARCH is never honoured — no loops.
        if (reply.kind === 'search') reply = { kind: 'no_answer' }
      }

      if (reply.kind === 'metric') {
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

      if (reply.kind !== 'answer') return decline('model_declined', retried)

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

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
