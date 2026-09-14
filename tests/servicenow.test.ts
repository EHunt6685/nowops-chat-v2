import { describe, it, expect, vi } from 'vitest'
import { makeSearch, stripHtml, sanitiseQuery } from '../src/servicenow/search.js'
import { makeSnClient } from '../src/servicenow/client.js'
import { ServiceNowUnavailableError } from '../src/servicenow/types.js'
import { parseConfig } from '../src/config.js'

const cfg = parseConfig({
  ANTHROPIC_API_KEY: 'sk-test-key-1234567890',
  ANTHROPIC_BASE_URL: 'https://llmproxy.example.com',
  CLAUDE_MODEL: 'm',
  SN_INSTANCE_URL: 'https://sn.example.com',
  SN_CLIENT_ID: 'cid',
  SN_CLIENT_SECRET: 'csecret',
  SN_REFRESH_TOKEN: 'rtoken',
})

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const tokenResponse = () => ok({ access_token: 'tok-1', expires_in: 1800 })

/** Route the token endpoint to a token, everything else to `handler`. */
const snFetch = (handler: (url: string) => Response | Promise<Response>) =>
  vi.fn(async (u: unknown, _init?: RequestInit) =>
    String(u).includes('oauth_token.do') ? tokenResponse() : handler(String(u)))

describe('stripHtml', () => {
  it('turns tags into spaces so words do not run together', () => {
    expect(stripHtml('<p>Reset</p><p>password</p>')).toBe('Reset password')
  })
  it('decodes the entities ServiceNow actually emits', () => {
    expect(stripHtml('a&nbsp;b &amp; c')).toBe('a b & c')
  })
})

describe('sanitiseQuery', () => {
  it('removes characters that break sysparm_query', () => {
    expect(sanitiseQuery('a^b=c&d')).toBe('a b c d')
  })
  it('caps length', () => {
    expect(sanitiseQuery('x'.repeat(500)).length).toBe(200)
  })
})

describe('makeSnClient', () => {
  it('caches the token across calls', async () => {
    const fetchImpl = snFetch(() => ok({ result: [] }))
    const c = makeSnClient(cfg, fetchImpl as never)
    await c.get('/api/now/table/x')
    await c.get('/api/now/table/x')
    const tokenCalls = fetchImpl.mock.calls.filter((a) => String(a[0]).includes('oauth_token.do'))
    expect(tokenCalls).toHaveLength(1)
  })

  it('shares one refresh between concurrent callers', async () => {
    const fetchImpl = snFetch(() => ok({ result: [] }))
    const c = makeSnClient(cfg, fetchImpl as never)
    await Promise.all([c.get('/a'), c.get('/b'), c.get('/c')])
    const tokenCalls = fetchImpl.mock.calls.filter((a) => String(a[0]).includes('oauth_token.do'))
    expect(tokenCalls).toHaveLength(1)
  })

  it('sends the bearer token and a timeout signal', async () => {
    const fetchImpl = snFetch(() => ok({}))
    await makeSnClient(cfg, fetchImpl as never).get('/api/now/table/x')
    const init = fetchImpl.mock.calls.at(-1)![1]!
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('explains how to fix an expired refresh token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad grant', { status: 401 }))
    await expect(makeSnClient(cfg, fetchImpl as never).get('/x')).rejects.toThrow(/Connect-SnOAuth/)
  })

  it('raises ServiceNowUnavailableError when the instance is down', async () => {
    const fetchImpl = snFetch(() => { throw new TypeError('fetch failed') })
    await expect(makeSnClient(cfg, fetchImpl as never).get('/x'))
      .rejects.toBeInstanceOf(ServiceNowUnavailableError)
  })

  it('raises ServiceNowUnavailableError on a non-2xx body, keeping the detail', async () => {
    const fetchImpl = snFetch(() => new Response('Invalid query', { status: 400 }))
    await expect(makeSnClient(cfg, fetchImpl as never).get('/x')).rejects.toThrow(/400.*Invalid query/)
  })
})

describe('makeSearch', () => {
  it('queries kb_knowledge with exactly two clauses', async () => {
    let url = ''
    const fetchImpl = snFetch((u) => { url = u; return ok({ result: [] }) })
    await makeSearch(makeSnClient(cfg, fetchImpl as never)).search('printer offline')
    const q = new URL(url).searchParams.get('sysparm_query')
    expect(q).toBe('workflow_state=published^123TEXTQUERY321=printer offline')
  })

  it('maps records to Articles keyed on sys_id and links by sys_id', async () => {
    const fetchImpl = snFetch(() => ok({
      result: [{ sys_id: 'abc123', number: 'KB0010141', short_description: 'Title', text: '<p>Body</p>' }],
    }))
    const [a] = await makeSearch(makeSnClient(cfg, fetchImpl as never)).search('q')
    expect(a).toBeDefined()
    expect(a!.id).toBe('abc123')
    expect(a!.label).toBe('KB0010141')
    expect(a!.body).toBe('Body')
    expect(a!.url).toBe('https://sn.example.com/kb_view.do?sys_kb_id=abc123')
  })

  it('reports health without throwing', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
    const h = await makeSearch(makeSnClient(cfg, fetchImpl as never)).health()
    expect(h.ok).toBe(false)
  })
})
