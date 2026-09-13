import { describe, it, expect } from 'vitest'
import { parseConfig } from '../src/config.js'

const valid = {
  ANTHROPIC_API_KEY: 'sk-test-abcdefghijklmnop',
  ANTHROPIC_BASE_URL: 'https://llmproxy.example.com',
  CLAUDE_MODEL: 'claude-sonnet-4-5-Codon',
  SN_INSTANCE_URL: 'https://abhrademo4.service-now.com',
  SN_CLIENT_ID: 'cid',
  SN_CLIENT_SECRET: 'csecret',
  SN_REFRESH_TOKEN: 'rtoken',
  SN_KB_ALLOWLIST: 'aaa,bbb , ccc',
}

describe('parseConfig', () => {
  it('parses a valid environment', () => {
    const c = parseConfig(valid)
    expect(c.claudeModel).toBe('claude-sonnet-4-5-Codon')
    expect(c.sn.kbAllowlist).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('applies documented defaults', () => {
    const c = parseConfig(valid)
    expect(c.gateMinTokens).toBe(2)
    expect(c.gateMinCoverage).toBe(0.3)
    expect(c.searchLimit).toBe(5)
    expect(c.connector).toBe('servicenow')
  })

  it('defaults the model choice list to the single configured model', () => {
    expect(parseConfig(valid).claudeModelChoices).toEqual(['claude-sonnet-4-5-Codon'])
  })

  it('throws naming the missing variable', () => {
    const { CLAUDE_MODEL, ...missing } = valid
    expect(() => parseConfig(missing)).toThrow(/CLAUDE_MODEL/)
  })

  it('rejects an empty allowlist, which would search nothing', () => {
    expect(() => parseConfig({ ...valid, SN_KB_ALLOWLIST: '' })).toThrow(/SN_KB_ALLOWLIST/)
  })
})
