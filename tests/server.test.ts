import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { makeApp, parseFacts, parseContext } from '../src/server.js'
import { parseConfig, type Config } from '../src/config.js'
import type { AgentModel } from '../src/llm/agent.js'
import type { SnClient } from '../src/servicenow/client.js'

const cfg: Config = parseConfig({
  ANTHROPIC_API_KEY: 'sk-test-key-1234567890',
  ANTHROPIC_BASE_URL: 'https://llmproxy.example.com',
  CLAUDE_MODEL: 'm',
  SN_INSTANCE_URL: 'https://sn.example.com',
  SN_CLIENT_ID: 'cid',
  SN_CLIENT_SECRET: 'csecret',
  SN_REFRESH_TOKEN: 'rtoken',
})

const sn = { health: async () => ({ ok: true, detail: 'reachable' }) }
const snClient: SnClient = {
  instanceUrl: 'https://sn.example.com',
  async get<T>(): Promise<T> { throw new Error('the instance must not be called in these tests') },
  async send<T>(): Promise<T> { throw new Error('read-only') },
}
/** A model that must never be reached: these tests cover what happens before the loop. */
const untouched: AgentModel = { step: async () => { throw new Error('the model must not be called') } }
const silent: AgentModel = { step: async () => ({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' } as unknown as Anthropic.Message) }

/** Minimal HTTP driver so the tests need no supertest dependency. */
async function call(app: ReturnType<typeof makeApp>, path: string, init?: RequestInit) {
  const server = app.listen(0)
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  } finally {
    server.close()
  }
}
const post = (app: ReturnType<typeof makeApp>, body: unknown) =>
  call(app, '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('POST /api/chat, before the loop', () => {
  it('rejects an empty message', async () => {
    const r = await post(makeApp({ cfg, sn, agent: untouched, snClient }), { message: '' })
    expect(r.status).toBe(400)
  })

  it('rejects a malformed JSON body with 400, not 500', async () => {
    const r = await call(makeApp({ cfg, sn, agent: untouched, snClient }), '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('body must be JSON')
  })

  it('rejects an oversized message', async () => {
    const r = await post(makeApp({ cfg, sn, agent: untouched, snClient }), { message: 'x'.repeat(2001) })
    expect(r.status).toBe(400)
  })

  it('declines greeting noise without calling the instance or the model', async () => {
    const r = await post(makeApp({ cfg, sn, agent: untouched, snClient }), { message: 'Hi Team,' })
    expect(r.status).toBe(200)
    expect(r.body.kind).toBe('decline')
    expect(r.body.gateReason).toBe('too_few_tokens')
  })

  it('reports the model and the instance on /api/health', async () => {
    const r = await call(makeApp({ cfg, sn, agent: silent, snClient }), '/api/health')
    expect(r.body.ok).toBe(true)
    expect(r.body.model).toBe('m')
  })
})

describe('parseFacts', () => {
  it('clamps strings and caps lists, keeping only the shape it reads', () => {
    const f = parseFacts({
      loadedAt: '2026-09-30T13:41:00Z',
      queue: { assigned_to_me: '7', unassigned_in_my_groups: 12, waiting_on_my_reply: 3, reopened: 1, changed_last_4h: 4, sla_breached_or_breaching_2h: 2, first: { number: 'INC0000017', title: 'x'.repeat(500) } },
      ticket: { number: 'INC0000017', title: 'VPN down', slas: Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, breached: i === 0, pct: 50 })), similar: [], same_title: ['INC1', 2, 'INC3'], articles: [], extra: 'dropped' },
    })!
    expect(f.queue?.assigned_to_me).toBe(7)
    expect(f.queue?.first?.title.length).toBe(120)
    expect(f.ticket?.slas.length).toBe(6)
    expect(f.ticket?.same_title).toEqual(['INC1', 'INC3'])
    expect((f.ticket as Record<string, unknown>).extra).toBeUndefined()
  })
  it('is undefined when neither a queue nor a ticket is present', () => {
    expect(parseFacts({ loadedAt: 'now' })).toBeUndefined()
    expect(parseFacts('nope')).toBeUndefined()
  })
})

describe('parseContext', () => {
  it('keeps a well-formed user, page, ticket and facts, and drops the rest', () => {
    const id = 'a'.repeat(32)
    const c = parseContext({ user: { id, name: 'Sam Roy', groups: [{ id, name: 'Network' }, { id: 'bad', name: 'x' }] }, page: 'ticket', ticket: 'INC0000017', facts: { queue: { assigned_to_me: 1 } }, token: 'secret' })!
    expect(c.user?.groups.map((g) => g.name)).toEqual(['Network'])
    expect(c.ticket).toBe('INC0000017')
    expect(c.facts?.queue?.assigned_to_me).toBe(1)
    expect((c as Record<string, unknown>).token).toBeUndefined()
  })
  it('rejects a user without a sys_id-shaped id and a ticket that is not a number', () => {
    expect(parseContext({ user: { id: '123', name: 'x' }, ticket: 'not-a-ticket' })).toBeUndefined()
  })
})
