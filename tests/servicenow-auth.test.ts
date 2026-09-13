import { describe, it, expect, vi } from 'vitest'
import { makeTokenProvider } from '../src/connectors/servicenow/auth.js'
import { PlatformUnavailableError } from '../src/connectors/types.js'
import { parseConfig } from '../src/config.js'

const cfg = parseConfig({
  ANTHROPIC_API_KEY: 'sk-test-abcdefghijkl',
  ANTHROPIC_BASE_URL: 'https://llmproxy.example.com',
  CLAUDE_MODEL: 'm',
  SN_INSTANCE_URL: 'https://abhrademo4.service-now.com',
  SN_CLIENT_ID: 'cid',
  SN_CLIENT_SECRET: 'csecret',
  SN_REFRESH_TOKEN: 'rtoken',
  SN_KB_ALLOWLIST: 'kb1',
})

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response

describe('makeTokenProvider', () => {
  it('exchanges the refresh token for an access token', async () => {
    const f = vi.fn(async () => ok({ access_token: 'AT1', expires_in: 1800 }))
    const p = makeTokenProvider(cfg, f as unknown as typeof fetch)
    expect(await p.getToken()).toBe('AT1')

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://abhrademo4.service-now.com/oauth_token.do')
    expect(String(init.body)).toContain('grant_type=refresh_token')
  })

  it('caches the token instead of refreshing per request', async () => {
    const f = vi.fn(async () => ok({ access_token: 'AT1', expires_in: 1800 }))
    const p = makeTokenProvider(cfg, f as unknown as typeof fetch)
    await p.getToken()
    await p.getToken()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('refreshes again once the token has expired', async () => {
    const f = vi.fn(async () => ok({ access_token: 'AT1', expires_in: 0 }))
    const p = makeTokenProvider(cfg, f as unknown as typeof fetch)
    await p.getToken()
    await p.getToken()
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('raises PlatformUnavailableError naming the fix when the grant is rejected', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'invalid_grant' }) as Response)
    const p = makeTokenProvider(cfg, f as unknown as typeof fetch)
    await expect(p.getToken()).rejects.toThrow(PlatformUnavailableError)
    await expect(p.getToken()).rejects.toThrow(/Connect-SnOAuth/)
  })
})
