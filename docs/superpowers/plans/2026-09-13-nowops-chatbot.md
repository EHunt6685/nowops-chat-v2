# NowOps Chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Express/TypeScript service that answers questions from a ticketing platform's knowledge base using Claude via the UST LLM gateway, citing every source, behind a platform-agnostic connector seam with ServiceNow as the first implementation.

**Architecture:** A `KnowledgeConnector` interface is the only thing that knows which platform we talk to. Above it, four modules operate purely on `Article`: `gate/` (decides whether we know the answer), `llm/` (gateway, prompts, citation verification), `server/` (routes, state), and a static chat UI. There is no database, no local index and no embeddings — search runs live against the platform, per question.

**Tech Stack:** Node 22+ (dev machine runs v24.18.0), TypeScript (ESM, `NodeNext`), Express 5, `@anthropic-ai/sdk`, `zod`, `dotenv`; dev-only `tsx`, `vitest`, `typescript`, `@types/*`.

**Spec:** [docs/superpowers/specs/2026-09-13-nowops-chatbot-design.md](../specs/2026-09-13-nowops-chatbot-design.md) (revision 3)

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 22 LTS floor.** `.nvmrc` pins `22`; `package.json` sets `"engines": { "node": ">=22" }`. The dev machine runs v24.18.0, which satisfies it.
- **Runtime dependencies are exactly four:** `express`, `@anthropic-ai/sdk`, `dotenv`, `zod`. Dev-only: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/express`. **Adding any other dependency is a plan violation** — raise it rather than installing it.
- **Nothing above the connector seam may import from `src/connectors/servicenow/`** (D12). The gate, llm, server and UI operate on `Article` only. Task 11 proves this.
- **`Article.id` is the identity key everywhere** (D10). On ServiceNow that is `sys_id`. Article `number` is not unique on abhrademo4 — `KB0010004` maps to four different articles — so it is a display label only. Links use `kb_view.do?sys_kb_id=<sys_id>`, never `sysparm_article=<number>`.
- **The model cites bracketed labels `[1]`–`[5]`, never KB numbers** (D10, spec §10). The server maps labels back to `Article.id`.
- **The knowledge base allowlist is keyed by knowledge base `sys_id`** (D9), because 9 of the most valuable knowledge bases have ACL-restricted records with no readable title.
- **No `GET /v1/models` discovery against the gateway** (spec §7 rule 1). The model list is explicit configuration.
- **Never log secrets.** Mask API keys as `sk-abc12…wxyz`; keep a deny-list of secret env names in the logger.
- **`.env` is never committed.** `.gitignore` already covers it. `.env.example` holds placeholders only.
- **A failure to reach the platform must never be reported as "no knowledge base match"** (spec §13). Different message, different `gateReason`.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.nvmrc` | Toolchain and scripts |
| `.env.example` | Documented placeholder config |
| `src/config.ts` | Load + validate env with zod; fail fast |
| `src/log.ts` | Single-line structured logging with secret masking |
| `src/connectors/types.ts` | `Article`, `KnowledgeConnector` — **the platform seam** |
| `src/connectors/index.ts` | Select connector from `CONNECTOR` env var |
| `src/connectors/fake.ts` | In-memory connector for tests and the seam proof |
| `src/connectors/servicenow/auth.ts` | OAuth refresh-token grant, cached access token |
| `src/connectors/servicenow/search.ts` | Live `kb_knowledge` text search → `Article[]` |
| `src/gate/tokenise.ts` | Lowercase, strip punctuation, drop stopwords, coverage |
| `src/gate/decide.ts` | Token guard + coverage floor → answer or decline |
| `src/llm/prompt.ts` | Context block, citation parsing and verification |
| `src/llm/client.ts` | Gateway client, preflight |
| `src/server/routes.ts` | `/api/chat`, `/api/health` |
| `src/server/app.ts` | Express wiring, static files |
| `src/main.ts` | Boot sequence |
| `public/index.html`, `app.js`, `styles.css` | Chat UI with the three-state source line |
| `tools/eval.ts` | `npm run eval` — recall@k against the eval set |
| `tools/calibrate.ts` | `npm run calibrate` — threshold sweep + recommendation |
| `tests/fixtures/retrieval-eval.json` | **Already exists** — 35 in-scope, 10 out-of-scope |

---

## Task 1: Project scaffold, config and logging

**Files:**
- Create: `package.json`, `tsconfig.json`, `.nvmrc`, `.env.example`, `src/config.ts`, `src/log.ts`
- Test: `tests/config.test.ts`, `tests/log.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `parseConfig(env): Config` and `loadConfig(): Config`, throwing on invalid env. `Config` fields: `port`, `connector`, `anthropicApiKey`, `anthropicBaseUrl`, `claudeModel`, `claudeModelChoices: string[]`, `gateMinTokens: number`, `gateMinCoverage: number`, `searchLimit: number`, `sn: { instanceUrl, clientId, clientSecret, refreshToken, kbAllowlist: string[] }`. Also `mask(secret: string): string` and `log(event: string, fields?: Record<string, unknown>): void`.

- [ ] **Step 1: Initialise the project**

```bash
cd C:/dev/nowops-chat
npm init -y
npm install express @anthropic-ai/sdk dotenv zod
npm install -D typescript tsx vitest @types/node @types/express
node -e "const p=require('./package.json');p.type='module';p.engines={node:'>=22'};p.scripts={dev:'tsx watch src/main.ts',start:'node dist/main.js',build:'tsc',test:'vitest run',eval:'tsx tools/eval.ts',calibrate:'tsx tools/calibrate.ts'};require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))"
echo 22 > .nvmrc
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tools/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Write the failing tests**

`tests/config.test.ts`:

```ts
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
```

`tests/log.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mask } from '../src/log.js'

describe('mask', () => {
  it('shows only the first and last few characters', () => {
    expect(mask('sk-abc123456789wxyz')).toBe('sk-ab…wxyz')
  })

  it('fully masks short secrets rather than leaking them', () => {
    expect(mask('short')).toBe('…')
  })

  it('handles empty input', () => {
    expect(mask('')).toBe('…')
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 5: Implement `src/log.ts`**

```ts
const SECRET_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'SN_CLIENT_SECRET',
  'SN_REFRESH_TOKEN',
  'SN_CLIENT_ID',
]

/** Masks a secret for logs: sk-abc123456789wxyz -> sk-ab…wxyz */
export function mask(secret: string): string {
  if (!secret || secret.length < 12) return '…'
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`
}

/** Single-line structured log. Values under known secret keys are masked. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    safe[k] = SECRET_ENV_NAMES.includes(k) && typeof v === 'string' ? mask(v) : v
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...safe }))
}
```

- [ ] **Step 6: Implement `src/config.ts`**

```ts
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
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, 8 tests

- [ ] **Step 8: Write `.env.example`**

The real `.env` already holds live ServiceNow values written by `Export-SnEnvFile`. This committed file documents the shape with placeholders only.

```
# LLM gateway (UST LiteLLM)
ANTHROPIC_API_KEY=sk-replace-me
ANTHROPIC_BASE_URL=https://llmproxy.example.com
CLAUDE_MODEL=exact-gateway-model-id
CLAUDE_MODEL_CHOICES=model-a,model-b

# ServiceNow (written by Export-SnEnvFile — do not hand-edit)
SN_INSTANCE_URL=https://abhrademo4.service-now.com
SN_CLIENT_ID=replace-me
SN_CLIENT_SECRET=replace-me
SN_REFRESH_TOKEN=replace-me

# Knowledge base allowlist — sys_ids, NOT titles (D9).
# Excludes Security Incident (450 demo articles) and SIR Runbook (14).
SN_KB_ALLOWLIST=dfc19531bf2021003f07e2c1ac0739ab,c4cdddd0773302109ac0cf0bbb5a99dd,a7e8a78bff0221009b20ffffffffff17,adb2c51383f6ee503be7a7d0deaad348,4fe5d7e683f08b103be7a7d0deaad3d5,bb0370019f22120047a2d126c42e7073,e381da4b2bb6ee50d16df709f291bff0,05ff44289f011200550bf7b6077fcfa3,1f15baa8c303101088cee5f87d40dd86,29cb47688322a2103be7a7d0deaad3e2,820f49a42b158350d16df709f291bf21,cb574c6c3b118710913c44e643e45a75,c0a54bac871023000e3dd61e36cb0bcb,0aa3ffa7db7c030064dd36cb7c96197f

# Relevance gate
GATE_MIN_TOKENS=2
GATE_MIN_COVERAGE=0.3
SEARCH_LIMIT=5
CONNECTOR=servicenow
PORT=3000
```

- [ ] **Step 9: Append the non-secret settings to the real `.env`**

`Export-SnEnvFile` wrote only the four `SN_*` OAuth values. Append the rest without disturbing them:

```bash
node -e "const fs=require('fs');const add=fs.readFileSync('.env.example','utf8').split('\n').filter(l=>/^(SN_KB_ALLOWLIST|GATE_|SEARCH_LIMIT|CONNECTOR|PORT)=/.test(l)).join('\n');fs.appendFileSync('.env','\n'+add+'\n')"
```

Gateway values remain outstanding (spec §17). Task 7 is the first task that needs them.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json .nvmrc .env.example src/config.ts src/log.ts tests/config.test.ts tests/log.test.ts
git commit -m "feat: project scaffold, validated config and masking logger"
```

---

## Task 2: The connector seam

**Files:**
- Create: `src/connectors/types.ts`, `src/connectors/fake.ts`, `src/connectors/index.ts`
- Test: `tests/connector-contract.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1)
- Produces: `Article { id: string; label?: string; title: string; body: string; url: string }`; `HealthStatus { ok: boolean; detail?: string }`; `KnowledgeConnector { name: string; search(query: string, limit: number): Promise<Article[]>; health(): Promise<HealthStatus> }`; `PlatformUnavailableError`; `makeFakeConnector(articles: Article[]): KnowledgeConnector`; `getConnector(cfg: Config): KnowledgeConnector`

- [ ] **Step 1: Write the failing contract test**

`tests/connector-contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeFakeConnector } from '../src/connectors/fake.js'
import type { Article } from '../src/connectors/types.js'

const articles: Article[] = [
  { id: 'a1', label: 'KB0001', title: 'VPN will not connect', body: 'restart the vpn client', url: 'https://x/a1' },
  { id: 'a2', label: 'KB0002', title: 'Printer jam', body: 'open the tray and clear paper', url: 'https://x/a2' },
]

describe('KnowledgeConnector contract', () => {
  it('returns matching articles', async () => {
    const r = await makeFakeConnector(articles).search('vpn', 5)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('a1')
  })

  it('respects the limit', async () => {
    expect(await makeFakeConnector(articles).search('e', 1)).toHaveLength(1)
  })

  it('returns an empty array rather than throwing when nothing matches', async () => {
    expect(await makeFakeConnector(articles).search('zzzznomatch', 5)).toEqual([])
  })

  it('reports health', async () => {
    expect((await makeFakeConnector(articles).health()).ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/connector-contract.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/connectors/types.ts`**

```ts
/** One knowledge item, whatever platform it came from. */
export interface Article {
  /** Stable unique id — ServiceNow sys_id, Confluence page id, Jira issue key. */
  id: string
  /** Human-facing label such as KB0010141. Display only: NOT unique on ServiceNow. */
  label?: string
  title: string
  body: string
  /** Where a human opens this article. */
  url: string
}

export interface HealthStatus {
  ok: boolean
  detail?: string
}

/**
 * The platform seam (D12). Nothing above this interface may know which
 * ticketing platform is in use.
 */
export interface KnowledgeConnector {
  name: string
  search(query: string, limit: number): Promise<Article[]>
  health(): Promise<HealthStatus>
}

/**
 * Thrown when the platform cannot be reached or rejects our credentials.
 * Distinct from "no results" — the two must never produce the same user message.
 */
export class PlatformUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'PlatformUnavailableError'
  }
}
```

- [ ] **Step 4: Implement `src/connectors/fake.ts`**

```ts
import type { Article, KnowledgeConnector } from './types.js'

/** In-memory connector for tests and for proving the seam is real. */
export function makeFakeConnector(articles: Article[]): KnowledgeConnector {
  return {
    name: 'fake',
    async search(query: string, limit: number): Promise<Article[]> {
      const q = query.toLowerCase()
      return articles
        .filter((a) => `${a.title} ${a.body}`.toLowerCase().includes(q))
        .slice(0, limit)
    },
    async health() {
      return { ok: true, detail: `fake connector, ${articles.length} articles` }
    },
  }
}
```

- [ ] **Step 5: Implement `src/connectors/index.ts`**

```ts
import type { Config } from '../config.js'
import type { KnowledgeConnector } from './types.js'
import { makeServiceNowConnector } from './servicenow/search.js'

/** The only place a concrete connector is named. Adding Jira means adding a case here. */
export function getConnector(cfg: Config): KnowledgeConnector {
  switch (cfg.connector) {
    case 'servicenow':
      return makeServiceNowConnector(cfg)
    default:
      throw new Error(`Unknown CONNECTOR '${cfg.connector}'. Implemented: servicenow.`)
  }
}
```

This does not compile until Task 4 creates `servicenow/search.ts`. That is expected — Task 2's test imports `fake.js` directly and passes now. Do not run `npx tsc` until Task 4.

- [ ] **Step 6: Run the contract test**

Run: `npx vitest run tests/connector-contract.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 7: Commit**

```bash
git add src/connectors/types.ts src/connectors/fake.ts src/connectors/index.ts tests/connector-contract.test.ts
git commit -m "feat: KnowledgeConnector seam with fake implementation"
```

---

## Task 3: ServiceNow OAuth

**Files:**
- Create: `src/connectors/servicenow/auth.ts`
- Test: `tests/servicenow-auth.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1), `PlatformUnavailableError` (Task 2), `log` (Task 1)
- Produces: `makeTokenProvider(cfg: Config, fetchImpl?: typeof fetch): { getToken(): Promise<string> }`

- [ ] **Step 1: Write the failing test**

`tests/servicenow-auth.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/servicenow-auth.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/connectors/servicenow/auth.ts`**

```ts
import type { Config } from '../../config.js'
import { PlatformUnavailableError } from '../types.js'
import { log } from '../../log.js'

/** Refresh a minute early so a token never expires mid-request. */
const EXPIRY_SAFETY_SECONDS = 60

export function makeTokenProvider(cfg: Config, fetchImpl: typeof fetch = fetch) {
  let token: string | null = null
  let expiresAt = 0

  async function refresh(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.sn.refreshToken,
      client_id: cfg.sn.clientId,
      client_secret: cfg.sn.clientSecret,
    })

    let res: Response
    try {
      res = await fetchImpl(`${cfg.sn.instanceUrl}/oauth_token.do`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
    } catch (e) {
      throw new PlatformUnavailableError(
        `Cannot reach ${cfg.sn.instanceUrl} to refresh the access token.`,
        e,
      )
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new PlatformUnavailableError(
        `ServiceNow rejected the refresh token (HTTP ${res.status}). ` +
          `Refresh tokens last ~100 days and may have expired. ` +
          `Fix: run Connect-SnOAuth -Instance abhrademo4, then Export-SnEnvFile. ${detail}`,
      )
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!json.access_token) {
      throw new PlatformUnavailableError('Token endpoint returned no access_token.')
    }

    token = json.access_token
    expiresAt = Date.now() + ((json.expires_in ?? 1800) - EXPIRY_SAFETY_SECONDS) * 1000
    log('sn.token.refreshed', { expiresInSec: json.expires_in ?? 1800 })
    return token
  }

  return {
    async getToken(): Promise<string> {
      if (token && Date.now() < expiresAt) return token
      return refresh()
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/servicenow-auth.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/connectors/servicenow/auth.ts tests/servicenow-auth.test.ts
git commit -m "feat: ServiceNow OAuth refresh-token provider with caching"
```

---

## Task 4: ServiceNow search

**Files:**
- Create: `src/connectors/servicenow/search.ts`
- Test: `tests/servicenow-search.test.ts`

**Interfaces:**
- Consumes: `makeTokenProvider` (Task 3); `Article`, `KnowledgeConnector`, `HealthStatus`, `PlatformUnavailableError` (Task 2)
- Produces: `makeServiceNowConnector(cfg: Config, fetchImpl?: typeof fetch): KnowledgeConnector`; `stripHtml(html: string): string`; `sanitiseQuery(q: string): string`

Query shape (spec §8): `workflow_state=published^kb_knowledge_baseIN<allowlist>^123TEXTQUERY321=<sanitised>`

- [ ] **Step 1: Write the failing test**

`tests/servicenow-search.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeServiceNowConnector } from '../src/connectors/servicenow/search.js'
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

    const searchUrl = decodeURIComponent(String(f.mock.calls[1][0]))
    expect(searchUrl).toContain('workflow_state=published')
    expect(searchUrl).toContain('kb_knowledge_baseINkb1,kb2')
    expect(searchUrl).toContain('123TEXTQUERY321=printer')
  })

  it('sanitises characters that would break query syntax', async () => {
    const f = fetchStub({ result: [] })
    await makeServiceNowConnector(cfg, f as unknown as typeof fetch).search('a^b=c&d', 5)
    const searchUrl = decodeURIComponent(String(f.mock.calls[1][0]))
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/servicenow-search.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/connectors/servicenow/search.ts`**

```ts
import type { Config } from '../../config.js'
import type { Article, KnowledgeConnector, HealthStatus } from '../types.js'
import { PlatformUnavailableError } from '../types.js'
import { makeTokenProvider } from './auth.js'

interface SnRecord {
  sys_id: string
  number?: string
  short_description?: string
  text?: string
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
}

/** Article bodies are HTML. Reduce to readable plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

/** `^`, `=` and `&` break sysparm_query syntax, so they never reach the instance. */
export function sanitiseQuery(q: string): string {
  return q.replace(/[\^=&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

export function makeServiceNowConnector(
  cfg: Config,
  fetchImpl: typeof fetch = fetch,
): KnowledgeConnector {
  const tokens = makeTokenProvider(cfg, fetchImpl)

  async function call(path: string): Promise<SnRecord[]> {
    const token = await tokens.getToken()
    let res: Response
    try {
      res = await fetchImpl(`${cfg.sn.instanceUrl}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
    } catch (e) {
      throw new PlatformUnavailableError(`Cannot reach ${cfg.sn.instanceUrl}.`, e)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new PlatformUnavailableError(
        `ServiceNow search failed (HTTP ${res.status}). ${detail.slice(0, 200)}`,
      )
    }
    const json = (await res.json()) as { result?: SnRecord[] }
    return json.result ?? []
  }

  function buildPath(query: string, limit: number): string {
    const sysparmQuery = [
      'workflow_state=published',
      `kb_knowledge_baseIN${cfg.sn.kbAllowlist.join(',')}`,
      `123TEXTQUERY321=${sanitiseQuery(query)}`,
    ].join('^')

    const params = new URLSearchParams({
      sysparm_limit: String(limit),
      sysparm_fields: 'sys_id,number,short_description,text',
      sysparm_query: sysparmQuery,
    })
    return `/api/now/table/kb_knowledge?${params.toString()}`
  }

  return {
    name: 'servicenow',

    async search(query: string, limit: number): Promise<Article[]> {
      const records = await call(buildPath(query, limit))
      return records.map((r) => ({
        id: r.sys_id,
        label: r.number,
        title: (r.short_description ?? '').trim(),
        body: stripHtml(r.text ?? ''),
        // Link by sys_id: number is not unique on this instance (D10).
        url: `${cfg.sn.instanceUrl}/kb_view.do?sys_kb_id=${r.sys_id}`,
      }))
    },

    async health(): Promise<HealthStatus> {
      try {
        await call(buildPath('test', 1))
        return { ok: true, detail: `${cfg.sn.kbAllowlist.length} knowledge bases in scope` }
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/servicenow-search.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Verify against the live instance**

```bash
npx tsx -e "import {loadConfig} from './src/config.js';import {makeServiceNowConnector} from './src/connectors/servicenow/search.js';makeServiceNowConnector(loadConfig()).search('Self-checkout lanes 1-4 down at Store #208 after image push',5).then(r=>console.log(r.map(a=>a.label+' '+a.title)))"
```

Expected: `KB0010141 Self-checkout NCR terminal will not boot after image push` first. That is eval question `inc-01`.

Note this needs the gateway variables present in `.env` only because `loadConfig()` validates the whole environment. If they are not yet available, put placeholder values in `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and `CLAUDE_MODEL` for this step — nothing calls the gateway here.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/servicenow/search.ts tests/servicenow-search.test.ts
git commit -m "feat: live ServiceNow knowledge search mapped to Article"
```

---

## Task 5: Tokeniser and coverage scoring

**Files:**
- Create: `src/gate/tokenise.ts`
- Test: `tests/tokenise.test.ts`

**Interfaces:**
- Consumes: nothing (pure)
- Produces: `tokenise(s: string): string[]`; `coverage(query: string, doc: string): number`

- [ ] **Step 1: Write the failing test**

`tests/tokenise.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { tokenise, coverage } from '../src/gate/tokenise.js'

describe('tokenise', () => {
  it('lowercases and splits on punctuation', () => {
    expect(tokenise('Printer, JAM!')).toEqual(['printer', 'jam'])
  })

  it('drops stopwords and very short tokens', () => {
    expect(tokenise('the printer is on my desk')).toEqual(['printer', 'desk'])
  })

  it('keeps error codes and identifiers intact', () => {
    expect(tokenise('AP_MAX_AMOUNT and $.entities')).toEqual(['ap_max_amount', '$.entities'])
  })

  it('reduces greeting-only input to a single term', () => {
    expect(tokenise('Hi Team,')).toEqual(['team'])
  })
})

describe('coverage', () => {
  it('is 1 when every query term appears', () => {
    expect(coverage('printer jam', 'the printer has a jam')).toBe(1)
  })

  it('is 0.5 when half appear', () => {
    expect(coverage('printer jam', 'the printer is fine')).toBe(0.5)
  })

  it('is 0 for no overlap', () => {
    expect(coverage('printer jam', 'network outage')).toBe(0)
  })

  it('is 0 when the query has no meaningful terms', () => {
    expect(coverage('the is a', 'anything')).toBe(0)
  })

  it('counts each distinct term once', () => {
    expect(coverage('printer printer jam', 'printer jam')).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tokenise.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/gate/tokenise.ts`**

```ts
const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','to','of','in','on','for','and','or','it','this',
  'that','with','my','we','our','not','no','be','been','has','have','do','does','did','can',
  'cannot','am','at','as','by','from','get','got','will','would','should','when','what','why',
  'how','after','into','out','up','down','me','you','your','their','there','they',
])

/**
 * Lowercase, strip punctuation, drop stopwords and 1-2 character tokens.
 * `$`, `.`, `-` and `_` survive so error codes stay intact.
 */
export function tokenise(s: string): string[] {
  if (!s) return []
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$._\- ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

/** Fraction of the query's distinct meaningful terms that appear in the document. */
export function coverage(query: string, doc: string): number {
  const terms = [...new Set(tokenise(query))]
  if (terms.length === 0) return 0
  const haystack = doc.toLowerCase()
  const hits = terms.filter((t) => haystack.includes(t)).length
  return Math.round((hits / terms.length) * 100) / 100
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tokenise.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/gate/tokenise.ts tests/tokenise.test.ts
git commit -m "feat: tokeniser and term-coverage scoring"
```

---

## Task 6: The relevance gate

**Files:**
- Create: `src/gate/decide.ts`
- Test: `tests/gate.test.ts`

**Interfaces:**
- Consumes: `tokenise`, `coverage` (Task 5), `Article` (Task 2)
- Produces: `type GateReason = 'too_few_tokens' | 'low_coverage' | 'model_declined' | 'platform_unavailable' | null`; `interface GateResult { answer: boolean; reason: GateReason; topCoverage: number }`; `decide(query: string, articles: Article[], opts: { minTokens: number; minCoverage: number }): GateResult`

This is layers 1 and 2 of D11. Layer 3 (the model declining) is handled in Task 8.

- [ ] **Step 1: Write the failing test**

`tests/gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decide } from '../src/gate/decide.js'
import type { Article } from '../src/connectors/types.js'

const opts = { minTokens: 2, minCoverage: 0.3 }
const art = (title: string, body = ''): Article => ({ id: 'x', title, body, url: 'u' })

describe('gate layer 1 — token guard', () => {
  it('declines greeting-only input', () => {
    const r = decide('Hi Team,', [], opts)
    expect(r.answer).toBe(false)
    expect(r.reason).toBe('too_few_tokens')
  })

  it('declines null-value tickets', () => {
    expect(decide('nan', [], opts).reason).toBe('too_few_tokens')
  })

  it('declines a two-word fragment below the floor', () => {
    expect(decide('Bky OLO', [], opts).reason).toBe('too_few_tokens')
  })
})

describe('gate layer 2 — coverage floor', () => {
  it('declines when no article is relevant enough', () => {
    const r = decide('what is the capital of France', [art('Feedback Mechanisms in Knowledge')], opts)
    expect(r.answer).toBe(false)
    expect(r.reason).toBe('low_coverage')
  })

  it('declines when the platform returned nothing', () => {
    expect(decide('printer jam in warehouse', [], opts).reason).toBe('low_coverage')
  })

  it('answers when the top article covers the query', () => {
    const r = decide('printer jam warehouse', [art('Printer jam', 'clear the warehouse printer')], opts)
    expect(r.answer).toBe(true)
    expect(r.reason).toBe(null)
    expect(r.topCoverage).toBe(1)
  })

  it('scores against the best article, not merely the first', () => {
    const r = decide('vpn connect failure', [art('Unrelated'), art('VPN connect failure guide')], opts)
    expect(r.answer).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/gate.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/gate/decide.ts`**

```ts
import type { Article } from '../connectors/types.js'
import { tokenise, coverage } from './tokenise.js'

export type GateReason =
  | 'too_few_tokens'
  | 'low_coverage'
  | 'model_declined'
  | 'platform_unavailable'
  | null

export interface GateResult {
  answer: boolean
  reason: GateReason
  topCoverage: number
}

/**
 * Mechanical layers 1 and 2 of the three-layer gate (D11).
 *
 * A single coverage threshold was measured and rejected: the in-scope and
 * out-of-scope distributions overlap. "Hi Team," scores 1.00, because after
 * stopword removal only one term remains and it appears in the article — hence
 * the token guard runs first and short-circuits before coverage is consulted.
 */
export function decide(
  query: string,
  articles: Article[],
  opts: { minTokens: number; minCoverage: number },
): GateResult {
  if (tokenise(query).length < opts.minTokens) {
    return { answer: false, reason: 'too_few_tokens', topCoverage: 0 }
  }

  const top = articles.reduce(
    (best, a) => Math.max(best, coverage(query, `${a.title} ${a.body}`)),
    0,
  )

  if (top < opts.minCoverage) {
    return { answer: false, reason: 'low_coverage', topCoverage: top }
  }
  return { answer: true, reason: null, topCoverage: top }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/gate.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/gate/decide.ts tests/gate.test.ts
git commit -m "feat: two mechanical layers of the relevance gate"
```

---

## Task 7: Gateway client, prompt assembly and citation verification

**Files:**
- Create: `src/llm/prompt.ts`, `src/llm/client.ts`
- Test: `tests/prompt.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1), `Article` (Task 2), `mask`/`log` (Task 1)
- Produces: `SYSTEM_PROMPT`; `buildContextBlock(articles: Article[]): string`; `parseCitations(answer: string): number[]`; `verifyCitations(cited: number[], supplied: Article[]): { sources: Article[]; fabricated: number[] }`; `stripCitationMarkup(answer: string): string`; `interface Turn { role: 'user' | 'assistant'; content: string }`; `makeLlm(cfg: Config): { preflight(): Promise<void>; answer(o: { question: string; articles: Article[]; history: Turn[]; model?: string }): Promise<{ text: string; model: string }> }`

- [ ] **Step 1: Write the failing test**

`tests/prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  buildContextBlock, parseCitations, verifyCitations, stripCitationMarkup,
} from '../src/llm/prompt.js'
import type { Article } from '../src/connectors/types.js'

const arts: Article[] = [
  { id: 'sysA', label: 'KB0010141', title: 'Epson printer', body: 'reseat the roll', url: 'uA' },
  { id: 'sysB', label: 'KB0010140', title: 'Zebra printer', body: 'check the label size', url: 'uB' },
]

describe('buildContextBlock', () => {
  it('labels articles [1]..[n]', () => {
    const b = buildContextBlock(arts)
    expect(b).toContain('[1]')
    expect(b).toContain('[2]')
    expect(b).toContain('Epson printer')
  })

  it('never puts ids in the prompt — labels are the citation key', () => {
    expect(buildContextBlock(arts)).not.toContain('sysA')
  })
})

describe('parseCitations', () => {
  it('extracts bracketed labels', () => {
    expect(parseCitations('Reseat the roll [1] then retry [2].')).toEqual([1, 2])
  })

  it('de-duplicates repeated citations', () => {
    expect(parseCitations('[1] and again [1]')).toEqual([1])
  })

  it('finds nothing when the model declines', () => {
    expect(parseCitations('NO_ANSWER_IN_KB')).toEqual([])
  })
})

describe('verifyCitations', () => {
  it('maps labels back to the supplied articles', () => {
    const { sources, fabricated } = verifyCitations([1], arts)
    expect(sources.map((s) => s.id)).toEqual(['sysA'])
    expect(fabricated).toEqual([])
  })

  it('strips citations outside the supplied set', () => {
    const { sources, fabricated } = verifyCitations([1, 7], arts)
    expect(sources.map((s) => s.id)).toEqual(['sysA'])
    expect(fabricated).toEqual([7])
  })

  it('returns no sources when nothing was cited', () => {
    expect(verifyCitations([], arts).sources).toEqual([])
  })
})

describe('stripCitationMarkup', () => {
  it('removes labels from the user-facing answer', () => {
    expect(stripCitationMarkup('Reseat the roll [1] then retry [2].')).toBe('Reseat the roll then retry.')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/prompt.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/llm/prompt.ts`**

```ts
import type { Article } from '../connectors/types.js'

export const SYSTEM_PROMPT = `You answer questions using ONLY the knowledge base articles supplied in the CONTEXT block.

Rules:
- Use only the supplied articles. Never use outside knowledge, even if you are confident.
- Cite every claim with the bracketed label of the article it came from, like [1] or [2].
- Cite ONLY labels that appear in the CONTEXT block.
- If the articles do not contain the answer, reply exactly: NO_ANSWER_IN_KB
- Be concise and practical. Prefer numbered steps when the article gives steps.`

/** Articles are labelled [1]..[n]. The model cites labels, never ids or numbers (D10). */
export function buildContextBlock(articles: Article[]): string {
  return articles.map((a, i) => `[${i + 1}] ${a.title}\n${a.body}`).join('\n\n---\n\n')
}

export function parseCitations(answer: string): number[] {
  const found = [...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]))
  return [...new Set(found)]
}

/** Intersects cited labels with those actually supplied. Anything else is fabricated. */
export function verifyCitations(
  cited: number[],
  supplied: Article[],
): { sources: Article[]; fabricated: number[] } {
  const sources: Article[] = []
  const fabricated: number[] = []
  for (const label of cited) {
    const a = supplied[label - 1]
    if (a) sources.push(a)
    else fabricated.push(label)
  }
  return { sources, fabricated }
}

/** Removes bracketed labels once sources are rendered separately. */
export function stripCitationMarkup(answer: string): string {
  return answer.replace(/\s*\[\d{1,2}\]/g, '').replace(/\s{2,}/g, ' ').trim()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/prompt.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Implement `src/llm/client.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../config.js'
import type { Article } from '../connectors/types.js'
import { SYSTEM_PROMPT, buildContextBlock } from './prompt.js'
import { log, mask } from '../log.js'

export interface Turn {
  role: 'user' | 'assistant'
  content: string
}

export function makeLlm(cfg: Config) {
  // Two env vars, standard SDK, no wrapper (nowstudio-reference §1).
  const client = new Anthropic({
    apiKey: cfg.anthropicApiKey,
    baseURL: cfg.anthropicBaseUrl,
  })

  return {
    /**
     * One cheap call against the configured model id. The gateway renames
     * models, and a wrong id produces a silent wrong answer rather than an
     * error — so this must fail the boot, loudly (spec §7 rule 2).
     */
    async preflight(): Promise<void> {
      try {
        await client.messages.create({
          model: cfg.claudeModel,
          max_tokens: 4,
          messages: [{ role: 'user', content: 'ping' }],
        })
        log('llm.preflight.ok', { model: cfg.claudeModel, baseUrl: cfg.anthropicBaseUrl })
      } catch (e) {
        throw new Error(
          `Gateway preflight failed for model '${cfg.claudeModel}' at ${cfg.anthropicBaseUrl} ` +
            `(key ${mask(cfg.anthropicApiKey)}). Model ids are gateway-specific — do not assume a ` +
            `public Anthropic id works. Original error: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    },

    async answer(opts: {
      question: string
      articles: Article[]
      history: Turn[]
      model?: string
    }): Promise<{ text: string; model: string }> {
      const model =
        opts.model && cfg.claudeModelChoices.includes(opts.model) ? opts.model : cfg.claudeModel

      const messages: Turn[] = [
        ...opts.history.slice(-6),
        {
          role: 'user',
          content: `CONTEXT:\n\n${buildContextBlock(opts.articles)}\n\nQUESTION: ${opts.question}`,
        },
      ]

      const res = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      })

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')

      return { text, model }
    },
  }
}
```

- [ ] **Step 6: Verify preflight against the live gateway**

Requires `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and `CLAUDE_MODEL` in `.env` — the one outstanding input in spec §17.

```bash
npx tsx -e "import {loadConfig} from './src/config.js';import {makeLlm} from './src/llm/client.js';makeLlm(loadConfig()).preflight().then(()=>console.log('preflight OK')).catch(e=>{console.error(e.message);process.exit(1)})"
```

Expected: `preflight OK`. On failure the message names the model id and base URL — check the id against the gateway's configured list rather than assuming a public Anthropic id.

- [ ] **Step 7: Commit**

```bash
git add src/llm tests/prompt.test.ts
git commit -m "feat: gateway client, label-based prompting and citation verification"
```

---

## Task 8: Routes, app and boot

**Files:**
- Create: `src/server/routes.ts`, `src/server/app.ts`, `src/main.ts`
- Test: `tests/routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7
- Produces: `makeRoutes(deps): Router`; `makeApp(deps: { cfg: Config; connector: KnowledgeConnector; llm: Llm }): express.Express`. `POST /api/chat` returns `{ answer: string; sources: { id, label, title, url }[]; grounded: boolean; gateReason: GateReason }`. `GET /api/health` returns `{ ok, connector, platform, model, modelChoices }`.

- [ ] **Step 1: Write the failing test**

`tests/routes.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { makeApp } from '../src/server/app.js'
import { makeFakeConnector } from '../src/connectors/fake.js'
import { parseConfig } from '../src/config.js'
import type { Article } from '../src/connectors/types.js'
import { PlatformUnavailableError } from '../src/connectors/types.js'

const cfg = parseConfig({
  ANTHROPIC_API_KEY: 'sk-test-abcdefghijkl',
  ANTHROPIC_BASE_URL: 'https://llmproxy.example.com',
  CLAUDE_MODEL: 'm',
  SN_INSTANCE_URL: 'https://abhrademo4.service-now.com',
  SN_CLIENT_ID: 'c', SN_CLIENT_SECRET: 's', SN_REFRESH_TOKEN: 'r',
  SN_KB_ALLOWLIST: 'kb1',
})

const articles: Article[] = [
  { id: 'sysA', label: 'KB0010141', title: 'Printer jam warehouse', body: 'clear the warehouse printer jam', url: 'uA' },
]

const fakeLlm = (text: string) => ({
  preflight: async () => {},
  answer: async () => ({ text, model: 'm' }),
})

async function post(app: ReturnType<typeof makeApp>, body: unknown) {
  const server = createServer(app)
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as { port: number }
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as Record<string, never>
  server.close()
  return { status: res.status, json }
}

describe('POST /api/chat', () => {
  it('answers and returns verified sources', async () => {
    const app = makeApp({ cfg, connector: makeFakeConnector(articles), llm: fakeLlm('Clear the jam [1].') })
    const { json } = await post(app, { message: 'printer jam warehouse' })
    expect(json.grounded).toBe(true)
    expect((json.sources as { id: string }[])[0].id).toBe('sysA')
    expect(json.answer as string).not.toContain('[1]')
  })

  it('declines short input without calling the model', async () => {
    const llm = { preflight: async () => {}, answer: vi.fn() }
    const app = makeApp({ cfg, connector: makeFakeConnector(articles), llm: llm as never })
    const { json } = await post(app, { message: 'Hi Team,' })
    expect(json.grounded).toBe(false)
    expect(json.gateReason).toBe('too_few_tokens')
    expect(llm.answer).not.toHaveBeenCalled()
  })

  it('declines irrelevant questions without calling the model', async () => {
    const llm = { preflight: async () => {}, answer: vi.fn() }
    const app = makeApp({ cfg, connector: makeFakeConnector(articles), llm: llm as never })
    const { json } = await post(app, { message: 'what is the capital of France' })
    expect(json.gateReason).toBe('low_coverage')
    expect(llm.answer).not.toHaveBeenCalled()
  })

  it('honours the model declining even when the gate let it through', async () => {
    const app = makeApp({ cfg, connector: makeFakeConnector(articles), llm: fakeLlm('NO_ANSWER_IN_KB') })
    const { json } = await post(app, { message: 'printer jam warehouse' })
    expect(json.grounded).toBe(false)
    expect(json.gateReason).toBe('model_declined')
  })

  it('strips fabricated citations', async () => {
    const app = makeApp({ cfg, connector: makeFakeConnector(articles), llm: fakeLlm('Do this [1] and that [9].') })
    const { json } = await post(app, { message: 'printer jam warehouse' })
    expect(json.sources).toHaveLength(1)
  })

  it('reports an unreachable platform differently from no match', async () => {
    const broken = {
      name: 'broken',
      search: async () => { throw new PlatformUnavailableError('instance down') },
      health: async () => ({ ok: false }),
    }
    const app = makeApp({ cfg, connector: broken, llm: fakeLlm('x') })
    const { status, json } = await post(app, { message: 'printer jam warehouse' })
    expect(status).toBe(503)
    expect(json.gateReason).toBe('platform_unavailable')
    expect(json.answer as string).toMatch(/reach the knowledge base/i)
  })

  it('rejects oversized input before searching', async () => {
    const app = makeApp({ cfg, connector: makeFakeConnector(articles), llm: fakeLlm('x') })
    const { status } = await post(app, { message: 'x'.repeat(5000) })
    expect(status).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/routes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/server/routes.ts`**

```ts
import { Router } from 'express'
import type { Config } from '../config.js'
import type { Article, KnowledgeConnector } from '../connectors/types.js'
import { PlatformUnavailableError } from '../connectors/types.js'
import { decide } from '../gate/decide.js'
import { parseCitations, verifyCitations, stripCitationMarkup } from '../llm/prompt.js'
import type { Turn } from '../llm/client.js'
import { log } from '../log.js'

const MAX_MESSAGE_LENGTH = 2000
const DECLINE_TEXT = 'I do not have that in the knowledge base.'
const UNAVAILABLE_TEXT = 'I cannot reach the knowledge base right now. Please try again shortly.'

export interface Llm {
  preflight(): Promise<void>
  answer(o: {
    question: string
    articles: Article[]
    history: Turn[]
    model?: string
  }): Promise<{ text: string; model: string }>
}

export function makeRoutes(deps: { cfg: Config; connector: KnowledgeConnector; llm: Llm }): Router {
  const { cfg, connector, llm } = deps
  const conversations = new Map<string, Turn[]>()
  const router = Router()

  router.get('/health', async (_req, res) => {
    const platform = await connector.health()
    res.json({
      ok: platform.ok,
      connector: connector.name,
      platform,
      model: cfg.claudeModel,
      modelChoices: cfg.claudeModelChoices,
    })
  })

  router.post('/chat', async (req, res, next) => {
    try {
      const message = String(req.body?.message ?? '').trim()
      const conversationId = String(req.body?.conversationId ?? 'default')
      const model = req.body?.model ? String(req.body.model) : undefined
      const started = Date.now()
      const opts = { minTokens: cfg.gateMinTokens, minCoverage: cfg.gateMinCoverage }

      if (!message) return res.status(400).json({ error: 'message is required' })
      if (message.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `message exceeds ${MAX_MESSAGE_LENGTH} characters` })
      }

      // Layer 1 runs before any network call — noise must never reach the instance.
      const pre = decide(message, [], opts)
      if (!pre.answer && pre.reason === 'too_few_tokens') {
        log('chat', { q: message, gate: pre.reason, ms: Date.now() - started })
        return res.json({ answer: DECLINE_TEXT, sources: [], grounded: false, gateReason: pre.reason })
      }

      let articles: Article[]
      try {
        articles = await connector.search(message, cfg.searchLimit)
      } catch (e) {
        if (e instanceof PlatformUnavailableError) {
          log('chat.platform_unavailable', { q: message, detail: e.message })
          return res.status(503).json({
            answer: UNAVAILABLE_TEXT, sources: [], grounded: false, gateReason: 'platform_unavailable',
          })
        }
        throw e
      }

      // Layer 2.
      const gate = decide(message, articles, opts)
      if (!gate.answer) {
        log('chat', {
          q: message, candidates: articles.map((a) => a.label), cov: gate.topCoverage,
          gate: gate.reason, ms: Date.now() - started,
        })
        return res.json({ answer: DECLINE_TEXT, sources: [], grounded: false, gateReason: gate.reason })
      }

      const history = conversations.get(conversationId) ?? []
      const { text, model: used } = await llm.answer({ question: message, articles, history, model })

      // Layer 3.
      if (text.includes('NO_ANSWER_IN_KB')) {
        log('chat', {
          q: message, cov: gate.topCoverage, gate: 'model_declined', model: used, ms: Date.now() - started,
        })
        return res.json({
          answer: DECLINE_TEXT, sources: [], grounded: false, gateReason: 'model_declined',
        })
      }

      const { sources, fabricated } = verifyCitations(parseCitations(text), articles)
      if (fabricated.length) log('chat.fabricated_citation', { q: message, labels: fabricated })

      conversations.set(
        conversationId,
        [...history, { role: 'user' as const, content: message }, { role: 'assistant' as const, content: text }].slice(-12),
      )

      log('chat', {
        q: message, candidates: articles.map((a) => a.label), cov: gate.topCoverage,
        gate: 'answered', cited: sources.map((s) => s.label), model: used, ms: Date.now() - started,
      })

      res.json({
        answer: stripCitationMarkup(text),
        sources: sources.map((s) => ({ id: s.id, label: s.label, title: s.title, url: s.url })),
        grounded: true,
        gateReason: null,
      })
    } catch (e) {
      next(e)
    }
  })

  return router
}
```

- [ ] **Step 4: Implement `src/server/app.ts`**

```ts
import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Config } from '../config.js'
import type { KnowledgeConnector } from '../connectors/types.js'
import { makeRoutes, type Llm } from './routes.js'
import { log } from '../log.js'

const here = dirname(fileURLToPath(import.meta.url))

export function makeApp(deps: { cfg: Config; connector: KnowledgeConnector; llm: Llm }) {
  const app = express()
  app.use(express.json({ limit: '64kb' }))
  app.use('/api', makeRoutes(deps))
  app.use(express.static(join(here, '../../public')))

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log('error.unhandled', { message: err.message })
    res.status(500).json({ error: 'internal error' })
  })

  return app
}
```

- [ ] **Step 5: Implement `src/main.ts`**

```ts
import { loadConfig } from './config.js'
import { getConnector } from './connectors/index.js'
import { makeLlm } from './llm/client.js'
import { makeApp } from './server/app.js'
import { log } from './log.js'

async function main() {
  const cfg = loadConfig()

  const llm = makeLlm(cfg)
  await llm.preflight() // fails the boot on a bad model id or key

  const connector = getConnector(cfg)
  const health = await connector.health()
  if (!health.ok) {
    throw new Error(`Connector '${connector.name}' is not reachable: ${health.detail}`)
  }
  log('connector.ok', { connector: connector.name, detail: health.detail })

  makeApp({ cfg, connector, llm }).listen(cfg.port, () => {
    log('listening', { port: cfg.port, connector: connector.name, model: cfg.claudeModel })
  })
}

main().catch((e) => {
  console.error(`\nSTARTUP FAILED\n${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
```

- [ ] **Step 6: Run to verify the tests pass**

Run: `npx vitest run tests/routes.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 7: Commit**

```bash
git add src/server src/main.ts tests/routes.test.ts
git commit -m "feat: chat and health routes with three-layer gate wiring"
```

---

## Task 9: Chat UI with the three-state source line

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/styles.css`

**Interfaces:**
- Consumes: `POST /api/chat`, `GET /api/health` (Task 8)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NowOps Assistant</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header>
    <h1>NowOps Assistant</h1>
    <select id="model" aria-label="Model"></select>
    <span id="health" class="pill">checking…</span>
  </header>

  <main id="log" aria-live="polite"></main>

  <form id="composer">
    <input id="q" autocomplete="off" placeholder="Ask about the knowledge base…" />
    <button>Send</button>
  </form>

  <script src="app.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/styles.css`**

```css
:root { --bg:#0f1115; --panel:#171a21; --ink:#e8eaed; --muted:#9aa4b2; --accent:#5b9dff; --warn:#e0a458; }
* { box-sizing:border-box; }
body { margin:0; font:15px/1.55 "Segoe UI",system-ui,sans-serif; background:var(--bg); color:var(--ink);
       display:flex; flex-direction:column; height:100vh; }
header { display:flex; gap:.75rem; align-items:center; padding:.75rem 1rem; border-bottom:1px solid #262b35; }
h1 { font-size:1rem; margin:0; flex:1; font-weight:600; }
select { background:var(--panel); color:var(--ink); border:1px solid #2b3240; border-radius:6px; padding:.3rem; }
.pill { font-size:.75rem; color:var(--muted); border:1px solid #2b3240; border-radius:999px; padding:.15rem .6rem; }
.pill.ok { color:#7ee787; border-color:#2ea04326; }
.pill.bad { color:#ff7b72; border-color:#ff7b7226; }
main { flex:1; overflow-y:auto; padding:1rem; display:flex; flex-direction:column; gap:.9rem; }
.msg { max-width:46rem; }
.msg.user { align-self:flex-end; background:#22304a; padding:.55rem .8rem; border-radius:10px 10px 2px 10px; }
.msg.bot { align-self:flex-start; background:var(--panel); padding:.55rem .8rem; border-radius:10px 10px 10px 2px; white-space:pre-wrap; }
.sources { font-size:.78rem; color:var(--muted); margin-top:.45rem; }
.sources a { color:var(--accent); text-decoration:none; }
.sources a:hover { text-decoration:underline; }
.sources.none { color:var(--warn); }
form { display:flex; gap:.5rem; padding:.75rem 1rem; border-top:1px solid #262b35; }
input { flex:1; background:var(--panel); border:1px solid #2b3240; color:var(--ink); padding:.6rem .8rem; border-radius:8px; }
button { background:var(--accent); border:0; color:#08121f; font-weight:600; padding:.6rem 1.1rem; border-radius:8px; cursor:pointer; }
.typing { color:var(--muted); font-style:italic; }
```

- [ ] **Step 3: Create `public/app.js`**

The three source-line states come from spec §12.

```js
const logEl = document.getElementById('log')
const form = document.getElementById('composer')
const input = document.getElementById('q')
const modelSel = document.getElementById('model')
const healthEl = document.getElementById('health')
const conversationId = crypto.randomUUID()

function bubble(cls, text) {
  const el = document.createElement('div')
  el.className = `msg ${cls}`
  el.textContent = text
  logEl.appendChild(el)
  logEl.scrollTop = logEl.scrollHeight
  return el
}

function renderSources(el, data) {
  const line = document.createElement('div')
  line.className = 'sources'

  if (!data.grounded || !data.sources || data.sources.length === 0) {
    line.classList.add('none')
    line.textContent =
      data.gateReason === 'platform_unavailable'
        ? 'Knowledge base unreachable — not answered'
        : 'No knowledge base match — not answered'
  } else {
    line.append('Sources: ')
    data.sources.forEach((s, i) => {
      if (i) line.append(' · ')
      const a = document.createElement('a')
      a.href = s.url
      a.target = '_blank'
      a.rel = 'noopener'
      a.textContent = s.label || s.title
      a.title = s.title
      line.appendChild(a)
    })
  }
  el.appendChild(line)
}

async function loadHealth() {
  try {
    const h = await (await fetch('/api/health')).json()
    healthEl.textContent = h.ok ? `${h.connector} ready` : `${h.connector} unreachable`
    healthEl.className = `pill ${h.ok ? 'ok' : 'bad'}`
    modelSel.innerHTML = ''
    for (const m of h.modelChoices ?? [h.model]) {
      const o = document.createElement('option')
      o.value = m
      o.textContent = m
      modelSel.appendChild(o)
    }
  } catch {
    healthEl.textContent = 'server unreachable'
    healthEl.className = 'pill bad'
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const message = input.value.trim()
  if (!message) return
  input.value = ''
  bubble('user', message)

  const pending = bubble('bot typing', 'Searching the knowledge base…')

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, conversationId, model: modelSel.value }),
    })
    const data = await res.json()
    pending.className = 'msg bot'
    pending.textContent = data.answer ?? data.error ?? 'No response.'
    renderSources(pending, data)
  } catch {
    pending.className = 'msg bot'
    pending.textContent = 'Request failed.'
  }
})

loadHealth()
```

- [ ] **Step 4: Verify by hand**

```bash
npm run dev
```

Open `http://localhost:3000` and check all three states:

1. `Self-checkout lanes 1-4 down at Store #208 after image push` → an answer with a linked source; the link opens KB0010141 in abhrademo4
2. `Hi Team,` → "No knowledge base match — not answered"
3. `what is the capital of France` → the same decline

- [ ] **Step 5: Commit**

```bash
git add public
git commit -m "feat: chat UI with three-state source line"
```

---

## Task 10: Eval and calibration tooling

**Files:**
- Create: `tools/eval.ts`, `tools/calibrate.ts`
- Modify: `tests/fixtures/retrieval-eval.json` (only if a mapping proves wrong)

**Interfaces:**
- Consumes: `getConnector` (Task 2), `coverage`/`tokenise` (Task 5), the eval fixture
- Produces: `npm run eval`, `npm run calibrate`

These are the platform-agnostic instruments from spec §19: they take a connector and an eval file, so a future Jira connector reuses them unchanged.

- [ ] **Step 1: Implement `tools/eval.ts`**

```ts
import { readFileSync } from 'node:fs'
import { loadConfig } from '../src/config.js'
import { getConnector } from '../src/connectors/index.js'
import { coverage } from '../src/gate/tokenise.js'

interface EvalQ {
  id: string
  source: string
  confidence?: string
  question: string
  expectedSysId?: string
  acceptableSysIds?: string[]
}

/** Baseline from spec §9. Falling below this is a regression. */
const BASELINE_AT1 = 26

const cfg = loadConfig()
const connector = getConnector(cfg)
const data = JSON.parse(readFileSync('tests/fixtures/retrieval-eval.json', 'utf8')) as {
  inScope: EvalQ[]
  outOfScope: EvalQ[]
}

const accept = (q: EvalQ) => q.acceptableSysIds ?? (q.expectedSysId ? [q.expectedSysId] : [])

async function main() {
  const ranks: { id: string; rank: number; source: string }[] = []

  console.log('=== IN-SCOPE ===')
  for (const q of data.inScope) {
    const results = await connector.search(q.question, cfg.searchLimit)
    const ok = accept(q)
    const rank = results.findIndex((a) => ok.includes(a.id)) + 1
    ranks.push({ id: q.id, rank, source: q.source })

    const cov = results.length ? coverage(q.question, `${results[0].title} ${results[0].body}`) : 0
    console.log(
      `${q.id.padEnd(9)} ${(rank ? `#${rank}` : 'MISS').padEnd(6)} cov=${cov} ${results[0]?.label ?? '-'}`,
    )
  }

  console.log('\n=== OUT-OF-SCOPE ===')
  for (const q of data.outOfScope) {
    const results = await connector.search(q.question, cfg.searchLimit)
    const cov = results.length ? coverage(q.question, `${results[0].title} ${results[0].body}`) : 0
    console.log(`${q.id.padEnd(12)} n=${results.length} cov=${cov} ${results[0]?.label ?? '-'}`)
  }

  const n = ranks.length
  const at = (k: number) => ranks.filter((r) => r.rank >= 1 && r.rank <= k).length
  const bySrc = (s: string) => {
    const all = ranks.filter((r) => r.source === s)
    return `${all.filter((r) => r.rank >= 1).length}/${all.length}`
  }

  console.log('\n=== SUMMARY ===')
  console.log(`Recall@1 : ${at(1)}/${n} (${Math.round((100 * at(1)) / n)}%)`)
  console.log(`Recall@5 : ${at(5)}/${n} (${Math.round((100 * at(5)) / n)}%)`)
  console.log(`incident : ${bySrc('incident')}   synthetic: ${bySrc('synthetic')}`)
  console.log(`Misses   : ${ranks.filter((r) => !r.rank).map((r) => r.id).join(', ') || 'none'}`)

  if (at(1) < BASELINE_AT1) {
    console.error(`\nREGRESSION: recall@1 ${at(1)} is below the recorded baseline of ${BASELINE_AT1}`)
    process.exit(1)
  }
}

main()
```

- [ ] **Step 2: Implement `tools/calibrate.ts`**

```ts
import { readFileSync } from 'node:fs'
import { loadConfig } from '../src/config.js'
import { getConnector } from '../src/connectors/index.js'
import { coverage, tokenise } from '../src/gate/tokenise.js'

const cfg = loadConfig()
const connector = getConnector(cfg)
const data = JSON.parse(readFileSync('tests/fixtures/retrieval-eval.json', 'utf8')) as {
  inScope: { question: string }[]
  outOfScope: { question: string }[]
}

/** -1 means the token guard caught it before coverage was ever consulted. */
async function topCoverage(question: string): Promise<number> {
  if (tokenise(question).length < cfg.gateMinTokens) return -1
  const r = await connector.search(question, cfg.searchLimit)
  return r.length ? coverage(question, `${r[0].title} ${r[0].body}`) : 0
}

async function main() {
  const inCov: number[] = []
  for (const q of data.inScope) inCov.push(await topCoverage(q.question))
  const outCov: number[] = []
  for (const q of data.outOfScope) outCov.push(await topCoverage(q.question))

  const guarded = outCov.filter((c) => c === -1).length
  console.log(`Connector: ${connector.name}`)
  console.log(`Token guard alone rejects ${guarded}/${outCov.length} noise questions\n`)
  console.log('cutoff  keeps(good)  rejects(noise)  score')

  let best = { cutoff: cfg.gateMinCoverage, score: -1 }
  for (let c = 0.1; c <= 0.9001; c += 0.05) {
    const cutoff = Math.round(c * 100) / 100
    const keeps = inCov.filter((v) => v >= cutoff).length
    const rejects = outCov.filter((v) => v < cutoff).length
    // Keeping good answers and rejecting noise are weighted equally.
    const score = keeps / inCov.length + rejects / outCov.length
    console.log(
      `${String(cutoff).padEnd(7)} ${`${keeps}/${inCov.length}`.padEnd(12)} ` +
        `${`${rejects}/${outCov.length}`.padEnd(15)} ${score.toFixed(3)}`,
    )
    if (score > best.score) best = { cutoff, score }
  }

  console.log(`\nRecommended GATE_MIN_COVERAGE=${best.cutoff}`)
  console.log(`Currently configured: ${cfg.gateMinCoverage}`)
}

main()
```

- [ ] **Step 3: Run both tools live**

```bash
npm run eval
npm run calibrate
```

Expected from `npm run eval`: recall@1 at or above **26/35 (74%)** and recall@5 at or above **29/35 (83%)** — the spec §9 baseline. A lower number exits non-zero; investigate rather than lowering the baseline.

Expected from `npm run calibrate`: a sweep table and a recommended cutoff. If it differs materially from `0.3`, update `GATE_MIN_COVERAGE` in `.env` and record the change in spec §9.

- [ ] **Step 4: Commit**

```bash
git add tools
git commit -m "feat: platform-agnostic eval and calibration tooling"
```

---

## Task 11: Seam proof and acceptance run

**Files:**
- Create: `tests/seam.test.ts`

**Interfaces:**
- Consumes: everything
- Produces: evidence that spec §16 acceptance criteria hold

- [ ] **Step 1: Write the seam test**

This is acceptance criterion 10 — proof that D12 is real rather than decorative.

`tests/seam.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) return tsFilesUnder(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

describe('connector seam (D12)', () => {
  it('no module above the seam imports ServiceNow code', () => {
    const guarded = ['src/gate', 'src/llm', 'src/server']
    const offenders: string[] = []

    for (const dir of guarded) {
      for (const file of tsFilesUnder(dir)) {
        if (/from ['"].*connectors\/servicenow/.test(readFileSync(file, 'utf8'))) {
          offenders.push(file)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('only connectors/index.ts names a concrete connector', () => {
    expect(readFileSync('src/connectors/index.ts', 'utf8')).toContain('servicenow')
  })
})
```

- [ ] **Step 2: Run the whole suite and a type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 3: Walk the acceptance criteria (spec §16)**

Record the outcome of each:

- [ ] 1. `npm run dev` boots; gateway preflight passes; the ServiceNow probe succeeds
- [ ] 2. `/api/health` shows gateway reachable, model id, ServiceNow reachable
- [ ] 3. Five known questions answer correctly with working links. Use `inc-01`, `inc-04`, `inc-06`, `syn-09`, `syn-18` from the eval fixture
- [ ] 4. `Hi Team,` gives `too_few_tokens` and `what is the capital of France` gives `low_coverage`; neither calls the model (confirm in the logs)
- [ ] 5. Temporarily set `SN_INSTANCE_URL=https://invalid.example.com` and confirm the reply is "cannot reach the knowledge base", **not** "no match". Restore afterwards
- [ ] 6. The model picker switches models and answers still ground
- [ ] 7. No secrets in captured logs — search them for `sk-` and for the client id
- [ ] 8. `npm run eval` meets or beats 26/35 recall@1
- [ ] 9. `npm run calibrate` emits a recommendation
- [ ] 10. `npx vitest run tests/seam.test.ts` passes

- [ ] **Step 4: Commit**

```bash
git add tests/seam.test.ts
git commit -m "test: prove the connector seam and complete the acceptance run"
```

---

## Things that will bite you

- **Use `Article.id`, never `label`.** `KB0010004` maps to four different articles on abhrademo4 and `KB0010141` to two. Any lookup, comparison or link keyed on the number is a bug waiting for a demo.
- **Gateway model ids are renamed by LiteLLM.** A wrong id fails at *runtime with a plausible answer*, not at startup — which is why preflight exists. Never hardcode a public Anthropic id as a fallback.
- **`123TEXTQUERY321` needs sanitising.** A `^` or `=` in the user's question breaks `sysparm_query` and produces confusing results rather than an error.
- **Layer 1 of the gate runs before searching.** Do not "simplify" by searching first — greeting-shaped noise should never reach the instance or the model.
- **Expect most real traffic to be declined.** Of 36,023 incidents on abhrademo4, most are monitoring alerts and fragments. A high decline rate is the system working (spec §9).
- **PowerShell's single-object trap**, if you extend tooling in PS rather than TS: a one-element result is a scalar and `.Count` is `$null`, which silently scores every one-result query as a miss. Always `@()`-wrap.
- **`.env` holds live secrets** and is gitignored. Check `git status` before `git add -A`.

---

## Spec coverage

| Spec section | Tasks |
|---|---|
| §4 architecture | 2, 8 |
| §5 decisions | D1 T1 · D2 T4 · D3 T9 · D4 T6, T8 · D5 T1 · D6 T8 · D7 T4 · D8 T1 · D9 T1, T4 · D10 T4, T7 · D11 T6, T8 · D12 T2, T11 |
| §6 layout | 1-10 |
| §7 config and gateway rules | 1, 7 |
| §8 ServiceNow search | 3, 4 |
| §9 gate and eval | 6, 10 |
| §10 prompt and citations | 7 |
| §11 API contract | 8 |
| §12 frontend | 9 |
| §13 error handling | 3, 4, 8 |
| §14 observability | 1, 8 |
| §15 testing | every task |
| §16 acceptance | 11 |
| §19 portability | 2, 10, 11 |
