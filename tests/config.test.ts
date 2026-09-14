import { describe, it, expect } from 'vitest'
import { parseConfig } from '../src/config.js'
import { mask } from '../src/log.js'

const valid = {
  ANTHROPIC_API_KEY: 'sk-test-key-1234567890',
  ANTHROPIC_BASE_URL: 'https://llmproxy.example.com',
  CLAUDE_MODEL: 'claude-opus-4-8-Codon',
  SN_INSTANCE_URL: 'https://abhrademo4.service-now.com',
  SN_CLIENT_ID: 'cid',
  SN_CLIENT_SECRET: 'csecret',
  SN_REFRESH_TOKEN: 'rtoken',
}

describe('parseConfig', () => {
  it('applies documented defaults', () => {
    const c = parseConfig(valid)
    expect(c.port).toBe(3000)
    expect(c.retryEnabled).toBe(true)
    expect(c.llmMode).toBe('live')
  })

  it('strips a trailing slash from both base URLs', () => {
    const c = parseConfig({
      ...valid,
      ANTHROPIC_BASE_URL: 'https://llmproxy.example.com/',
      SN_INSTANCE_URL: 'https://abhrademo4.service-now.com/',
    })
    expect(c.anthropicBaseUrl).toBe('https://llmproxy.example.com')
    expect(c.sn.instanceUrl).toBe('https://abhrademo4.service-now.com')
  })

  it('names every missing variable in one error', () => {
    expect(() => parseConfig({})).toThrow(/ANTHROPIC_API_KEY.*SN_REFRESH_TOKEN/s)
  })

  it('rejects a non-numeric PORT', () => {
    expect(() => parseConfig({ ...valid, PORT: 'eighty' })).toThrow(/PORT/)
  })

  it('rejects an unknown LLM_MODE', () => {
    expect(() => parseConfig({ ...valid, LLM_MODE: 'demo' })).toThrow(/LLM_MODE/)
  })
})

describe('mask', () => {
  it('shows only the ends of a long secret', () => {
    expect(mask('sk-abcdefghijklmnop')).toBe('sk-ab…mnop')
  })
  it('reveals nothing about a short one', () => {
    expect(mask('short')).toBe('…')
  })
})
