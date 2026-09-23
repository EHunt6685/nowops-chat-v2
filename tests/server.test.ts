import { describe, it, expect, vi } from 'vitest'
import { makeApp } from '../src/server.js'
import { parseConfig, type Config } from '../src/config.js'
import type { Article } from '../src/servicenow/types.js'
import { ServiceNowUnavailableError } from '../src/servicenow/types.js'
import type { Reply } from '../src/llm/client.js'

const cfg: Config = parseConfig({
  ANTHROPIC_API_KEY: 'sk-test-key-1234567890',
  ANTHROPIC_BASE_URL: 'https://llmproxy.example.com',
  CLAUDE_MODEL: 'm',
  SN_INSTANCE_URL: 'https://sn.example.com',
  SN_CLIENT_ID: 'cid',
  SN_CLIENT_SECRET: 'csecret',
  SN_REFRESH_TOKEN: 'rtoken',
})

const article = (id: string, title: string): Article =>
  ({ id, title, body: 'body text', url: `https://sn/${id}`, label: `KB${id}` })

const okSn = (articles: Article[] = [article('a', 'Reset SAP password')]) => ({
  search: async () => articles,
  health: async () => ({ ok: true, detail: 'reachable' }),
})

const noStats = { run: vi.fn() }

/** Minimal HTTP driver so the tests need no supertest dependency. */
async function post(app: ReturnType<typeof makeApp>, body: unknown) {
  const server = app.listen(0)
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  } finally {
    server.close()
  }
}

function fakeLlm(reply: () => Reply) {
  return { preflight: async () => {}, decide: async () => reply() }
}

describe('POST /api/chat', () => {
  it('rejects an empty message', async () => {
    const app = makeApp({ cfg, sn: okSn(), stats: noStats, llm: fakeLlm(() => ({ kind: 'no_answer' })) })
    const r = await post(app, { message: '' })
    expect(r.status).toBe(400)
  })

  it('rejects a malformed JSON body with 400, not 500', async () => {
    const app = makeApp({ cfg, sn: okSn(), stats: noStats, llm: fakeLlm(() => ({ kind: 'no_answer' })) })
    const server = app.listen(0)
    const port = (server.address() as { port: number }).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
      })
      expect(res.status).toBe(400)
    } finally { server.close() }
  })

  it('declines greeting noise without searching or calling the model', async () => {
    const search = vi.fn()
    const decide = vi.fn()
    const app = makeApp({
      cfg,
      sn: { search, health: async () => ({ ok: true }) },
      stats: noStats,
      llm: { preflight: async () => {}, decide },
    })
    const r = await post(app, { message: 'Hi Team,' })
    expect(r.body.gateReason).toBe('too_few_tokens')
    expect(search).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
  })

  it('answers from articles and returns verified sources', async () => {
    const app = makeApp({
      cfg,
      sn: okSn(),
      stats: noStats,
      llm: fakeLlm(() => ({ kind: 'answer', text: 'Use the portal [1].' })),
    })
    const r = await post(app, { message: 'how do I reset my SAP password' })
    expect(r.body.kind).toBe('article')
    expect(r.body.grounded).toBe(true)
    expect(r.body.answer).toBe('Use the portal.')
    expect((r.body.sources as unknown[]).length).toBe(1)
  })

  it('drops a fabricated citation rather than linking it', async () => {
    const app = makeApp({
      cfg,
      sn: okSn(),
      stats: noStats,
      llm: fakeLlm(() => ({ kind: 'answer', text: 'See [1] and [9].' })),
    })
    const r = await post(app, { message: 'how do I reset my SAP password' })
    expect((r.body.sources as unknown[]).length).toBe(1)
  })

  it('runs a metric and returns a sentence, the value, filter and link', async () => {
    const run = vi.fn(async () => ({
      table: 'incident', filter: 'active=true', aggregate: 'count' as const, label: 'open incidents',
      value: 5513, url: 'https://sn.example.com/incident_list.do?sysparm_query=active%3Dtrue',
    }))
    const app = makeApp({
      cfg,
      sn: okSn(),
      stats: { run },
      llm: fakeLlm(() => ({
        kind: 'metric',
        request: { table: 'incident', filter: 'active=true', aggregate: 'count', label: 'open incidents' },
      })),
    })
    const r = await post(app, { message: 'how many open incidents are there' })
    expect(r.body.kind).toBe('metric')
    expect(r.body.answer).toBe('5,513 open incidents')
    const m = r.body.metric as Record<string, unknown>
    expect(m.value).toBe(5513)
    expect(m.filter).toBe('active=true')
    expect(String(m.url)).toContain('incident_list.do')
  })

  it('remembers a metric turn so a follow-up has context', async () => {
    const decide = vi.fn()
      .mockResolvedValueOnce({
        kind: 'metric',
        request: { table: 'incident', filter: 'active=true', aggregate: 'count', label: 'open incidents' },
      })
      .mockResolvedValueOnce({ kind: 'no_answer' })
    const run = vi.fn(async () => ({
      table: 'incident', filter: 'active=true', aggregate: 'count' as const, value: 5513, url: 'u',
    }))
    const app = makeApp({ cfg, sn: okSn(), stats: { run }, llm: { preflight: async () => {}, decide } })
    await post(app, { message: 'how many open incidents are there', conversationId: 'c1' })
    // "P1" is two characters and "many" is a stopword — this wording keeps two real tokens
    // so the guard lets it through and the model actually sees the history.
    await post(app, { message: 'and how many of those incidents are priority one', conversationId: 'c1' })
    const second = decide.mock.calls[1]?.[0] as { history: { role: string; content: string }[] }
    expect(second.history).toHaveLength(2)
    expect(second.history[1]?.content).toContain('active=true')
  })

  it('answers a counting question from a NowOps definition before asking the model', async () => {
    const decide = vi.fn()
    const search = vi.fn(async () => [])
    const run = vi.fn(async (_r: unknown) => ({ table: 'incident', filter: 'stateIN1,2,3', aggregate: 'count' as const, label: 'open tickets', value: 5403, url: 'u' }))
    const app = makeApp({
      cfg, sn: { search, health: async () => ({ ok: true }) }, stats: { run }, llm: { preflight: async () => {}, decide },
      kpis: { match: (q) => /open/.test(q) ? { id: 'open_incidents', name: 'Open Tickets', meaning: 'the client\'s open states', request: { table: 'incident', filter: 'stateIN1,2,3', aggregate: 'count', label: 'open tickets' } } : null },
    })
    const r = await post(app, { message: 'how many open incidents do we have' })
    expect(r.body.kind).toBe('metric')
    expect((r.body.definition as { id: string }).id).toBe('open_incidents')
    expect(run.mock.calls[0]?.[0]).toMatchObject({ filter: 'stateIN1,2,3' })
    expect(decide).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
  })

  it('skips the knowledge search for a counting question and passes who is asking to the model', async () => {
    const decide = vi.fn(async (_o: unknown) => ({ kind: 'no_answer' as const }))
    const search = vi.fn(async () => [])
    const app = makeApp({ cfg, sn: { search, health: async () => ({ ok: true }) }, stats: noStats, llm: { preflight: async () => {}, decide } })
    const ctx = { user: { id: 'a'.repeat(32), name: 'David Dan', groups: [{ id: 'b'.repeat(32), name: 'Network' }] }, page: 'queue', junk: 'ignored' }
    await post(app, { message: 'how many tickets are assigned to me', context: ctx })
    expect(search).not.toHaveBeenCalled()
    const seen = decide.mock.calls[0]?.[0] as unknown as { context?: { user?: { id: string }; page?: string } }
    expect(seen.context?.user?.id).toBe('a'.repeat(32))
    expect(seen.context?.page).toBe('queue')
    expect('junk' in (seen.context ?? {})).toBe(false)
  })

  it('drops articles that share no real word with the question', async () => {
    const decide = vi.fn(async (_o: unknown) => ({ kind: 'no_answer' as const }))
    const app = makeApp({ cfg, sn: okSn([article('x', 'Wrong Manager Assigned in Expense Approval')]), stats: noStats, llm: { preflight: async () => {}, decide } })
    await post(app, { message: 'where is the printer queue for building seven' })
    const seen = decide.mock.calls[0]?.[0] as unknown as { articles: unknown[] }
    expect(seen.articles).toHaveLength(0)
  })

  it('rejects a model-written query against a table the instance scan did not find', async () => {
    const run = vi.fn()
    const app = makeApp({
      cfg, sn: okSn(), stats: { run },
      llm: fakeLlm(() => ({ kind: 'metric', request: { table: 'sn_vul_vulnerable_item', filter: 'active=true', aggregate: 'count' } })),
      allowedTables: () => new Set(['incident', 'task_sla']),
    })
    const r = await post(app, { message: 'how many vulnerable items are open' })
    expect(r.body.gateReason).toBe('metric_unavailable')
    expect(run).not.toHaveBeenCalled()
  })

  it('declines when the aggregate query fails, and does not retry it', async () => {
    const run = vi.fn(async () => { throw new ServiceNowUnavailableError('rejected') })
    const app = makeApp({
      cfg,
      sn: okSn(),
      stats: { run },
      llm: fakeLlm(() => ({
        kind: 'metric',
        request: { table: 'incident', filter: 'bad!!', aggregate: 'count' },
      })),
    })
    const r = await post(app, { message: 'how many widgets are broken' })
    expect(r.body.gateReason).toBe('metric_unavailable')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('searches again once when the model asks, then answers', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([article('a', 'What is the Windows key?')])
      .mockResolvedValueOnce([article('b', 'New Starter Onboarding')])
    const decide = vi.fn()
      .mockResolvedValueOnce({ kind: 'search', query: 'new starter onboarding checklist' })
      .mockResolvedValueOnce({ kind: 'answer', text: 'Raise an onboarding request [1].' })
    const app = makeApp({
      cfg,
      sn: { search, health: async () => ({ ok: true }) },
      stats: noStats,
      llm: { preflight: async () => {}, decide },
    })
    const r = await post(app, { message: 'new joiner starts on monday' })
    expect(r.body.retried).toBe(true)
    expect(r.body.grounded).toBe(true)
    expect(search).toHaveBeenCalledTimes(2)
    expect(decide).toHaveBeenCalledTimes(2)
  })

  it('never honours a second SEARCH', async () => {
    const decide = vi.fn().mockResolvedValue({ kind: 'search', query: 'different words each time' })
    const search = vi.fn().mockResolvedValue([article('a', 'x')])
    const app = makeApp({
      cfg,
      sn: { search, health: async () => ({ ok: true }) },
      stats: noStats,
      llm: { preflight: async () => {}, decide },
    })
    const r = await post(app, { message: 'something obscure' })
    expect(r.body.grounded).toBe(false)
    expect(search).toHaveBeenCalledTimes(2)
    expect(decide).toHaveBeenCalledTimes(2)
  })

  it('treats SEARCH as a decline when retry is disabled', async () => {
    const search = vi.fn().mockResolvedValue([article('a', 'x')])
    const app = makeApp({
      cfg: { ...cfg, retryEnabled: false },
      sn: { search, health: async () => ({ ok: true }) },
      stats: noStats,
      llm: fakeLlm(() => ({ kind: 'search', query: 'better words' })),
    })
    const r = await post(app, { message: 'something obscure' })
    expect(r.body.grounded).toBe(false)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('distinguishes an outage from a no-match', async () => {
    const app = makeApp({
      cfg,
      sn: {
        search: async () => { throw new ServiceNowUnavailableError('down') },
        health: async () => ({ ok: false }),
      },
      stats: noStats,
      llm: fakeLlm(() => ({ kind: 'no_answer' })),
    })
    const r = await post(app, { message: 'how do I reset my SAP password' })
    expect(r.status).toBe(503)
    expect(r.body.gateReason).toBe('servicenow_unavailable')
  })

  it('never repairs a filter — one attempt, then decline', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new ServiceNowUnavailableError('bad filter'))
    const app = makeApp({
      cfg,
      sn: okSn(),
      stats: { run },
      llm: fakeLlm(() => ({
        kind: 'metric',
        request: { table: 'incident', filter: 'active=tru', aggregate: 'count' },
      })),
    })
    const r = await post(app, { message: 'how many open incidents are there' })
    expect(r.body.gateReason).toBe('metric_unavailable')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
