# NowOps Chatbot V2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small Express/TypeScript chatbot that answers two kinds of question about the abhrademo4 ServiceNow instance — "how do I…" from the knowledge base, and "how many…" by running a live aggregate query — always showing the articles or the query behind the answer.

**Architecture:** Nine source files. `servicenow/` searches articles and runs aggregates, `llm/` asks Claude once and interprets its reply, `server.ts` wires it to a static HTML page. No database, no index, no embeddings, no catalogue, no abstraction layers — ServiceNow is the only platform and the code says so directly.

**Tech Stack:** Node 22+ (dev machine runs v24.18.0), TypeScript (ESM, `NodeNext`), Express 5, `@anthropic-ai/sdk`, `zod`; dev-only `tsx`, `vitest`, `typescript`, `@types/*`. `.env` is loaded by Node's own `--env-file`, not by a library. **There is no build step**: the app runs under `tsx` in every environment and `tsc --noEmit` is the type check, covering `src/`, `tools/` and `tests/`.

**Spec:** [docs/superpowers/specs/2026-09-13-nowops-chatbot-design.md](../specs/2026-09-13-nowops-chatbot-design.md) (revision 10)

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 22 LTS floor.** `.nvmrc` pins `22`; `package.json` sets `"engines": { "node": ">=22" }`.
- **Runtime dependencies are exactly three:** `express`, `@anthropic-ai/sdk`, `zod`. Dev-only: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/express`. **Adding any other dependency is a plan violation** — raise it rather than installing it. In particular **not `dotenv`**: Node 20.6+ reads `.env` itself via `--env-file`, so every script passes that flag.
- **Only two things are configurable:** `RETRY_ENABLED` and `LLM_MODE`, plus credentials and `PORT`. Everything else is a `const` in the file that uses it — `MIN_TOKENS` in `guard.ts`, `SEARCH_LIMIT` in `search.ts`, `TIMEOUT_MS` in `servicenow/client.ts`. Do not promote a constant to an env var without someone actually needing to change it at runtime.
- **There is no `METRICS_ENABLED`.** The article path's regression check is `npm run eval` against the recorded 26/35 baseline, not a flag — a flag can drift from what it claims to reproduce.
- **ServiceNow is the only platform.** No connector interface, no platform selector, no fake connector module, no "pluggable" indirection (D12).
- **`Article.id` (ServiceNow `sys_id`) is the identity key everywhere** (D10). Article `number` is **not unique** on abhrademo4 — `KB0010004` maps to four different articles. `number` is a display label only. Links use `kb_view.do?sys_kb_id=<sys_id>`.
- **The model cites bracketed labels `[1]`–`[5]`, never KB numbers** (D10). The server maps labels back to `sys_id`.
- **There is no knowledge base filter** (D5). Search every published article. A curated allowlist was A/B tested over all 45 eval questions and changed exactly one result. Do not reintroduce one without a failing example.
- **One Claude call per question** (D6, D16), two only when the first returns `SEARCH`. There is no separate triage call and no classifier call.
- **There is no coverage threshold** (D11, removed in rev 8). Two gate layers only: the token guard, then Claude. Do not reintroduce a coverage score — the sweep in spec §9 shows no cutoff works.
- **The model never builds a request.** For metrics it returns `table`, `filter`, `aggregate` and optionally `field` as *data*. Our code builds the URL, and it can only build a read-only `GET` to `/api/now/stats/` (D14).
- **`aggregate` must be one of `count`, `avg`, `sum`, `min`, `max`.** Anything else is a decline, not a coercion.
- **A malformed filter is never repaired.** Prose is stopped by a clause-shape check before any request (ServiceNow silently ignores it and returns the whole table — measured); anything ServiceNow itself rejects, we decline. A second guess at a query is a second chance to be confidently wrong.
- **A `GROUPBY` filter is declined at parse time.** `/stats/` ignores it and returns the total, which is a right number for the wrong question. Series are out of scope.
- **The parser tolerates formatting noise, never intent changes.** Code fences, a preamble line, `METRIC:` with a colon, `COUNT` in uppercase and chatter after the JSON are all read as intended. An unknown verb, an aggregate outside the five, a missing table or a non-JSON body are still declines.
- **The token guard has no stopword list.** It counts words of three or more characters and requires two. A stopword list declined *"how many incidents"* for free.
- **Every metric answer renders its filter.** Wrap it; never truncate it. The filter is the only thing that makes the number checkable.
- **There is no table allowlist.** The OAuth user's ACLs are the access boundary. An allowlist would block legitimate questions while adding no protection. The table name **is** shape-checked (`^[a-z0-9_]+$`) because it is interpolated into a URL path — that is input validation at a trust boundary, not a list of permitted tables.
- **One ServiceNow client.** `makeSnClient` owns the OAuth token cache, the bearer header, the request timeout and the error mapping. Search and stats both call it; neither builds its own token provider or its own `fetch`.
- **Never log secrets.** Mask API keys as `sk-abc12…wxyz`.
- **`.env` is never committed.** `.gitignore` already covers it.
- **"Cannot reach ServiceNow" and "no match" are different outcomes** (spec §13) — different message, different `gateReason`, different HTTP status.
- **Retry fires at most once per question** (D13). The second call may return `ANSWER` or `NO_ANSWER`, never another `SEARCH`.

### Starting state

The repo holds only: `.env` (live ServiceNow credentials), `.gitignore`, `docs/`, `tests/fixtures/retrieval-eval.json`, and `tools/set-gateway-env.ps1`. There is no `src/`, no `package.json`, no `node_modules`. Task 1 starts from nothing.

### Building without the gateway key

The UST gateway key lives in Azure Key Vault (`ustdev-az-is-ai-app-kv`, secret `codon-kvs`) and access has not been granted. **Every task can still be built and verified**, because only live Claude calls are blocked:

| | Without the key |
|---|---|
| Tasks 1, 2, 3 | Fully complete, including live ServiceNow verification |
| Task 4 | All unit tests pass. Only the live preflight waits |
| Task 5 | All tests pass — they use a fake Claude |
| Task 6 | Runs under `LLM_MODE=stub`, **including the metric path** |
| Task 7 | `npm run eval` works. `--with-retry` and `--metrics` wait |

Set these in `.env` to build now:

```
LLM_MODE=stub
ANTHROPIC_API_KEY=placeholder-not-yet-available
ANTHROPIC_BASE_URL=https://llmproxy.ustdev.com
CLAUDE_MODEL=claude-opus-4-8-Codon
```

`ANTHROPIC_API_KEY` must be non-empty because config validation requires it, but nothing reads it in stub mode.

**Stub mode is deliberately conspicuous**: a console warning at boot, a `llm.STUB_MODE` log line on every answer, an amber health pill in the UI, and answers prefixed `[STUB — no live model]`. The stub returns a fixed `METRIC` reply for questions containing "how many", so the aggregate path can be exercised end-to-end with real numbers before the key arrives. That is a fixture, not intelligence.

When the key arrives: run `.\tools\set-gateway-env.ps1`, set `LLM_MODE=live`, then do Task 4 step 5 and Task 7 step 3. Nothing else changes.

---

## File Structure

Nine source files, three static assets, one tool.

| File | Responsibility |
|---|---|
| `src/config.ts` | Load + validate env with zod; fail fast |
| `src/log.ts` | One-line JSON logging, masks secrets |
| `src/guard.ts` | Tokenise + token-count guard (gate layer 1) |
| `src/servicenow/types.ts` | `Article` record + `ServiceNowUnavailableError` |
| `src/servicenow/client.ts` | OAuth refresh-token grant, cached token, one authenticated `get(path)` with timeout |
| `src/servicenow/search.ts` | Live `kb_knowledge` text search → `Article[]` |
| `src/servicenow/stats.ts` | Run one aggregate → value + deep link |
| `src/llm/client.ts` | Gateway client, preflight, one prompt, reply parsing, citation checks |
| `src/server.ts` | Express app, `/api/chat`, `/api/health`, boot |
| `public/index.html`, `app.js`, `styles.css` | Chat UI with the source line |
| `tools/eval.ts` | `npm run eval` — recall@k; `--with-retry` and `--metrics` modes |

`guard.ts` is one file of ~30 pure lines. The LLM client is one file: the prompt, the call and the reply parsing belong to the same job. `server.ts` holds the routes and the boot sequence because there is one route worth the name.

---

## Task 1: Scaffold, config, logging and the token guard

**Files:**
- Create: `package.json`, `tsconfig.json`, `.nvmrc`, `.env.example`, `src/config.ts`, `src/log.ts`, `src/guard.ts`
- Test: `tests/config.test.ts`, `tests/guard.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadConfig(): Config`, `parseConfig(env): Config`, `Config` interface; `log(event, fields)`, `mask(secret)`; `tokenise(s): string[]`, `hasEnoughTokens(s, min): boolean`

- [x] **Step 1: Initialise the project**

```bash
npm init -y
npm pkg set type=module engines.node=">=22"
npm pkg set scripts.dev="tsx watch --env-file=.env src/server.ts"
npm pkg set scripts.start="tsx --env-file=.env src/server.ts"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.typecheck="tsc --noEmit"
npm pkg set scripts.eval="tsx --env-file=.env tools/eval.ts"
npm i express @anthropic-ai/sdk zod
npm i -D typescript tsx vitest @types/node @types/express
node -e "require('fs').writeFileSync('.nvmrc','22\n')"
```

- [x] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tools/**/*.ts", "tests/**/*.ts"]
}
```

`"types": ["node"]` is required: the installed TypeScript (7.x) does not pick up `@types/node` automatically and `process` is otherwise unresolved.

`noEmit` because nothing is compiled — `tsx` runs the source. `tests/` is included so a test that calls a function with the wrong arguments fails `npm run typecheck` instead of silently passing under vitest, which strips types without checking them. `noUncheckedIndexedAccess` matters here: `articles[0]` is `Article | undefined`, which forces the empty-result case to be handled rather than discovered in a demo.

- [x] **Step 3: Write the failing tests**

`tests/config.test.ts`:

```ts
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
    expect(() => parseConfig({})).toThrow(/ANTHROPIC_API_KEY.*SN_REFRESH_TOKEN|SN_REFRESH_TOKEN/s)
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
```

`tests/guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { tokenise, hasEnoughTokens } from '../src/guard.js'

describe('tokenise', () => {
  it('drops stopwords and 1-2 character tokens', () => {
    expect(tokenise('How do I reset my SAP password')).toEqual(['reset', 'sap', 'password'])
  })

  it('keeps characters that appear in error codes', () => {
    expect(tokenise('ORA-01017 invalid $HOME path')).toEqual(['ora-01017', 'invalid', '$home', 'path'])
  })

  it('returns nothing for empty input', () => {
    expect(tokenise('')).toEqual([])
  })
})

describe('hasEnoughTokens', () => {
  it('rejects greeting noise before any network call', () => {
    expect(hasEnoughTokens('Hi Team,')).toBe(false)
    expect(hasEnoughTokens('nan')).toBe(false)
  })

  it('lets a two-token fragment through to Claude', () => {
    // 'Bky OLO' is two 3-character tokens, exactly at the floor. Layer 2 handles it —
    // the guard exists only for one-term noise.
    expect(hasEnoughTokens('Bky OLO')).toBe(true)
  })

  it('accepts a real question', () => {
    expect(hasEnoughTokens('how many open incidents are there')).toBe(true)
  })
})
```

- [x] **Step 4: Run to verify they fail**

Run: `npx vitest run`
Expected: FAIL — cannot resolve `../src/config.js`, `../src/log.js`, `../src/guard.js`

- [x] **Step 5: Implement `src/log.ts`**

```ts
/** Masks a secret for logs: sk-abcdefghijklmnop -> sk-ab…mnop */
export function mask(secret: string): string {
  if (!secret || secret.length < 12) return '…'
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`
}

/** One-line JSON log. Callers never pass a secret; anything that must appear goes through mask(). */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
}
```

- [x] **Step 6: Implement `src/guard.ts`**

```ts
const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','to','of','in','on','for','and','or','it','this',
  'that','with','my','we','our','not','no','be','been','has','have','do','does','did','can',
  'cannot','am','at','as','by','from','get','got','will','would','should','when','what','why',
  'how','after','into','out','up','down','me','you','your','their','there','they','many',
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

/** Two real words. Not configurable: nobody has ever wanted a different number. */
const MIN_TOKENS = 2

/**
 * Gate layer 1 (D11). Runs before any network call, so greeting-shaped noise
 * never reaches the instance or the model. This is the only free rejection
 * left — everything else costs one Claude call.
 */
export function hasEnoughTokens(s: string): boolean {
  return tokenise(s).length >= MIN_TOKENS
}
```

- [x] **Step 7: Implement `src/config.ts`**

`.env` is read by Node itself — every script passes `--env-file=.env`, so there is no
loader library and nothing to call before the schema runs.

```ts
import { z } from 'zod'

const Schema = z.object({
  PORT: z.string().regex(/^\d+$/, 'PORT must be a whole number').default('3000'),

  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  ANTHROPIC_BASE_URL: z.string().url('ANTHROPIC_BASE_URL must be a URL'),
  CLAUDE_MODEL: z.string().min(1, 'CLAUDE_MODEL is required'),

  SN_INSTANCE_URL: z.string().url('SN_INSTANCE_URL must be a URL'),
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
```

- [x] **Step 8: Run to verify they pass**

Run: `npx vitest run`
Expected: PASS, 13 tests

- [x] **Step 9: Write `.env.example`**

The real `.env` holds live ServiceNow credentials. This committed file documents the shape with placeholders only.

```
# LLM gateway (UST LiteLLM). The API key is the VALUE of Key Vault secret
# 'codon-kvs' in ustdev-az-is-ai-app-kv — not its name and not its version.
ANTHROPIC_API_KEY=sk-replace-me
ANTHROPIC_BASE_URL=https://llmproxy.ustdev.com
CLAUDE_MODEL=claude-opus-4-8-Codon

# ServiceNow (written by Export-SnEnvFile — do not hand-edit)
SN_INSTANCE_URL=https://abhrademo4.service-now.com
SN_CLIENT_ID=replace-me
SN_CLIENT_SECRET=replace-me
SN_REFRESH_TOKEN=replace-me

# Set false to treat a SEARCH reply as NO_ANSWER (no second search).
RETRY_ENABLED=true
PORT=3000

# live | stub. Use stub ONLY while waiting for the gateway key — answers are
# canned and no model is called. Never leave this on for a demo.
LLM_MODE=live
```

- [x] **Step 10: Reconcile the real `.env`**

The existing `.env` carries three keys removed in revs 8 and 9: `GATE_MIN_TOKENS`, `GATE_MIN_COVERAGE` and `SEARCH_LIMIT`. Unknown keys are harmless to Node's `--env-file`, but leaving them implies they still do something. Delete those three lines by hand; touch nothing else in the file. Also remove the `$ModelChoices` parameter and the `CLAUDE_MODEL_CHOICES` entry from `tools/set-gateway-env.ps1` — that key was dropped with the model picker and nothing reads it.

- [x] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json .nvmrc .env.example src tests tools/set-gateway-env.ps1
git commit -m "feat: scaffold, validated config, masking logger and token guard"
```

---

## Task 2: ServiceNow OAuth and article search

**Files:**
- Create: `src/servicenow/types.ts`, `src/servicenow/client.ts`, `src/servicenow/search.ts`
- Test: `tests/servicenow.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1), `log` (Task 1)
- Produces: `Article`, `ServiceNowUnavailableError`, `makeSnClient(cfg, fetch)` → `SnClient = { instanceUrl, get<T>(path): Promise<T> }`, `makeSearch(client)` → `{ search(query): Promise<Article[]>, health() }`, `stripHtml(s)`, `sanitiseQuery(s)`

`makeSnClient` is the only place that knows about OAuth, bearer headers, timeouts or how a ServiceNow error becomes a `ServiceNowUnavailableError`. Search (this task) and stats (Task 3) both take the client, so the process holds **one** token cache and every request has the same timeout.

- [x] **Step 1: Write the failing test**

```ts
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

/** Route the token endpoint to a token, everything else to `handler`. */
const snFetch = (handler: (url: string) => Response | Promise<Response>) =>
  vi.fn(async (u: unknown, _init?: RequestInit) =>
    String(u).includes('oauth_token.do') ? tokenResponse() : handler(String(u)))

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
    // URLSearchParams encodes a space as '+', which decodeURIComponent leaves alone —
    // read the parameter back through URL so the comparison is on the decoded value.
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
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/servicenow.test.ts`
Expected: FAIL — module not found

- [x] **Step 3: Implement `src/servicenow/types.ts`**

```ts
/** One knowledge base article. A plain record — nothing implements an interface here. */
export interface Article {
  /** ServiceNow sys_id. The identity key everywhere (D10). */
  id: string
  /** KB number for display only — NOT unique on abhrademo4. */
  label?: string
  title: string
  body: string
  /** Where a human opens this article. */
  url: string
}

/**
 * The instance is unreachable or rejected our credentials. Deliberately distinct
 * from "no results" — the two must never produce the same user-facing message.
 */
export class ServiceNowUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'ServiceNowUnavailableError'
  }
}
```

- [x] **Step 4: Implement `src/servicenow/client.ts`**

```ts
import type { Config } from '../config.js'
import { ServiceNowUnavailableError } from './types.js'
import { log } from '../log.js'

/** Refresh a minute early so a token never expires mid-request. */
const EXPIRY_SAFETY_SECONDS = 60
/** One slow search or one pathological filter must not hang a chat turn. Not configurable. */
const TIMEOUT_MS = 10_000

export interface SnClient {
  instanceUrl: string
  /** Authenticated GET. Throws ServiceNowUnavailableError for anything but a 2xx JSON body. */
  get<T>(path: string): Promise<T>
}

export function makeSnClient(cfg: Config, fetchImpl: typeof fetch = fetch): SnClient {
  let token: string | null = null
  let expiresAt = 0
  let inflight: Promise<string> | null = null

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
      throw new ServiceNowUnavailableError(
        `Cannot reach ${cfg.sn.instanceUrl} to refresh the access token.`, e,
      )
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ServiceNowUnavailableError(
        `ServiceNow rejected the refresh token (HTTP ${res.status}). ` +
          `Refresh tokens last ~100 days and may have expired. ` +
          `Fix: run Connect-SnOAuth -Instance abhrademo4, then Export-SnEnvFile. ${detail}`,
      )
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!json.access_token) {
      throw new ServiceNowUnavailableError('Token endpoint returned no access_token.')
    }

    token = json.access_token
    expiresAt = Date.now() + ((json.expires_in ?? 1800) - EXPIRY_SAFETY_SECONDS) * 1000
    log('sn.token.refreshed', { expiresInSec: json.expires_in ?? 1800 })
    return token
  }

  function getToken(): Promise<string> {
    if (token && Date.now() < expiresAt) return Promise.resolve(token)
    // Concurrent callers share one refresh rather than each firing their own.
    if (inflight) return inflight
    inflight = refresh().finally(() => { inflight = null })
    return inflight
  }

  return {
    instanceUrl: cfg.sn.instanceUrl,

    async get<T>(path: string): Promise<T> {
      const bearer = await getToken()
      let res: Response
      try {
        res = await fetchImpl(`${cfg.sn.instanceUrl}${path}`, {
          headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (e) {
        throw new ServiceNowUnavailableError(`Cannot reach ${cfg.sn.instanceUrl}.`, e)
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new ServiceNowUnavailableError(
          `ServiceNow request failed (HTTP ${res.status}). ${detail.slice(0, 200)}`,
        )
      }
      return (await res.json()) as T
    },
  }
}
```

- [x] **Step 5: Implement `src/servicenow/search.ts`**

```ts
import type { Article } from './types.js'
import type { SnClient } from './client.js'

interface SnRecord {
  sys_id: string
  number?: string
  short_description?: string
  text?: string
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
}

/** Article bodies are HTML. Tags become spaces so words never run together. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

/** `^`, `=` and `&` break sysparm_query syntax, so they never reach the instance. */
export function sanitiseQuery(q: string): string {
  return q.replace(/[\^=&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** Five candidates reach the prompt. Measured at 83% recall@5; not configurable. */
const SEARCH_LIMIT = 5

export function makeSearch(sn: SnClient) {
  async function call(path: string): Promise<SnRecord[]> {
    return (await sn.get<{ result?: SnRecord[] }>(path)).result ?? []
  }

  function buildPath(query: string, limit = SEARCH_LIMIT): string {
    // Two clauses only. A knowledge base filter was A/B tested and removed (D5).
    const sysparmQuery = [
      'workflow_state=published',
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
    async search(query: string): Promise<Article[]> {
      const records = await call(buildPath(query))
      return records.map((r) => ({
        id: r.sys_id,
        label: r.number,
        title: (r.short_description ?? '').trim(),
        body: stripHtml(r.text ?? ''),
        // Link by sys_id: number is not unique on this instance (D10).
        url: `${sn.instanceUrl}/kb_view.do?sys_kb_id=${r.sys_id}`,
      }))
    },

    async health(): Promise<{ ok: boolean; detail?: string }> {
      try {
        await call(buildPath('test', 1))
        return { ok: true, detail: 'search reachable' }
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
```

- [x] **Step 6: Run to verify it passes**

Run: `npx vitest run tests/servicenow.test.ts`
Expected: PASS, 13 tests

- [x] **Step 7: Verify against the live instance**

```bash
node --env-file=.env --import tsx --input-type=module -e "import {loadConfig} from './src/config.ts';import {makeSnClient} from './src/servicenow/client.ts';import {makeSearch} from './src/servicenow/search.ts';const r=await makeSearch(makeSnClient(loadConfig())).search('Self-checkout lanes 1-4 down at Store #208 after image push');console.log(r.map(a=>a.label+' '+a.title))"
```

(`tsx -e` evaluates as CommonJS and cannot import the ESM sources; Node's own `--input-type=module -e` with the `tsx` loader can.)

Expected: `KB0010141 Self-checkout NCR terminal will not boot after image push` first — that is eval question `inc-01`.

- [x] **Step 8: Commit**

```bash
git add src/servicenow tests/servicenow.test.ts
git commit -m "feat: ServiceNow OAuth and live knowledge search"
```

---

## Task 3: Aggregate queries

**Files:**
- Create: `src/servicenow/stats.ts`
- Test: `tests/stats.test.ts`

**Interfaces:**
- Consumes: `SnClient`, `ServiceNowUnavailableError` (Tasks 1–2)
- Produces: `AGGREGATES`, `Aggregate`, `MetricRequest`, `MetricResult`, `isAggregate(v)`, `isTableName(v)`, `buildStatsPath(req)`, `buildListUrl(instanceUrl, req)`, `makeStats(client)` → `{ run(req): Promise<MetricResult> }`

This is the whole of D14's execution side. The model supplies four fields as data (plus an optional display `label`); everything here builds a read-only `GET`. The table name is interpolated into a URL path, so it is shape-checked — the one place model output touches a path.

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  buildStatsPath, buildListUrl, isAggregate, isTableName, makeStats,
} from '../src/servicenow/stats.js'
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
const snFetch = (handler: (url: string) => Response | Promise<Response>) =>
  vi.fn(async (u: unknown) =>
    String(u).includes('oauth_token.do') ? tokenResponse() : handler(String(u)))
const stats = (fetchImpl: unknown) => makeStats(makeSnClient(cfg, fetchImpl as never))

describe('isAggregate', () => {
  it('accepts the five permitted aggregates', () => {
    for (const a of ['count', 'avg', 'sum', 'min', 'max']) expect(isAggregate(a)).toBe(true)
  })
  it('rejects anything else, including SQL-ish input', () => {
    expect(isAggregate('median')).toBe(false)
    expect(isAggregate('count; DROP')).toBe(false)
    expect(isAggregate(undefined)).toBe(false)
  })
})

describe('isTableName', () => {
  it('accepts plain ServiceNow table names', () => {
    for (const t of ['incident', 'task_sla', 'sn_si_incident', 'x_ustgl_backlog_be_thing']) {
      expect(isTableName(t)).toBe(true)
    }
  })
  it('rejects anything that could escape the stats path', () => {
    for (const t of ['../table/incident', 'incident?sysparm_x=1', 'incident/foo', 'Incident', '', undefined]) {
      expect(isTableName(t)).toBe(false)
    }
  })
})

describe('buildStatsPath', () => {
  it('uses sysparm_count for count', () => {
    const p = buildStatsPath({ table: 'incident', filter: 'active=true', aggregate: 'count' })
    expect(p).toBe('/api/now/stats/incident?sysparm_count=true&sysparm_query=active%3Dtrue')
  })

  it('uses sysparm_<agg>_fields for the others', () => {
    const p = buildStatsPath({
      table: 'incident', filter: 'priority=2', aggregate: 'avg', field: 'calendar_duration',
    })
    expect(p).toContain('sysparm_avg_fields=calendar_duration')
    expect(p).toContain('sysparm_query=priority%3D2')
  })

  it('refuses a non-count aggregate with no field', () => {
    expect(() => buildStatsPath({ table: 'incident', filter: '', aggregate: 'avg' }))
      .toThrow(/requires a field/)
  })

  it('omits sysparm_query entirely when the filter is empty', () => {
    expect(buildStatsPath({ table: 'sn_vul_vulnerable_item', filter: '', aggregate: 'count' }))
      .toBe('/api/now/stats/sn_vul_vulnerable_item?sysparm_count=true')
  })
})

describe('buildListUrl', () => {
  it('deep links to the same records the number counted', () => {
    const u = buildListUrl('https://sn.example.com', {
      table: 'incident', filter: 'active=true^state=2', aggregate: 'count',
    })
    expect(u).toBe('https://sn.example.com/incident_list.do?sysparm_query=active%3Dtrue%5Estate%3D2')
  })
})

describe('makeStats.run', () => {
  it('returns the count as a number, with the filter, label and link intact', async () => {
    const r = await stats(snFetch(() => ok({ result: { stats: { count: '5513' } } })))
      .run({ table: 'incident', filter: 'active=true', aggregate: 'count', label: 'open incidents' })
    expect(r.value).toBe(5513)
    expect(r.filter).toBe('active=true')
    expect(r.label).toBe('open incidents')
    expect(r.url).toContain('incident_list.do')
  })

  it('keeps a duration aggregate as a string', async () => {
    const r = await stats(snFetch(() => ok({ result: { stats: { avg: { calendar_duration: '00:43:22' } } } })))
      .run({ table: 'incident', filter: 'priority=2', aggregate: 'avg', field: 'calendar_duration' })
    expect(r.value).toBe('00:43:22')
  })

  it('rejects an aggregate outside the five, without calling ServiceNow', async () => {
    const fetchImpl = vi.fn()
    await expect(
      stats(fetchImpl).run({ table: 'incident', filter: '', aggregate: 'median' as never }),
    ).rejects.toThrow(/aggregate/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a table name that is not a plain identifier, without calling ServiceNow', async () => {
    const fetchImpl = vi.fn()
    await expect(
      stats(fetchImpl).run({ table: '../oauth_token.do', filter: '', aggregate: 'count' }),
    ).rejects.toThrow(/table/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('raises rather than repairing a filter ServiceNow rejects', async () => {
    await expect(
      stats(snFetch(() => new Response('Invalid query', { status: 400 })))
        .run({ table: 'incident', filter: 'nonsense!!', aggregate: 'count' }),
    ).rejects.toBeInstanceOf(ServiceNowUnavailableError)
  })

  it('raises when the body carries no usable stats', async () => {
    await expect(
      stats(snFetch(() => ok({ result: {} }))).run({ table: 'incident', filter: '', aggregate: 'count' }),
    ).rejects.toThrow(/no value/)
  })
})
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/stats.test.ts`
Expected: FAIL — module not found

- [x] **Step 3: Implement `src/servicenow/stats.ts`**

```ts
import type { SnClient } from './client.js'

/** The only aggregates we will execute. Anything else is a decline, never a coercion. */
export const AGGREGATES = ['count', 'avg', 'sum', 'min', 'max'] as const
export type Aggregate = (typeof AGGREGATES)[number]

/** What the model supplies — as data. It never supplies a URL, a method or a path. */
export interface MetricRequest {
  table: string
  filter: string
  aggregate: Aggregate
  field?: string
  /** Short noun phrase for the sentence around the number, e.g. "open incidents". Display only. */
  label?: string
}

export interface MetricResult extends MetricRequest {
  /** Numeric where ServiceNow returns a number; a string for durations like '00:43:22'. */
  value: number | string
  url: string
}

export function isAggregate(v: unknown): v is Aggregate {
  return typeof v === 'string' && (AGGREGATES as readonly string[]).includes(v)
}

/**
 * The table name is the one piece of model output that lands in a URL *path*.
 * ServiceNow table names are lowercase identifiers; anything else could escape
 * /api/now/stats/. This is a shape check, not an allowlist — ACLs decide access.
 */
export function isTableName(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9_]+$/.test(v)
}

/** count uses sysparm_count; every other aggregate uses sysparm_<agg>_fields. */
export function buildStatsPath(req: MetricRequest): string {
  const params = new URLSearchParams()
  if (req.aggregate === 'count') {
    params.set('sysparm_count', 'true')
  } else {
    if (!req.field) throw new Error(`aggregate '${req.aggregate}' requires a field`)
    params.set(`sysparm_${req.aggregate}_fields`, req.field)
  }
  if (req.filter) params.set('sysparm_query', req.filter)
  return `/api/now/stats/${req.table}?${params.toString()}`
}

/** The link that settles any argument about the number. */
export function buildListUrl(instanceUrl: string, req: MetricRequest): string {
  return `${instanceUrl}/${req.table}_list.do?sysparm_query=${encodeURIComponent(req.filter)}`
}

interface StatsBody {
  result?: { stats?: { count?: string } & Record<string, unknown> }
}

/** ServiceNow returns everything as strings. Numbers become numbers; durations stay text. */
function coerce(raw: string): number | string {
  const n = Number(raw)
  return raw.trim() !== '' && Number.isFinite(n) ? n : raw
}

function extract(body: StatsBody, req: MetricRequest): number | string {
  const stats = body.result?.stats
  if (!stats) throw new Error('ServiceNow returned no value for this query')

  if (req.aggregate === 'count') {
    if (stats.count === undefined) throw new Error('ServiceNow returned no value for this query')
    return coerce(stats.count)
  }

  const group = stats[req.aggregate] as Record<string, string> | undefined
  const raw = req.field ? group?.[req.field] : undefined
  if (raw === undefined) throw new Error('ServiceNow returned no value for this query')
  return coerce(raw)
}

export function makeStats(sn: SnClient) {
  return {
    async run(req: MetricRequest): Promise<MetricResult> {
      // Validate before spending a token refresh or a round trip.
      if (!isAggregate(req.aggregate)) {
        throw new Error(`unsupported aggregate '${String(req.aggregate)}'`)
      }
      if (!isTableName(req.table)) {
        throw new Error(`table name '${String(req.table)}' is not a plain identifier`)
      }

      // The client rejects a non-2xx as ServiceNowUnavailableError. Deliberately no
      // repair attempt here: a second guess at a query is a second chance to be wrong.
      const body = await sn.get<StatsBody>(buildStatsPath(req))

      return {
        ...req,
        value: extract(body, req),
        url: buildListUrl(sn.instanceUrl, req),
      }
    },
  }
}
```

> **Added after the scenario run (rev 10):** `isEncodedQuery(filter)` — every `^`-separated
> clause must be a lowercase field name followed immediately by an operator (`=`, `!=`, `<`,
> `>`, or an uppercase keyword such as `IN`, `ISEMPTY`, `ON`); `EQ`, `ORDERBY…`, `OR…` and
> `NQ…` clauses are allowed. `run()` checks it after the table name and before any request.
> Reason: ServiceNow silently ignored `this is not a query!!` and returned the whole table.
> The committed `src/servicenow/stats.ts` and `tests/stats.test.ts` are the reference.

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/stats.test.ts`
Expected: PASS, 18 tests

- [x] **Step 5: Verify against the live instance**

```bash
node --env-file=.env --import tsx --input-type=module -e "import {loadConfig} from './src/config.ts';import {makeSnClient} from './src/servicenow/client.ts';import {makeStats} from './src/servicenow/stats.ts';const s=makeStats(makeSnClient(loadConfig()));const r=await Promise.all([s.run({table:'incident',filter:'active=true',aggregate:'count'}),s.run({table:'incident',filter:'active=true^priority=1',aggregate:'count'}),s.run({table:'task_sla',filter:'has_breached=true',aggregate:'count'})]);r.forEach(x=>console.log(x.value,'|',x.table,x.filter))"
```

Expected, matching the spec §8b measurements (numbers drift as tickets are raised — the shape is what matters):

```
5513 | incident active=true
14   | incident active=true^priority=1
23429| task_sla has_breached=true
```

- [x] **Step 6: Commit**

```bash
git add src/servicenow/stats.ts tests/stats.test.ts
git commit -m "feat: read-only aggregate queries with deep links"
```

---

## Task 4: Claude client, one prompt, reply parsing

**Files:**
- Create: `src/llm/client.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Consumes: `Config`, `Article`, `MetricRequest`, `isAggregate`, `log`, `mask`
- Produces: `Turn`, `Reply`, `SYSTEM_PROMPT`, `buildContextBlock(articles)`, `parseReply(raw, originalQuery)`, `parseCitations(text)`, `verifyCitations(cited, supplied)`, `stripCitationMarkup(text)`, `makeLlm(cfg)` → `{ preflight(), decide({question, articles, history}) }`

One prompt, four possible replies (D16). There is no triage prompt and no second method.

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import {
  buildContextBlock, parseReply, parseCitations, verifyCitations, stripCitationMarkup,
} from '../src/llm/client.js'
import type { Article } from '../src/servicenow/types.js'

const A = (id: string, title: string): Article =>
  ({ id, title, body: 'body', url: `https://sn/${id}`, label: `KB${id}` })

describe('buildContextBlock', () => {
  it('labels articles [1]..[n] in order', () => {
    const b = buildContextBlock([A('a', 'First'), A('b', 'Second')])
    expect(b).toContain('[1] First')
    expect(b).toContain('[2] Second')
  })
})

describe('parseReply', () => {
  it('reads an ANSWER and keeps its citations', () => {
    const r = parseReply('ANSWER\nReset it from the portal [1].', 'q')
    expect(r.kind).toBe('answer')
    if (r.kind === 'answer') expect(r.text).toBe('Reset it from the portal [1].')
  })

  it('reads a METRIC into a request, keeping the display label', () => {
    const r = parseReply(
      'METRIC\n{"table":"incident","filter":"active=true","aggregate":"count","label":"open incidents"}',
      'how many open incidents',
    )
    expect(r.kind).toBe('metric')
    if (r.kind === 'metric') {
      expect(r.request.table).toBe('incident')
      expect(r.request.filter).toBe('active=true')
      expect(r.request.aggregate).toBe('count')
      expect(r.request.label).toBe('open incidents')
    }
  })

  it('accepts a METRIC without a label', () => {
    const r = parseReply('METRIC\n{"table":"incident","filter":"","aggregate":"count"}', 'q')
    expect(r.kind).toBe('metric')
    if (r.kind === 'metric') expect(r.request.label).toBeUndefined()
  })

  it('declines a METRIC whose aggregate is not permitted', () => {
    const r = parseReply('METRIC\n{"table":"incident","filter":"","aggregate":"median"}', 'q')
    expect(r.kind).toBe('no_answer')
  })

  it('declines a METRIC that is not valid JSON', () => {
    expect(parseReply('METRIC\n{table: incident}', 'q').kind).toBe('no_answer')
  })

  it('declines a METRIC with no table', () => {
    expect(parseReply('METRIC\n{"filter":"active=true","aggregate":"count"}', 'q').kind)
      .toBe('no_answer')
  })

  it('reads a SEARCH as new keywords', () => {
    const r = parseReply('SEARCH\noutlook repeated password prompt credentials', 'windows popup')
    expect(r.kind).toBe('search')
    if (r.kind === 'search') expect(r.query).toBe('outlook repeated password prompt credentials')
  })

  it('declines a SEARCH that just repeats the question', () => {
    // Re-running the identical search burns a call for identical results.
    expect(parseReply('SEARCH\nwindows popup', 'windows popup').kind).toBe('no_answer')
  })

  it('declines an empty SEARCH', () => {
    expect(parseReply('SEARCH\n   ', 'q').kind).toBe('no_answer')
  })

  it('reads NO_ANSWER', () => {
    expect(parseReply('NO_ANSWER', 'q').kind).toBe('no_answer')
  })

  it('treats an unrecognised reply as NO_ANSWER rather than guessing', () => {
    expect(parseReply('Sure! Here is what I think...', 'q').kind).toBe('no_answer')
  })

  it('tolerates leading blank lines and stray whitespace', () => {
    expect(parseReply('\n\n  ANSWER  \nText [1]', 'q').kind).toBe('answer')
  })
})

describe('verifyCitations', () => {
  const supplied = [A('a', 'First'), A('b', 'Second')]

  it('maps cited labels back to articles', () => {
    const { sources, fabricated } = verifyCitations([1, 2], supplied)
    expect(sources.map((s) => s.id)).toEqual(['a', 'b'])
    expect(fabricated).toEqual([])
  })

  it('reports a label that was never supplied', () => {
    const { sources, fabricated } = verifyCitations([1, 7], supplied)
    expect(sources.map((s) => s.id)).toEqual(['a'])
    expect(fabricated).toEqual([7])
  })
})

describe('parseCitations and stripCitationMarkup', () => {
  it('finds each distinct label once', () => {
    expect(parseCitations('a [1] b [2] c [1]')).toEqual([1, 2])
  })
  it('removes the markers once sources render separately', () => {
    expect(stripCitationMarkup('Do this [1]. Then that [2].')).toBe('Do this. Then that.')
  })
})
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/llm.test.ts`
Expected: FAIL — module not found

- [x] **Step 3: Implement `src/llm/client.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../config.js'
import type { Article } from '../servicenow/types.js'
import { isAggregate, type MetricRequest } from '../servicenow/stats.js'
import { log, mask } from '../log.js'

export interface Turn {
  role: 'user' | 'assistant'
  content: string
}

export type Reply =
  | { kind: 'answer'; text: string }
  | { kind: 'metric'; request: MetricRequest }
  | { kind: 'search'; query: string }
  | { kind: 'no_answer' }

/**
 * One prompt, four replies (D16). Rev 8 merged the old triage prompt into this —
 * with D13 in place the coverage floor only chose which prompt to send, so the
 * two prompts became one for the same number of model calls.
 */
export const SYSTEM_PROMPT = `You are an assistant for a ServiceNow instance. You handle two kinds of question.

KNOWLEDGE QUESTIONS ("how do I...", "what is the process for...") are answered from the CONTEXT block of knowledge base articles.

COUNTING QUESTIONS ("how many...", "what is our...", anything asking for a number about tickets, SLAs, changes, problems, assets or security incidents) are answered by writing a ServiceNow aggregate query, which the server runs.

Reply with EXACTLY ONE of the four forms below. The first line is the form name, alone. Output nothing else — no preamble, no explanation.

ANSWER
<your answer, grounded ONLY in the CONTEXT articles, citing each claim with the bracketed label it came from, like [1] or [2]. Cite only labels present in CONTEXT. Be concise; prefer numbered steps when the article gives steps.>

METRIC
{"table":"<table>","filter":"<encoded query>","aggregate":"count|avg|sum|min|max","field":"<field, omit for count>","label":"<2-5 word noun phrase that reads after the number, e.g. open P1 incidents>"}

SEARCH
<better keywords, nothing else — use the vocabulary a knowledge base would use. Only when the question is reasonable but the CONTEXT articles clearly do not match it.>

NO_ANSWER

Rules for METRIC:
- "filter" is a ServiceNow encoded query: clauses joined by ^, e.g. active=true^priority=1
- Open/active tickets are active=true. Priorities are priority=1..5. Incident states: 1 New, 2 In Progress, 3 On Hold, 6 Resolved, 7 Closed, 8 Cancelled. Be careful: "closed" usually means both 6 and 7, so use stateIN6,7 unless the user clearly means only one.
- Breached SLAs are task_sla with has_breached=true. Security incidents are sn_si_incident.
- Relative dates use ServiceNow javascript functions, e.g. opened_at<javascript:gs.daysAgoStart(30)
- Never invent a table or field you are not confident exists. Prefer NO_ANSWER.
- If the data plainly does not exist in ServiceNow (uptime, latency, synthetic checks, anything from a monitoring tool), reply NO_ANSWER.

Never answer a knowledge question from your own knowledge. If CONTEXT does not contain it and better keywords will not help, reply NO_ANSWER.`

/** Articles are labelled [1]..[n]. The model cites labels, never sys_ids or KB numbers (D10). */
export function buildContextBlock(articles: Article[]): string {
  if (articles.length === 0) return '(no articles matched)'
  return articles.map((a, i) => `[${i + 1}] ${a.title}\n${a.body}`).join('\n\n---\n\n')
}

export function parseCitations(answer: string): number[] {
  return [...new Set([...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])))]
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

/**
 * Interprets the model's reply. Anything unrecognised, malformed or useless
 * becomes NO_ANSWER — the same discipline as stripping a fabricated citation.
 * This function never repairs; it only accepts or declines.
 */
export function parseReply(raw: string, originalQuery: string): Reply {
  const lines = raw.trim().split('\n')
  const verbLine = (lines.shift() ?? '').trim().toUpperCase()
  const rest = lines.join('\n').trim()

  if (verbLine === 'ANSWER') {
    return rest ? { kind: 'answer', text: rest } : { kind: 'no_answer' }
  }

  if (verbLine === 'METRIC') {
    let parsed: unknown
    try {
      parsed = JSON.parse(rest)
    } catch {
      return { kind: 'no_answer' }
    }
    const o = parsed as Partial<MetricRequest>
    if (typeof o?.table !== 'string' || !o.table.trim()) return { kind: 'no_answer' }
    if (!isAggregate(o.aggregate)) return { kind: 'no_answer' }
    if (o.aggregate !== 'count' && (typeof o.field !== 'string' || !o.field.trim())) {
      return { kind: 'no_answer' }
    }
    return {
      kind: 'metric',
      request: {
        table: o.table.trim(),
        filter: typeof o.filter === 'string' ? o.filter.trim() : '',
        aggregate: o.aggregate,
        ...(o.field ? { field: o.field.trim() } : {}),
        ...(typeof o.label === 'string' && o.label.trim() ? { label: o.label.trim() } : {}),
      },
    }
  }

  if (verbLine === 'SEARCH') {
    const q = rest.replace(/^["'`]+|["'`]+$/g, '').trim()
    if (!q) return { kind: 'no_answer' }
    // Re-running the identical search burns a call for identical results.
    if (q.toLowerCase() === originalQuery.trim().toLowerCase()) return { kind: 'no_answer' }
    return { kind: 'search', query: q }
  }

  return { kind: 'no_answer' }
}

/**
 * Stand-in for the gateway, used only when LLM_MODE=stub — for building and
 * exercising the whole app before the Key Vault secret is available.
 *
 * It must be loud and obviously fake. Shipping with this enabled unnoticed
 * would be far worse than not booting at all.
 */
export function makeStubLlm() {
  return {
    async preflight(): Promise<void> {
      log('llm.STUB_MODE', { warning: 'No real model. Answers are canned. Do not demo as real.' })
    },

    // Same signature as the live client so makeLlm returns one shape; history is unused here.
    async decide(opts: { question: string; articles: Article[]; history: Turn[] }): Promise<Reply> {
      log('llm.STUB_MODE.decide', { q: opts.question })

      // A fixture, not intelligence: it exists so the aggregate path can be
      // exercised end-to-end, with a real number, before the key arrives.
      if (/how many|count of/i.test(opts.question)) {
        return {
          kind: 'metric',
          request: { table: 'incident', filter: 'active=true', aggregate: 'count', label: 'open incidents' },
        }
      }

      const first = opts.articles[0]
      if (!first) return { kind: 'no_answer' }
      return {
        kind: 'answer',
        text:
          `[STUB — no live model] The knowledge base article that matches this is ` +
          `"${first.title}". Its content begins: ${first.body.slice(0, 200)} [1]`,
      }
    },
  }
}

export function makeLlm(cfg: Config) {
  if (cfg.llmMode === 'stub') return makeStubLlm()

  // Two env vars, standard SDK, no wrapper (nowstudio-reference §1).
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey, baseURL: cfg.anthropicBaseUrl })

  async function complete(system: string, messages: Turn[], maxTokens: number): Promise<string> {
    const res = await client.messages.create({
      model: cfg.claudeModel,
      max_tokens: maxTokens,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    })
    return res.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim()
  }

  return {
    /**
     * One cheap call against the configured model id. The gateway renames models,
     * and a wrong id yields a silent wrong answer rather than an error — so this
     * must fail the boot, loudly (spec §7 rule 2).
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
            `(key ${mask(cfg.anthropicApiKey)}). The gateway renames model ids — check the exact ` +
            `id with the platform team. Cause: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    },

    async decide(opts: {
      question: string
      articles: Article[]
      history: Turn[]
    }): Promise<Reply> {
      const user =
        `CONTEXT\n${buildContextBlock(opts.articles)}\n\nQUESTION\n${opts.question}`
      const raw = await complete(SYSTEM_PROMPT, [...opts.history, { role: 'user', content: user }], 1024)
      return parseReply(raw, opts.question)
    },
  }
}
```

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/llm.test.ts`
Expected: PASS, 18 tests

- [ ] **Step 5: Verify preflight against the live gateway** — ⏸ **BLOCKED until the Key Vault secret is available**

```bash
node --env-file=.env --import tsx --input-type=module -e "import {loadConfig} from './src/config.ts';import {makeLlm} from './src/llm/client.ts';await makeLlm(loadConfig()).preflight();console.log('preflight ok')"
```

Expected: `preflight ok`. A failure names the model id and the masked key — treat a wrong model id as the most likely cause.

- [x] **Step 6: Commit**

```bash
git add src/llm tests/llm.test.ts
git commit -m "feat: Claude client with one prompt and four-way reply parsing"
```

---

## Task 5: Server, routes and boot

**Files:**
- Create: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4
- Produces: `makeApp({ cfg, sn, stats, llm })` → Express app

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeApp } from '../src/server.js'
import { parseConfig, type Config } from '../src/config.js'
import type { Article } from '../src/servicenow/types.js'
import { ServiceNowUnavailableError } from '../src/servicenow/types.js'
import type { Reply } from '../src/llm/client.js'

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

describe('POST /api/chat', () => {
  it('rejects an empty message', async () => {
    const app = makeApp({ cfg, sn: okSn(), stats: noStats, llm: fakeLlm(() => ({ kind: 'no_answer' })) })
    const r = await post(app, { message: '' })
    expect(r.status).toBe(400)
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
      .mockResolvedValueOnce({ kind: 'no_answer' })
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
      llm: fakeLlm(() => ({ kind: 'no_answer' })),
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

function fakeLlm(reply: () => Reply) {
  return { preflight: async () => {}, decide: async () => reply() }
}
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — module not found

- [x] **Step 3: Implement `src/server.ts`**

```ts
import express from 'express'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { loadConfig, type Config } from './config.js'
import type { Article } from './servicenow/types.js'
import { ServiceNowUnavailableError } from './servicenow/types.js'
import { makeSnClient } from './servicenow/client.js'
import { makeSearch } from './servicenow/search.js'
import { makeStats, type MetricRequest, type MetricResult } from './servicenow/stats.js'
import { hasEnoughTokens } from './guard.js'
import {
  makeLlm, parseCitations, verifyCitations, stripCitationMarkup,
  type Turn, type Reply,
} from './llm/client.js'
import { log } from './log.js'

const here = dirname(fileURLToPath(import.meta.url))

const MAX_MESSAGE_LENGTH = 2000
const DECLINE_TEXT = 'I do not have that in the knowledge base.'
const UNAVAILABLE_TEXT = 'I cannot reach the knowledge base right now. Please try again shortly.'

interface Sn {
  search(query: string): Promise<Article[]>
  health(): Promise<{ ok: boolean; detail?: string }>
}

interface Stats {
  run(req: MetricRequest): Promise<MetricResult>
}

interface Llm {
  preflight(): Promise<void>
  decide(o: { question: string; articles: Article[]; history: Turn[] }): Promise<Reply>
}

/** "5,513 open incidents" — or just the value when the model gave no label. */
function metricSentence(m: MetricResult): string {
  const value = typeof m.value === 'number' ? m.value.toLocaleString('en-US') : m.value
  return m.label ? `${value} ${m.label}` : String(value)
}

export function makeApp(deps: { cfg: Config; sn: Sn; stats: Stats; llm: Llm }) {
  const { cfg, sn, stats, llm } = deps
  // ponytail: grows one entry per conversationId for the process lifetime. Fine for a
  // proof on one laptop; add eviction when this runs as a shared service.
  const conversations = new Map<string, Turn[]>()
  const app = express()

  function remember(conversationId: string, history: Turn[], question: string, answer: string) {
    const turns: Turn[] = [...history, { role: 'user', content: question }, { role: 'assistant', content: answer }]
    conversations.set(conversationId, turns.slice(-12))
  }

  app.use(express.json({ limit: '64kb' }))

  app.get('/api/health', async (_req, res) => {
    const servicenow = await sn.health()
    res.json({
      ok: servicenow.ok,
      // Stub mode must be visible in the UI, not merely in a log file.
      model: cfg.llmMode === 'stub' ? 'STUB — no live model' : cfg.claudeModel,
      llmMode: cfg.llmMode,
      servicenow,
    })
  })

  app.post('/api/chat', async (req, res, next) => {
    const started = Date.now()
    try {
      const message = String(req.body?.message ?? '').trim()
      const conversationId = String(req.body?.conversationId ?? 'default')

      if (!message) return res.status(400).json({ error: 'message is required' })
      if (message.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `message exceeds ${MAX_MESSAGE_LENGTH} characters` })
      }

      const decline = (gateReason: string, retried = false) => {
        log('chat', { q: message, gate: gateReason, retried, ms: Date.now() - started })
        return res.json({
          answer: DECLINE_TEXT, kind: 'decline', sources: [], grounded: false, gateReason, retried,
        })
      }

      // Gate layer 1 — runs before any network call, so greeting noise never
      // reaches the instance or the model. The only free rejection there is.
      if (!hasEnoughTokens(message)) return decline('too_few_tokens')

      let articles: Article[]
      try {
        articles = await sn.search(message)
      } catch (e) {
        if (!(e instanceof ServiceNowUnavailableError)) throw e
        log('chat.servicenow_unavailable', { q: message, detail: e.message })
        return res.status(503).json({
          answer: UNAVAILABLE_TEXT, kind: 'decline', sources: [], grounded: false,
          gateReason: 'servicenow_unavailable', retried: false,
        })
      }

      const history = conversations.get(conversationId) ?? []

      // Gate layer 2 — one call, four possible replies (D16).
      let reply = await llm.decide({ question: message, articles, history })
      let retried = false
      let rewritten: string | null = null

      // D13: at most one rewrite, ever.
      if (reply.kind === 'search') {
        if (!cfg.retryEnabled) return decline('model_declined')

        retried = true
        rewritten = reply.query
        try {
          const second = await sn.search(rewritten)
          // Union, deduped by sys_id. Rewritten results lead because they are the
          // better guess; nothing is truncated, or the first search — which usually
          // fills the limit on its own — would discard everything the rewrite found.
          const seen = new Set(second.map((a) => a.id))
          articles = [...second, ...articles.filter((a) => !seen.has(a.id))]
        } catch (e) {
          if (!(e instanceof ServiceNowUnavailableError)) throw e
          // Second search failed: decide again on what we already had.
          log('chat.retry_search_failed', { q: message, detail: e.message })
        }

        reply = await llm.decide({ question: message, articles, history })
        // A second SEARCH is never honoured — no loops.
        if (reply.kind === 'search') reply = { kind: 'no_answer' }
      }

      if (reply.kind === 'metric') {
        let result: MetricResult
        try {
          result = await stats.run(reply.request)
        } catch (e) {
          // No repair attempt: a second guess is a second chance to be wrong.
          log('chat.metric_failed', {
            q: message, table: reply.request.table, filter: reply.request.filter,
            detail: e instanceof Error ? e.message : String(e),
          })
          return decline('metric_unavailable', retried)
        }

        log('chat', {
          q: message, gate: 'metric', table: result.table, filter: result.filter,
          aggregate: result.aggregate, field: result.field, value: result.value,
          retried, ms: Date.now() - started,
        })

        const answer = metricSentence(result)
        // The filter goes into history too, so "and how many of those are P1?" can build on it.
        remember(conversationId, history, message, `${answer} (${result.table} · ${result.filter || 'no filter'})`)

        return res.json({
          answer,
          kind: 'metric',
          sources: [],
          metric: result,
          grounded: true,
          gateReason: null,
          retried,
        })
      }

      if (reply.kind !== 'answer') return decline('model_declined', retried)

      const { sources, fabricated } = verifyCitations(parseCitations(reply.text), articles)
      if (fabricated.length) log('chat.fabricated_citation', { q: message, labels: fabricated })

      remember(conversationId, history, message, reply.text)

      log('chat', {
        q: message, rewritten, candidates: articles.map((a) => a.label), gate: 'answered',
        cited: sources.map((s) => s.label), retried, ms: Date.now() - started,
      })

      res.json({
        answer: stripCitationMarkup(reply.text),
        kind: 'article',
        sources: sources.map((s) => ({ id: s.id, label: s.label, title: s.title, url: s.url })),
        grounded: true,
        gateReason: null,
        retried,
      })
    } catch (e) {
      next(e)
    }
  })

  app.use(express.static(join(here, '../public')))

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log('error.unhandled', { message: err.message })
    res.status(500).json({ error: 'internal error' })
  })

  return app
}

async function main() {
  const cfg = loadConfig()

  if (cfg.llmMode === 'stub') {
    console.warn('\n*** LLM_MODE=stub — answers are canned, no model is being called ***\n')
  }

  const llm = makeLlm(cfg)
  await llm.preflight() // fails the boot on a bad model id or key (no-op in stub mode)

  const client = makeSnClient(cfg) // one token cache, one timeout, shared by search and stats
  const sn = makeSearch(client)
  const stats = makeStats(client)
  const health = await sn.health()
  if (!health.ok) throw new Error(`ServiceNow is not reachable: ${health.detail}`)
  log('servicenow.ok', { detail: health.detail })

  makeApp({ cfg, sn, stats, llm }).listen(cfg.port, () => {
    log('listening', { port: cfg.port, model: cfg.claudeModel })
  })
}

// Only boot when run directly, so tests can import makeApp without starting a server.
// pathToFileURL handles the Windows form (file:///C:/...) that a hand-built string does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\nSTARTUP FAILED\n${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
}
```

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS, 12 tests

- [x] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: chat route with article, metric and decline paths"
```

---

## Task 6: Chat UI

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/styles.css`

**Interfaces:**
- Consumes: `POST /api/chat`, `GET /api/health` (Task 5)
- Produces: nothing consumed by later tasks

- [x] **Step 1: Create `public/index.html`**

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
    <span id="health" class="pill">checking…</span>
  </header>

  <main id="log" aria-live="polite"></main>

  <form id="composer">
    <input id="q" autocomplete="off" placeholder="Ask about articles, or how many…" />
    <button>Send</button>
  </form>

  <script src="app.js" type="module"></script>
</body>
</html>
```

- [x] **Step 2: Create `public/styles.css`**

```css
:root { --bg:#0f1115; --panel:#171a21; --ink:#e8eaed; --muted:#9aa4b2; --accent:#5b9dff; --warn:#e0a458; }
* { box-sizing:border-box; }
body { margin:0; font:15px/1.55 "Segoe UI",system-ui,sans-serif; background:var(--bg); color:var(--ink);
       display:flex; flex-direction:column; height:100vh; }
header { display:flex; gap:.75rem; align-items:center; padding:.75rem 1rem; border-bottom:1px solid #262b35; }
h1 { font-size:1rem; margin:0; flex:1; font-weight:600; }
.pill { font-size:.75rem; color:var(--muted); border:1px solid #2b3240; border-radius:999px; padding:.15rem .6rem; }
.pill.ok { color:#7ee787; }
.pill.bad { color:#ff7b72; }
.pill.warn { color:var(--warn); border-color:#e0a45855; }
main { flex:1; overflow-y:auto; padding:1rem; display:flex; flex-direction:column; gap:.9rem; }
.msg { max-width:46rem; }
.msg.user { align-self:flex-end; background:#22304a; padding:.55rem .8rem; border-radius:10px 10px 2px 10px; }
.msg.bot { align-self:flex-start; background:var(--panel); padding:.55rem .8rem; border-radius:10px 10px 10px 2px; white-space:pre-wrap; }
.metric { font-size:2rem; font-weight:600; line-height:1.1; }
.sources { font-size:.78rem; color:var(--muted); margin-top:.45rem; }
.sources a { color:var(--accent); text-decoration:none; }
.sources a:hover { text-decoration:underline; }
.sources.none { color:var(--warn); }
/* The filter is long and ugly. It wraps; it is never truncated — it is the only
   thing that makes the number checkable (spec §8b). */
.filter { font-family:ui-monospace,Consolas,monospace; font-size:.72rem; color:var(--muted);
          background:#11141a; border:1px solid #262b35; border-radius:6px;
          padding:.3rem .45rem; margin-top:.3rem; overflow-wrap:anywhere; }
form { display:flex; gap:.5rem; padding:.75rem 1rem; border-top:1px solid #262b35; }
input { flex:1; background:var(--panel); border:1px solid #2b3240; color:var(--ink); padding:.6rem .8rem; border-radius:8px; }
button { background:var(--accent); border:0; color:#08121f; font-weight:600; padding:.6rem 1.1rem; border-radius:8px; cursor:pointer; }
.typing { color:var(--muted); font-style:italic; }
```

- [x] **Step 3: Create `public/app.js`**

```js
const logEl = document.getElementById('log')
const form = document.getElementById('composer')
const input = document.getElementById('q')
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

function link(href, text) {
  const a = document.createElement('a')
  a.href = href
  a.target = '_blank'
  a.rel = 'noopener'
  a.textContent = text
  return a
}

/** Article answers cite KB numbers; metric answers show the query that produced them. */
function renderSources(el, data) {
  const line = document.createElement('div')
  line.className = 'sources'

  if (data.kind === 'metric' && data.metric) {
    const m = data.metric
    const agg = m.aggregate === 'count' ? 'count' : `${m.aggregate}(${m.field})`
    line.append(`Source: ${m.table} · ${agg} · `)
    line.appendChild(link(m.url, 'open in abhrademo4 →'))
    el.appendChild(line)

    const f = document.createElement('div')
    f.className = 'filter'
    f.textContent = m.filter || '(no filter — whole table)'
    el.appendChild(f)
    return
  }

  if (!data.grounded || !data.sources || data.sources.length === 0) {
    line.classList.add('none')
    line.textContent =
      data.gateReason === 'servicenow_unavailable'
        ? 'Knowledge base unreachable — not answered'
        : data.gateReason === 'metric_unavailable'
          ? 'Could not run that query — not answered'
          : 'No knowledge base match — not answered'
    el.appendChild(line)
    return
  }

  line.append('Sources: ')
  data.sources.forEach((s, i) => {
    if (i) line.append(' · ')
    const a = link(s.url, s.label || s.title)
    a.title = s.title
    line.appendChild(a)
  })
  el.appendChild(line)
}

async function loadHealth() {
  try {
    const h = await (await fetch('/api/health')).json()
    healthEl.textContent = h.ok ? `ready · ${h.model}` : 'ServiceNow unreachable'
    // Stub mode is coloured as a warning so nobody mistakes canned text for a real answer.
    healthEl.className = `pill ${!h.ok ? 'bad' : h.llmMode === 'stub' ? 'warn' : 'ok'}`
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

  const pending = bubble('bot typing', 'Working…')

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, conversationId }),
    })
    const data = await res.json()
    pending.className = 'msg bot'
    pending.textContent = ''

    const body = document.createElement('div')
    if (data.kind === 'metric') body.className = 'metric'
    body.textContent = data.answer ?? data.error ?? 'No response.'
    pending.appendChild(body)

    renderSources(pending, data)
  } catch {
    pending.className = 'msg bot'
    pending.textContent = 'Request failed.'
  }
})

loadHealth()
```

- [x] **Step 4: Verify by hand**

Without the gateway key, set `LLM_MODE=stub` in `.env` first. The health pill turns amber.

```bash
npm run dev
```

Open `http://localhost:3000` and check four states:

1. `Self-checkout lanes 1-4 down at Store #208 after image push` → an answer with a linked source; the link opens KB0010141 in abhrademo4. **In stub mode the prose is canned, but the article, the citation and the link are all real** — which is what this step verifies
2. `how many open incidents are there` → **"5,513 open incidents" in big type** (the number will have drifted), with `incident · count` and the filter `active=true` beneath it, and a link that opens exactly those records. In stub mode the query is a fixture, but the number and the link are live
3. `Hi Team,` → "No knowledge base match — not answered"
4. `what is the capital of France` → the same decline **with a live model**. In stub mode this is *answered*, citing whatever article search returned first — the stub always cites `[1]`. That is the stub being a fixture, not a bug; re-check this state once the key arrives

- [x] **Step 5: Commit**

```bash
git add public
git commit -m "feat: chat UI rendering article sources and metric filters"
```

---

## Task 7: Evals and acceptance run

**Files:**
- Create: `tools/eval.ts`, `tests/fixtures/metric-eval.json`
- Modify: `tests/fixtures/retrieval-eval.json` — its `_meta.purpose` still says "Calibrate RETRIEVAL_MIN_SCORE"; change it to "Retrieval regression test: recall@k over live ServiceNow search." Nothing else in the fixture changes

**Interfaces:**
- Consumes: everything
- Produces: `npm run eval`, `npm run eval -- --with-retry`, `npm run eval -- --metrics`

One script, three modes. They share config loading, the ServiceNow client, argument
parsing and summary formatting; two files would duplicate roughly forty lines to no end.

- [x] **Step 1: Implement `tools/eval.ts`**

```ts
import { readFileSync } from 'node:fs'
import { loadConfig } from '../src/config.js'
import { makeSnClient } from '../src/servicenow/client.js'
import { makeSearch } from '../src/servicenow/search.js'
import { makeStats } from '../src/servicenow/stats.js'
import { hasEnoughTokens } from '../src/guard.js'
import { makeLlm } from '../src/llm/client.js'

interface EvalQ {
  id: string
  source: string
  question: string
  expectedSysId?: string
  acceptableSysIds?: string[]
}

/** Baseline from spec §9. Falling below this is a regression. */
const BASELINE_AT1 = 26

const cfg = loadConfig()
const client = makeSnClient(cfg)
const sn = makeSearch(client)
const data = JSON.parse(readFileSync('tests/fixtures/retrieval-eval.json', 'utf8')) as {
  inScope: EvalQ[]
  outOfScope: EvalQ[]
}

/**
 * Three modes, one script:
 *   (default)      search only — deterministic, free, and the regression guard
 *   --with-retry   the full D13 path; costs Claude calls and varies run to run
 *   --metrics      composed-query correctness against tests/fixtures/metric-eval.json
 */
const METRICS = process.argv.includes('--metrics')
const WITH_RETRY = process.argv.includes('--with-retry')
const llm = METRICS || WITH_RETRY ? makeLlm(cfg) : null

const accept = (q: EvalQ) => q.acceptableSysIds ?? (q.expectedSysId ? [q.expectedSysId] : [])

/** Mirrors the server's retry branch so the eval measures what users actually get. */
async function lookup(question: string) {
  let articles = await sn.search(question)
  let retried = false

  if (llm) {
    const reply = await llm.decide({ question, articles, history: [] })
    if (reply.kind === 'search') {
      retried = true
      const second = await sn.search(reply.query)
      const seen = new Set(second.map((a) => a.id))
      articles = [...second, ...articles.filter((a) => !seen.has(a.id))]
    }
  }
  return { articles, retried }
}

/** Clause order carries no meaning: active=true^priority=1 equals priority=1^active=true. */
const clauses = (f: string) =>
  f.split('^').map((c) => c.trim()).filter(Boolean).sort().join('^')

/** --metrics: does the model compose a query that runs, against the right table? */
async function runMetrics(): Promise<void> {
  const stats = makeStats(client)
  const data = JSON.parse(readFileSync('tests/fixtures/metric-eval.json', 'utf8')) as {
    shouldAnswer: {
      id: string; question: string; table: string
      aggregate: string; field?: string; expectedFilter: string
    }[]
    shouldDecline: { id: string; question: string; why: string }[]
  }

  let executed = 0
  let exactFilter = 0
  let rightTable = 0

  console.log('=== SHOULD ANSWER ===')
  for (const q of data.shouldAnswer) {
    // Real conditions: metric questions still retrieve articles first, and those
    // articles are usually irrelevant. The model must not be distracted by them.
    const articles = await sn.search(q.question)
    const reply = await llm!.decide({ question: q.question, articles, history: [] })

    if (reply.kind !== 'metric') {
      console.log(`${q.id}  NOT A METRIC (${reply.kind})`)
      continue
    }

    const r = reply.request
    const tableOk = r.table === q.table
    const filterOk = clauses(r.filter) === clauses(q.expectedFilter)
    if (tableOk) rightTable++
    if (tableOk && filterOk) exactFilter++

    let value: string | number | 'ERROR' = 'ERROR'
    try {
      value = (await stats.run(r)).value
      executed++
    } catch (e) {
      console.log(`         execution failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    console.log(
      `${q.id}  ${tableOk ? 'table ok' : `table BAD(${r.table})`} ` +
        `${filterOk ? 'filter ok' : 'filter ~'}  = ${value}`,
    )
    if (!filterOk) {
      console.log(`         expected: ${q.expectedFilter}`)
      console.log(`         actual  : ${r.filter}`)
    }
  }

  console.log('\n=== SHOULD DECLINE ===')
  let declined = 0
  for (const q of data.shouldDecline) {
    const articles = await sn.search(q.question)
    const reply = await llm!.decide({ question: q.question, articles, history: [] })
    const ok = reply.kind !== 'metric'
    if (ok) declined++
    console.log(`${q.id}  ${ok ? 'declined' : 'INVENTED A QUERY <- investigate'}  (${q.why})`)
  }

  const n = data.shouldAnswer.length
  console.log('\n=== SUMMARY ===')
  console.log(`Executed cleanly  : ${executed}/${n}   <- the floor; 15/15 measured by hand`)
  console.log(`Right table       : ${rightTable}/${n}`)
  console.log(`Exact filter      : ${exactFilter}/${n}`)
  console.log(`Correctly declined: ${declined}/${data.shouldDecline.length}`)
  console.log('\nA "filter ~" is not automatically wrong — read it. Different clauses can be')
  console.log('equally defensible. What matters is that it executes and says what it counted.')

  if (executed < n) {
    console.error(`\nREGRESSION: ${n - executed} composed queries failed to execute`)
    process.exit(1)
  }
}

async function main() {
  if (METRICS) return runMetrics()

  const ranks: { id: string; rank: number; source: string }[] = []

  console.log(`=== IN-SCOPE ${WITH_RETRY ? '(with D13 retry)' : '(search only)'} ===`)
  let retryCount = 0
  for (const q of data.inScope) {
    const { articles: results, retried } = await lookup(q.question)
    if (retried) retryCount++
    const ok = accept(q)
    const rank = results.findIndex((a) => ok.includes(a.id)) + 1
    ranks.push({ id: q.id, rank, source: q.source })
    console.log(
      `${q.id.padEnd(9)} ${(rank ? `#${rank}` : 'MISS').padEnd(6)} ` +
        `${retried ? 'retry ' : '      '}${results[0]?.label ?? '-'}`,
    )
  }

  // Rev 8 removed the coverage floor, so noise rejection is no longer a deterministic
  // property — it is Claude's judgement. Without --with-retry all we can report is
  // which questions the token guard catches for free.
  console.log('\n=== OUT-OF-SCOPE ===')
  let guarded = 0
  let declined = 0
  for (const q of data.outOfScope) {
    if (!hasEnoughTokens(q.question)) {
      guarded++
      console.log(`${q.id.padEnd(12)} guarded (no model call)`)
      continue
    }
    if (!llm) {
      console.log(`${q.id.padEnd(12)} needs a model call to judge`)
      continue
    }
    const reply = await llm.decide({
      question: q.question,
      articles: await sn.search(q.question),
      history: [],
    })
    const good = reply.kind === 'no_answer'
    if (good) declined++
    console.log(`${q.id.padEnd(12)} ${good ? 'declined' : `ANSWERED (${reply.kind}) <- check this`}`)
  }

  const n = ranks.length
  const at = (k: number) => ranks.filter((r) => r.rank >= 1 && r.rank <= k).length
  const bySrc = (s: string) => {
    const all = ranks.filter((r) => r.source === s)
    return `${all.filter((r) => r.rank >= 1).length}/${all.length}`
  }

  console.log('\n=== SUMMARY ===')
  console.log(`Mode     : ${WITH_RETRY ? 'with D13 retry' : 'search only (deterministic)'}`)
  console.log(`Recall@1 : ${at(1)}/${n} (${Math.round((100 * at(1)) / n)}%)`)
  console.log(`Recall@5 : ${at(5)}/${n} (${Math.round((100 * at(5)) / n)}%)`)
  console.log(`incident : ${bySrc('incident')}   synthetic: ${bySrc('synthetic')}`)
  console.log(`Misses   : ${ranks.filter((r) => !r.rank).map((r) => r.id).join(', ') || 'none'}`)
  console.log(`Noise    : ${guarded} guarded free${llm ? `, ${declined} declined by the model` : ''}`)
  if (WITH_RETRY) {
    console.log(`Retries  : ${retryCount}/${n} questions triggered a rewrite`)
    console.log('Baseline without retry was 26/35 (74%) recall@1 — compare against that.')
  }

  // The guard applies only to the deterministic mode. Retry varies run to run, and a
  // regression gate on a wobbling number is worse than none.
  if (!WITH_RETRY && at(1) < BASELINE_AT1) {
    console.error(`\nREGRESSION: recall@1 ${at(1)} is below the recorded baseline of ${BASELINE_AT1}`)
    process.exit(1)
  }
}

main()
```

- [x] **Step 2: Create `tests/fixtures/metric-eval.json`**

The fifteen questions measured live on 2026-09-14 (spec §8b), plus five that must be
declined. `expectedFilter` is compared clause-by-clause, so order does not matter.

```json
{
  "shouldAnswer": [
    { "id": "m-01", "question": "how many open incidents are there",
      "table": "incident", "aggregate": "count", "expectedFilter": "active=true" },
    { "id": "m-02", "question": "how many P1 incidents are open",
      "table": "incident", "aggregate": "count", "expectedFilter": "active=true^priority=1" },
    { "id": "m-03", "question": "how many incidents are unassigned",
      "table": "incident", "aggregate": "count", "expectedFilter": "active=true^assigned_toISEMPTY" },
    { "id": "m-04", "question": "how many open incidents does the Network group have",
      "table": "incident", "aggregate": "count", "expectedFilter": "active=true^assignment_group.name=Network" },
    { "id": "m-05", "question": "how many incidents breached their SLA",
      "table": "task_sla", "aggregate": "count", "expectedFilter": "has_breached=true" },
    { "id": "m-06", "question": "how many security incidents are open",
      "table": "sn_si_incident", "aggregate": "count", "expectedFilter": "active=true" },
    { "id": "m-07", "question": "how many vulnerable items are there",
      "table": "sn_vul_vulnerable_item", "aggregate": "count", "expectedFilter": "" },
    { "id": "m-08", "question": "how many changes are open",
      "table": "change_request", "aggregate": "count", "expectedFilter": "active=true" },
    { "id": "m-09", "question": "how many problems are open",
      "table": "problem", "aggregate": "count", "expectedFilter": "active=true" },
    { "id": "m-10", "question": "how many incidents are on hold",
      "table": "incident", "aggregate": "count", "expectedFilter": "state=3" },
    { "id": "m-11", "question": "how many P1 incidents are still unresolved after 30 days",
      "table": "incident", "aggregate": "count", "expectedFilter": "active=true^priority=1^opened_at<javascript:gs.daysAgoStart(30)" },
    { "id": "m-12", "question": "what is the average resolution time for P2 incidents",
      "table": "incident", "aggregate": "avg", "field": "calendar_duration", "expectedFilter": "priority=2^state=6" },
    { "id": "m-13", "question": "how many incidents were resolved last month",
      "table": "incident", "aggregate": "count", "expectedFilter": "resolved_atONLast month@javascript:gs.beginningOfLastMonth()@javascript:gs.endOfLastMonth()" },
    { "id": "m-14", "question": "how many SLAs are close to breaching",
      "table": "task_sla", "aggregate": "count", "expectedFilter": "active=true^has_breached=false^percentage>80" },
    { "id": "m-15", "question": "how many incidents were opened this month",
      "table": "incident", "aggregate": "count", "expectedFilter": "opened_atONThis month@javascript:gs.beginningOfThisMonth()@javascript:gs.endOfThisMonth()" }
  ],
  "shouldDecline": [
    { "id": "d-01", "question": "what is our uptime",
      "why": "no uptime data exists anywhere in the instance" },
    { "id": "d-02", "question": "what is the average latency of the SAP service",
      "why": "no latency data exists; it lives in the client monitoring stack" },
    { "id": "d-03", "question": "how many incidents will we get next month",
      "why": "a forecast, not a query" },
    { "id": "d-04", "question": "how many synthetic checks failed overnight",
      "why": "no synthetic-check table exists" },
    { "id": "d-05", "question": "how many incidents did Priya close last week",
      "why": "a person's name that may not resolve to a user; must not be guessed at" }
  ]
}
```

- [x] **Step 3: Run all three modes**

```bash
npm run eval                    # works now — search only, no gateway needed
npm run eval -- --with-retry    # ⏸ BLOCKED until the gateway key is available
npm run eval -- --metrics       # ⏸ BLOCKED until the gateway key is available
```

**`npm run eval` (search only):** recall@1 at or above **26/35 (74%)** and recall@5 at or above **29/35 (83%)** — the spec §9 baseline. A lower number exits non-zero; investigate rather than lowering the baseline.

**`--with-retry`:** expect roughly **31/35 (89%)**. Costs Claude calls and varies between runs. **If retry does not beat the baseline meaningfully, say so and stop.** Setting `RETRY_ENABLED=false` and keeping the simpler system is a legitimate outcome, not a failure.

**`--metrics`:** every question must execute. 15/15 was measured by hand on 2026-09-14, so anything less is a regression in the prompt, not a surprise about the data. Filter mismatches need reading rather than counting — `stateIN6,7` versus `state=7` for "closed" is a real bug, while a differing date window may be equally defensible.

- [x] **Step 4: Run the full suite and a type check**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, no type errors — the type check covers `tests/` too, so a test calling a function with the wrong shape fails here.

- [x] **Step 5: Walk the acceptance criteria (spec §16)**

- [x] 1. `npm run dev` boots; gateway preflight passes; the ServiceNow probe succeeds
- [x] 2. `/api/health` shows ok, the model id, and ServiceNow reachable
- [x] 3. Five known questions answer correctly with working links — use `inc-01`, `inc-04`, `inc-06`, `syn-09`, `syn-18`
- [x] 4. `Hi Team,` gives `too_few_tokens` with **no Claude call at all** (confirm in the logs)
- [ ] 5. ⏸ *needs the key* — `what is the capital of France` gives `model_declined` with no second search
- [ ] 6. ⏸ *needs the key* — `new joiner starts on monday` is **answered correctly**, `retried: true`, rewritten query in the logs
- [ ] 7. ⏸ *needs the key* — no question ever logs two retries
- [x] 8. **`how many open incidents are there` returns "N open incidents", the filter `active=true`, and a link whose record count equals N.** This is the acceptance test for the metrics path
- [x] 9. `how many incidents are on hold` returns 1, matching the QBR On-Hold tile
- [ ] 10. ⏸ *needs the key* — `what is our uptime` is declined, not answered from an approximate metric
- [x] 11. `npm run eval` recall is unchanged from the revision 5 baseline (26/35 @1, 29/35 @5). This is the article-regression check; there is no other repository to compare against
- [x] 12. Temporarily set `SN_INSTANCE_URL=https://invalid.example.com` and confirm "cannot reach the knowledge base", **not** "no match". Restore afterwards
- [x] 13. No secrets in captured logs — search them for `sk-` and for the client id
- [x] 14. A metric reply naming a table such as `../oauth_token.do` (forced in a test) is declined before any request leaves the process

- [x] **Step 6: Commit**

```bash
git add tools tests/fixtures
git commit -m "feat: article and metric evals with acceptance walkthrough"
```

---

## Things that will bite you

- **Use `Article.id`, never `label`.** `KB0010004` maps to four different articles on abhrademo4. Any lookup, comparison or link keyed on the number is a bug waiting for a demo.
- **Gateway model ids are renamed by LiteLLM** — yours is `claude-opus-4-8-Codon`. A wrong id fails at *runtime with a plausible answer*, not at startup, which is why preflight exists. Never hardcode a public Anthropic id as a fallback.
- **The API key is the Key Vault secret's VALUE**, not its name and not its version. A 32-character hex string is a version identifier.
- **`123TEXTQUERY321` needs sanitising.** A `^` or `=` in the user's question breaks `sysparm_query` and produces confusing results rather than an error.
- **The metric filter is NOT sanitised** — it is a `sysparm_query` by design and `^` is its clause separator. It goes through `URLSearchParams`, never string concatenation, and never through `sanitiseQuery`. **The table name IS shape-checked**, because it is the one model-supplied value that lands in a URL path.
- **"Closed" is two states.** `state=6` is Resolved and `state=7` is Closed. A query using only one silently undercounts, and the number looks perfectly reasonable. This is the single likeliest wrong answer the system will produce.
- **ServiceNow does not reject a bad filter.** `sysparm_query=this is not a query!!` on `/stats/incident` returned 36,030 — the whole table — with HTTP 200. `GROUPBYpriority` likewise returned the ungrouped total. Both are caught before the request now (`isEncodedQuery`, GROUPBY check in `parseReply`); do not remove them on the theory that the instance will complain.
- **ServiceNow does not reject an unknown field either.** `product_type=full` on `alm_license` counted all 202 rows because the column does not exist. `stats.run` now fetches one record asking for the filter's fields and declines if any is missing from the response (`filterFields` + probe). Costs one extra GET per metric turn; keep it.
- **Resolved incidents are `active=true` on this instance.** "Open" therefore has two defensible readings (5,513 active vs 5,388 in states 1–3). The prompt maps "unresolved / not yet resolved" to `stateIN1,2,3`; the rendered filter shows which was used.
- **Averaging a text field returns a number.** `avg(short_description)` gave 35,245,419. Accepted and displayed with the field name (spec §8b); fixing it needs a dictionary lookup, which is a subsystem.
- **ServiceNow returns aggregates as strings**, and durations as `HH:MM:SS`. `Number('00:43:22')` is `NaN` — hence the `coerce` helper.
- **The token guard runs before searching.** Do not "simplify" by searching first — greeting-shaped noise should never reach the instance or the model.
- **PowerShell scalar trap, if you script against this.** A one-element ServiceNow result is a scalar whose `.Count` is `$null`, so `for ($i=0; $i -lt $r.Count; ...)` never runs. Always `@()`-wrap. This once made an eval report 54% when the true figure was 80%.
- **Expect most real traffic to be declined.** Of 36,030 incidents on abhrademo4, most are monitoring alerts and fragments. A high decline rate is the system working.
- **`.env` holds live secrets** and is gitignored. Check `git status` before `git add -A`.
- **Node's `--env-file` treats an unquoted `#` as an inline comment.** The abhrademo4 client secret contains one, so an unquoted value loads truncated and every token refresh fails with HTTP 401 `access_denied` — which looks exactly like an expired refresh token. `Export-SnEnvFile` and `set-gateway-env.ps1` now write values double-quoted. If a 401 appears after hand-editing `.env`, check the quotes before re-authorising.

---

## Spec coverage

| Spec section | Tasks |
|---|---|
| §4 architecture | 2, 3, 5 |
| §5 decisions | D1 T1 · D2 T2 · D3 T6 · D4 T4, T5 · D5 T2 · D6 T4 · D7 (nothing to build) · D8 T1 · D9 withdrawn · D10 T2, T4 · D11 T1, T5 · D12 (nothing to build) · D13 T5 · D14 T3, T4 · D15 withdrawn · D16 T4, T5 |
| §6 layout | 1–7 |
| §7 config and gateway rules | 1, 4 |
| §8 ServiceNow search | 2 |
| §8b metrics path | 3, 4, 5, 6 |
| §9 gate and eval | 1, 5, 7 |
| §10 prompt and citations | 4 |
| §11 API contract | 5 |
| §12 frontend | 6 |
| §13 error handling | 2, 3, 5 |
| §14 observability | 1, 5 |
| §15 testing | every task |
| §16 acceptance | 7 |
