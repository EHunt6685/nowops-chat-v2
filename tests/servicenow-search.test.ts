import { describe, it, expect, vi } from 'vitest'
import { makeServiceNowConnector, stripHtml } from '../src/connectors/servicenow/search.js'
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
  SN_KB_ALLOWLIST: 'kb1,kb2',
})

const record = {
  sys_id: '5808376b3bed0710913c44e643e45a80',
  number: 'KB0010141',
  short_description: 'Self-checkout NCR terminal will not boot after image push',
  text: '<p>Reimage the <b>terminal</b>&nbsp;and reboot.</p>',
}

function fetchStub(payload: unknown, status = 200) {
  return vi.fn(async (url: string) => {
    if (String(url).includes('oauth_token.do')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'AT', expires_in: 1800 }) } as Response
    }
    return {
      ok: status === 200,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response
  })
}

describe('stripHtml', () => {
  it('inserts a space between adjacent table cells so words do not run together', () => {
    expect(stripHtml('<td>foo</td><td>bar</td>')).toBe('foo bar')
  })

  it('inserts a space between adjacent inline tags', () => {
    expect(stripHtml('<span>foo</span><span>bar</span>')).toBe('foo bar')
  })

  it('still strips nested tags and decodes entities', () => {
    expect(stripHtml('<p>Reimage the <b>terminal</b>&nbsp;and reboot.</p>')).toBe(
      'Reimage the terminal and reboot.',
    )
  })
})

describe('ServiceNow connector', () => {
  it('maps records to Articles keyed by sys_id, not number', async () => {
    const f = fetchStub({ result: [record] })
    const [a] = await makeServiceNowConnector(cfg, f as unknown as typeof fetch).search('self-checkout down', 5)

    expect(a.id).toBe('5808376b3bed0710913c44e643e45a80')
    expect(a.label).toBe('KB0010141')
    expect(a.url).toBe(
      'https://abhrademo4.service-now.com/kb_view.do?sys_kb_id=5808376b3bed0710913c44e643e45a80',
    )
  })

  it('strips HTML and decodes entities from the body', async () => {
    const f = fetchStub({ result: [record] })
    const [a] = await makeServiceNowConnector(cfg, f as unknown as typeof fetch).search('x', 5)
    expect(a.body).toBe('Reimage the terminal and reboot.')
  })

  it('scopes the query to published articles in allowlisted knowledge bases', async () => {
    const f = fetchStub({ result: [] })
    await makeServiceNowConnector(cfg, f as unknown as typeof fetch).search('printer', 5)

    const searchUrl = decodeURIComponent(String(f.mock.calls[1][0]).replace(/\+/g, ' '))
    expect(searchUrl).toContain('workflow_state=published')
    expect(searchUrl).toContain('kb_knowledge_baseINkb1,kb2')
    expect(searchUrl).toContain('123TEXTQUERY321=printer')
  })

  it('sanitises characters that would break query syntax', async () => {
    const f = fetchStub({ result: [] })
    await makeServiceNowConnector(cfg, f as unknown as typeof fetch).search('a^b=c&d', 5)
    // URLSearchParams encodes spaces as '+' (application/x-www-form-urlencoded);
    // decodeURIComponent alone doesn't turn '+' back into ' ', so normalise it first.
    const searchUrl = decodeURIComponent(String(f.mock.calls[1][0]).replace(/\+/g, ' '))
    expect(searchUrl).toContain('123TEXTQUERY321=a b c d')
  })

  it('returns an empty array when the instance finds nothing', async () => {
    const f = fetchStub({ result: [] })
    expect(await makeServiceNowConnector(cfg, f as unknown as typeof fetch).search('zzz', 5)).toEqual([])
  })

  it('raises PlatformUnavailableError on an HTTP failure', async () => {
    const f = fetchStub({ error: 'boom' }, 500)
    await expect(
      makeServiceNowConnector(cfg, f as unknown as typeof fetch).search('x', 5),
    ).rejects.toThrow(PlatformUnavailableError)
  })
})
