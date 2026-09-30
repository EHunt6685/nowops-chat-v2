import { describe, it, expect, vi } from 'vitest'
import { makeApp } from '../src/server.js'
import { parseConfig, type Config } from '../src/config.js'
import type { Article } from '../src/servicenow/types.js'
import { ServiceNowUnavailableError } from '../src/servicenow/types.js'
import type { Reply } from '../src/llm/client.js'
import { makeDefinitions } from '../src/definitions.js'

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

// A scanned tenant with open states confirmed and no SLA record matched, so the P1 SLA tiles are off.
const kpis = makeDefinitions(() => ({
  params: { open_states: '1,2,3' },
  tables: { incident: { present: true, missing_fields: [] }, task_sla: { present: true, missing_fields: [] } },
  confirmed: true,
}))

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
    const app = makeApp({ cfg, sn: okSn(), stats: noStats, llm: fakeLlm(() => ({ kind: 'no_answer', about: 'knowledge' })) })
    const r = await post(app, { message: '' })
    expect(r.status).toBe(400)
  })

  it('rejects a malformed JSON body with 400, not 500', async () => {
    const app = makeApp({ cfg, sn: okSn(), stats: noStats, llm: fakeLlm(() => ({ kind: 'no_answer', about: 'knowledge' })) })
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
      .mockResolvedValueOnce({ kind: 'no_answer', about: 'knowledge' })
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

  it('runs the tile query when the model names a NowOps definition', async () => {
    const decide = vi.fn(async (_o: unknown) => ({ kind: 'definition' as const, id: 'open_incidents' }))
    const search = vi.fn(async () => [])
    const run = vi.fn(async (_r: unknown) => ({ table: 'incident', filter: 'stateIN1,2,3', aggregate: 'count' as const, label: 'open tickets', value: 5403, url: 'u' }))
    const app = makeApp({ cfg, sn: { search, health: async () => ({ ok: true }) }, stats: { run }, llm: { preflight: async () => {}, decide }, kpis })
    // No counting verb: the model, not a regex, decides this is a count.
    const r = await post(app, { message: 'open incidents right now' })
    expect(r.body.kind).toBe('metric')
    expect((r.body.definition as { id: string }).id).toBe('open_incidents')
    expect(run.mock.calls[0]?.[0]).toMatchObject({ filter: 'stateIN1,2,3' })
    // The model saw the catalogue it chose from.
    const seen = decide.mock.calls[0]?.[0] as unknown as { catalogue?: { id: string }[] }
    expect(seen.catalogue?.map((c) => c.id)).toContain('open_incidents')
  })

  it('explains a definition the instance cannot answer instead of composing a substitute', async () => {
    const run = vi.fn()
    const app = makeApp({ cfg, sn: okSn([]), stats: { run }, llm: fakeLlm(() => ({ kind: 'definition', id: 'sla_p1_met' })), kpis })
    const r = await post(app, { message: 'P1 SLAs met' })
    expect(r.body.gateReason).toBe('definition_unavailable')
    expect(String(r.body.answer)).toContain('P1 resolution SLAs met')
    expect(run).not.toHaveBeenCalled()
  })

  it('says "no data yet" for a tier B definition that returns zero, as the tile does', async () => {
    const run = vi.fn(async () => ({ table: 'sc_req_item', filter: 'state=3', aggregate: 'avg' as const, field: 'calendar_duration', value: '00:00:00', url: 'u' }))
    const tenant = makeDefinitions(() => ({ params: { open_states: '1,2,3' }, tables: null }))
    const app = makeApp({ cfg, sn: okSn([]), stats: { run }, llm: fakeLlm(() => ({ kind: 'definition', id: 'ritm_fulfilment_time' })), kpis: tenant })
    const r = await post(app, { message: 'how long does fulfilment take' })
    expect(r.body.gateReason).toBe('definition_no_data')
    expect(r.body.kind).toBe('decline')
    expect(String(r.body.answer)).toContain('nothing is recorded')
  })

  it('declines a definition id that is not in the catalogue', async () => {
    const run = vi.fn()
    const app = makeApp({ cfg, sn: okSn([]), stats: { run }, llm: fakeLlm(() => ({ kind: 'definition', id: 'made_up_tile' })), kpis })
    const r = await post(app, { message: 'made up tile' })
    expect(r.body.gateReason).toBe('count_unmatched')
    expect(run).not.toHaveBeenCalled()
  })

  it('words a decline for the kind of question the model said it was', async () => {
    const app = (about: 'knowledge' | 'count' | 'other') =>
      makeApp({ cfg, sn: okSn([]), stats: noStats, llm: fakeLlm(() => ({ kind: 'no_answer', about })) })
    expect((await post(app('count'), { message: 'network breached SLA by support group' })).body.gateReason).toBe('count_unmatched')
    expect((await post(app('knowledge'), { message: 'how do I fix the printer' })).body.gateReason).toBe('model_declined')
    expect((await post(app('other'), { message: 'what is the capital of France' })).body.gateReason).toBe('out_of_scope')
  })

  it('passes clamped page facts to the model and returns a PAGE answer labelled as the page\'s', async () => {
    const decide = vi.fn(async (_o: unknown) => ({ kind: 'page' as const, text: '3 tickets are waiting on your reply.' }))
    const app = makeApp({ cfg, sn: okSn([]), stats: noStats, llm: { preflight: async () => {}, decide } })
    const facts = {
      loadedAt: '2026-09-30T13:41:00Z',
      queue: { assigned_to_me: 7, unassigned_in_my_groups: '12', waiting_on_my_reply: 3, reopened: 1, changed_last_4h: 4, sla_breached_or_breaching_2h: 2, first: { number: 'INC0000017', title: 'x'.repeat(500) } },
      ticket: { number: 'INC0000017', title: 'VPN down', slas: [{ name: 'P1 resolution', breached: true, pct: 140 }, 'junk'], similar: [], same_title: ['INC0000020', 7], articles: [], secret: 'dropped' },
    }
    const r = await post(app, { message: 'how many tickets are waiting on my reply', context: { page: 'queue', facts } })
    expect(r.body.kind).toBe('page')
    expect(r.body.grounded).toBe(true)
    expect(r.body.loadedAt).toBe('2026-09-30T13:41:00Z')
    const seen = (decide.mock.calls[0]?.[0] as unknown as { context: { facts: Record<string, any> } }).context.facts
    expect(seen.queue.unassigned_in_my_groups).toBe(12)
    expect(seen.queue.first.title).toHaveLength(120)
    expect(seen.ticket.slas).toHaveLength(1)
    expect(seen.ticket.same_title).toEqual(['INC0000020'])
    expect('secret' in seen.ticket).toBe(false)
  })

  it('searches the open ticket\'s title as well, and its articles lead', async () => {
    const search = vi.fn(async (q: string) => q === 'How do I fix this?' ? [article('generic', 'Managing Settings in Internet Explorer')] : [article('mine', 'Salesforce account inactive or locked')])
    const decide = vi.fn(async (_o: unknown) => ({ kind: 'no_answer' as const, about: 'knowledge' as const }))
    const app = makeApp({ cfg, sn: { search, health: async () => ({ ok: true }) }, stats: noStats, llm: { preflight: async () => {}, decide } })
    await post(app, { message: 'How do I fix this?', context: { page: 'ticket', ticket: 'INC0011804', facts: { ticket: { number: 'INC0011804', title: 'Salesforce account inactive', slas: [], similar: [], same_title: [], articles: [] } } } })
    expect(search).toHaveBeenCalledWith('Salesforce account inactive')
    const seen = decide.mock.calls[0]?.[0] as unknown as { articles: { id: string }[] }
    expect(seen.articles.map((a) => a.id)).toEqual(['mine', 'generic'])
  })

  it('does not show a PAGE answer when the page sent no facts to answer from', async () => {
    const app = makeApp({ cfg, sn: okSn([]), stats: noStats, llm: fakeLlm(() => ({ kind: 'page', text: 'You have 3 waiting.' })) })
    const r = await post(app, { message: 'how many tickets are waiting on my reply' })
    expect(r.body.kind).toBe('decline')
    expect(r.body.gateReason).toBe('needs_page')
  })

  it('tells the user to open their queue when a page question arrives with no page facts', async () => {
    const app = makeApp({ cfg, sn: okSn([]), stats: noStats, llm: fakeLlm(() => ({ kind: 'no_answer', about: 'page' })) })
    const r = await post(app, { message: 'how many tickets are waiting on my reply' })
    expect(r.body.gateReason).toBe('needs_page')
    expect(String(r.body.answer)).toContain('Open your queue')
  })

  it('searches for every question and passes who is asking to the model', async () => {
    const decide = vi.fn(async (_o: unknown) => ({ kind: 'no_answer' as const, about: 'count' as const }))
    const search = vi.fn(async () => [])
    const app = makeApp({ cfg, sn: { search, health: async () => ({ ok: true }) }, stats: noStats, llm: { preflight: async () => {}, decide } })
    const ctx = { user: { id: 'a'.repeat(32), name: 'David Dan', groups: [{ id: 'b'.repeat(32), name: 'Network' }] }, page: 'queue', junk: 'ignored' }
    await post(app, { message: 'how many tickets are assigned to me', context: ctx })
    expect(search).toHaveBeenCalledTimes(1)
    const seen = decide.mock.calls[0]?.[0] as unknown as { context?: { user?: { id: string }; page?: string } }
    expect(seen.context?.user?.id).toBe('a'.repeat(32))
    expect(seen.context?.page).toBe('queue')
    expect('junk' in (seen.context ?? {})).toBe(false)
  })

  it('drops articles that share no real word with the question', async () => {
    const decide = vi.fn(async (_o: unknown) => ({ kind: 'no_answer' as const, about: 'knowledge' as const }))
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
      llm: fakeLlm(() => ({ kind: 'no_answer', about: 'knowledge' })),
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
