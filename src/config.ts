import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

const Schema = z.object({
  PORT: z.string().default('3000'),
  CONNECTOR: z.string().default('servicenow'),

  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  ANTHROPIC_BASE_URL: z.string().url('ANTHROPIC_BASE_URL must be a URL'),
  CLAUDE_MODEL: z.string().min(1, 'CLAUDE_MODEL is required'),
  CLAUDE_MODEL_CHOICES: z.string().default(''),

  SN_INSTANCE_URL: z.string().url('SN_INSTANCE_URL must be a URL'),
  SN_CLIENT_ID: z.string().min(1, 'SN_CLIENT_ID is required'),
  SN_CLIENT_SECRET: z.string().min(1, 'SN_CLIENT_SECRET is required'),
  SN_REFRESH_TOKEN: z.string().min(1, 'SN_REFRESH_TOKEN is required'),
  SN_KB_ALLOWLIST: z.string().min(1, 'SN_KB_ALLOWLIST is required'),

  GATE_MIN_TOKENS: z.string().default('2'),
  GATE_MIN_COVERAGE: z.string().default('0.3'),
  SEARCH_LIMIT: z.string().default('5'),
})

export interface Config {
  port: number
  connector: string
  anthropicApiKey: string
  anthropicBaseUrl: string
  claudeModel: string
  claudeModelChoices: string[]
  gateMinTokens: number
  gateMinCoverage: number
  searchLimit: number
  sn: {
    instanceUrl: string
    clientId: string
    clientSecret: string
    refreshToken: string
    kbAllowlist: string[]
  }
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const r = Schema.safeParse(env)
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid configuration — ${detail}`)
  }
  const e = r.data
  const allowlist = csv(e.SN_KB_ALLOWLIST)
  if (allowlist.length === 0) {
    throw new Error('Invalid configuration — SN_KB_ALLOWLIST resolved to zero knowledge bases')
  }
  return {
    port: Number(e.PORT),
    connector: e.CONNECTOR,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicBaseUrl: e.ANTHROPIC_BASE_URL,
    claudeModel: e.CLAUDE_MODEL,
    claudeModelChoices: e.CLAUDE_MODEL_CHOICES ? csv(e.CLAUDE_MODEL_CHOICES) : [e.CLAUDE_MODEL],
    gateMinTokens: Number(e.GATE_MIN_TOKENS),
    gateMinCoverage: Number(e.GATE_MIN_COVERAGE),
    searchLimit: Number(e.SEARCH_LIMIT),
    sn: {
      instanceUrl: e.SN_INSTANCE_URL.replace(/\/$/, ''),
      clientId: e.SN_CLIENT_ID,
      clientSecret: e.SN_CLIENT_SECRET,
      refreshToken: e.SN_REFRESH_TOKEN,
      kbAllowlist: allowlist,
    },
  }
}

export const loadConfig = (): Config => parseConfig(process.env)
