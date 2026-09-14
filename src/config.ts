import { z } from 'zod'

// .env is read by Node itself (every script passes --env-file=.env), so there
// is no loader library and nothing to call before the schema runs.
const Schema = z.object({
  PORT: z.string().regex(/^\d+$/, 'PORT must be a whole number').default('3000'),

  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  ANTHROPIC_BASE_URL: z.url({ error: 'ANTHROPIC_BASE_URL must be a URL' }),
  CLAUDE_MODEL: z.string().min(1, 'CLAUDE_MODEL is required'),

  SN_INSTANCE_URL: z.url({ error: 'SN_INSTANCE_URL must be a URL' }),
  SN_CLIENT_ID: z.string().min(1, 'SN_CLIENT_ID is required'),
  SN_CLIENT_SECRET: z.string().min(1, 'SN_CLIENT_SECRET is required'),
  SN_REFRESH_TOKEN: z.string().min(1, 'SN_REFRESH_TOKEN is required'),

  // The only two behavioural switches. Everything else is a const in the file
  // that uses it — see MIN_TOKENS, SEARCH_LIMIT, TIMEOUT_MS.
  RETRY_ENABLED: z.enum(['true', 'false']).default('true'),
  LLM_MODE: z.enum(['live', 'stub']).default('live'),
})

export interface Config {
  port: number
  anthropicApiKey: string
  anthropicBaseUrl: string
  claudeModel: string
  retryEnabled: boolean
  llmMode: 'live' | 'stub'
  sn: {
    instanceUrl: string
    clientId: string
    clientSecret: string
    refreshToken: string
  }
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const r = Schema.safeParse(env)
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid configuration — ${detail}`)
  }
  const e = r.data
  return {
    port: Number(e.PORT),
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    // A trailing slash here produces '//v1/messages' against some gateways.
    anthropicBaseUrl: e.ANTHROPIC_BASE_URL.replace(/\/$/, ''),
    claudeModel: e.CLAUDE_MODEL,
    retryEnabled: e.RETRY_ENABLED === 'true',
    llmMode: e.LLM_MODE,
    sn: {
      instanceUrl: e.SN_INSTANCE_URL.replace(/\/$/, ''),
      clientId: e.SN_CLIENT_ID,
      clientSecret: e.SN_CLIENT_SECRET,
      refreshToken: e.SN_REFRESH_TOKEN,
    },
  }
}

export const loadConfig = (): Config => parseConfig(process.env)
