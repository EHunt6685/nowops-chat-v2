# NowOps Chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Express/TypeScript service that answers questions from the abhrademo4 ServiceNow knowledge base using Claude via the UST LLM gateway, grounded in a hand-rolled BM25 index and citing every source by `sys_id`.

**Architecture:** Four pure-ish modules — `servicenow/` (OAuth + fetch), `index/` (strip, tokenise, BM25), `llm/` (prompt, citation verification, preflight), `server/` (routes, state) — plus a `main.ts` boot sequence. The corpus is ~200 short articles held in memory; there is no database, no embeddings and no vector store. Retrieval decides "I don't know" before the model is ever called.

**Tech Stack:** Node 22+, TypeScript (ESM, `NodeNext`), Express 5, `@anthropic-ai/sdk`, `zod`, `dotenv`; dev-only `tsx`, `vitest`, `typescript`, `@types/*`.

**Spec:** [docs/superpowers/specs/2026-09-13-nowops-chatbot-design.md](../specs/2026-09-13-nowops-chatbot-design.md)

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 22 LTS floor.** `.nvmrc` pins `22`; `package.json` sets `"engines": { "node": ">=22" }`. The dev machine runs v24.18.0, which satisfies it.
- **Runtime dependencies are exactly four:** `express`, `@anthropic-ai/sdk`, `dotenv`, `zod`. Dev-only: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/express`. **Adding any other dependency is a plan violation** — raise it rather than installing it.
- **BM25 is hand-rolled**, ~40 lines, no retrieval library (spec §6).
- **`sys_id` is the identity key everywhere** (D10). Article `number` is not unique on abhrademo4 — `KB0010004` maps to four different articles. `number` is a display label only. Article links use `kb_view.do?sys_kb_id=<sys_id>`, never `sysparm_article=<number>`.
- **The model cites bracketed labels `[1]`–`[5]`, never KB numbers** (D10, spec §10). The server maps labels back to `sys_id`.
- **The knowledge base allowlist is keyed by knowledge base `sys_id`** (D9), because the 9 most valuable knowledge bases have ACL-restricted records with no readable title.
- **No `GET /v1/models` discovery against the gateway** (spec §7 rule 1). The model list is explicit configuration.
- **Startup preflight is mandatory** (spec §7 rule 2). A wrong gateway model id is a silent wrong answer, so it must be a boot failure.
- **No secret ever reaches a log line** (spec §7 rule 4, acceptance criterion 6).
- **TDD.** Every task writes the failing test first, watches it fail, then implements. Commit at the end of each task.
- ESM with `"module": "NodeNext"` — **all relative imports carry a `.js` extension**, including in tests (`import { tokenize } from '../src/index/build.js'`).

### Spec deviations this plan makes, and why

Three, all small, all deliberate:

1. **`src/main.ts` is added** to the spec §6 layout. The spec's startup sequence needs somewhere to live, and keeping it out of `app.ts` lets integration tests import the app without booting the network.
2. **`scripts/` is added** for two one-off operator scripts (allowlist discovery, threshold calibration). They are not shipped code and are not imported by `src/`.
3. **Spec §4 step 4 says retrieved articles enter the prompt "carrying their KB numbers".** This contradicts §10 and D10, which are newer. **§10 wins:** labels in, `sys_id` out.

### Inputs still missing at plan time

- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_MODEL`, `CLAUDE_MODEL_CHOICES` — held by the project owner. Tasks 1–7 and 9 do not need them (tests stub the SDK). **Tasks 8 and 10 are blocked without them.**
- `SN_KB_ALLOWLIST` — **produced by Task 5**, not supplied.
- `RETRIEVAL_MIN_SCORE` — **produced by Task 6**, not supplied.
- `SN_INSTANCE_URL`, `SN_CLIENT_ID`, `SN_CLIENT_SECRET`, `SN_REFRESH_TOKEN` are already in `.env` (written 2026-09-13 by `Export-SnEnvFile`).

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.nvmrc`, `.env.example` | Project setup, Node pin, committed env template |
| `src/types.ts` | `Article`, `Scored`, `Turn`, `Source` — shared shapes, no logic |
| `src/config.ts` | zod env schema, `loadConfig(overrides?)`, `mask()`, `redact()` |
| `src/index/build.ts` | `stripHtml`, `tokenize`, `isCode`, `buildIndex`, scoring constants |
| `src/index/search.ts` | `search(index, query, topK)` — BM25 + title weight + code boost |
| `src/servicenow/auth.ts` | `getAccessToken`, `resetTokenCache` — refresh-token grant with cache |
| `src/servicenow/articles.ts` | `mapArticle`, `fetchArticles`, `articleUrl` — paged `kb_knowledge` fetch |
| `src/llm/client.ts` | `buildContextBlock`, `extractCitations`, `answerQuestion`, `preflight`, `SYSTEM_PROMPT` |
| `src/server/routes.ts` | `createRoutes(deps)` — `/api/chat`, `/api/sync`, `/api/health`; `AppState`; `pickModel` |
| `src/server/app.ts` | `createApp(deps)` — Express, JSON body, static `public/` |
| `src/main.ts` | Boot sequence: config → preflight → token → fetch → index → listen |
| `public/index.html`, `public/app.js`, `public/styles.css` | Chat UI, model picker, three-state source line |
| `scripts/discover-allowlist.ts` | One-off: group live articles by `kb_knowledge_base` sys_id (Task 5) |
| `scripts/calibrate.ts` | One-off: sweep the threshold against the eval set (Task 6) |
| `tests/fixtures/retrieval-eval.json` | **Exists already** — 35 in-scope, 10 out-of-scope |
| `tests/fixtures/kb-articles.json` | Raw `kb_knowledge` API response, captured in Task 5 |

---

## Task 1: Project scaffold and configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `.nvmrc`, `.env.example`, `src/types.ts`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config` (the inferred zod type), `loadConfig(overrides?: Partial<RawEnv>, source?: NodeJS.ProcessEnv): Config`, `mask(secret: string): string`, `redact(text: string, cfg: Config): string`, `SECRET_ENV_KEYS`. And the shared types `Article`, `Scored`, `Turn`, `Source` from `src/types.ts`.

**Why `loadConfig` takes a `source`:** it merges `process.env` by default, and `dotenv/config` loads the developer's real `.env`. Without an explicit source, every test asserting a default or a missing variable would depend on what happens to be in that file, and real secrets could end up inside test assertions. **Tests always call `loadConfig(values, {})`.**

- [ ] **Step 1: Create `.nvmrc`**

```
22
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "nowops-chat",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc",
    "start": "node dist/main.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.65.0",
    "dotenv": "^17.2.0",
    "express": "^5.1.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `package-lock.json` created, no vulnerabilities blocking. If `npm install` reports a major version of any dependency different from the ranges above, keep the installed version and note it — do not add packages.

- [ ] **Step 5: Create `src/types.ts`**

```ts
/** A knowledge base article, HTML already stripped from `body`. */
export type Article = {
  /** The only safe identifier on this instance — `number` is not unique (D10). */
  sysId: string;
  /** Display label only. Never used to resolve or link an article. */
  number: string;
  title: string;
  body: string;
  /** sys_id of the owning kb_knowledge_base record. */
  kbSysId: string;
  category: string;
};

export type Scored = { article: Article; score: number };

export type Turn = { role: 'user' | 'assistant'; content: string };

export type Source = {
  number: string;
  title: string;
  sysId: string;
  score: number;
  url: string;
};
```

- [ ] **Step 6: Write the failing test**

Create `tests/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, mask, redact } from '../src/config.js';

const VALID = {
  ANTHROPIC_API_KEY: 'sk-abc123456789wxyz',
  ANTHROPIC_BASE_URL: 'https://llmproxy.example.com',
  CLAUDE_MODEL: 'gateway-claude-model',
  SN_INSTANCE_URL: 'https://abhrademo4.service-now.com',
  SN_CLIENT_ID: 'client-id',
  SN_CLIENT_SECRET: 'super-secret-value',
  SN_REFRESH_TOKEN: 'refresh-token-value',
  SN_KB_ALLOWLIST: 'aaa111,bbb222',
  RETRIEVAL_MIN_SCORE: '4.2',
};

describe('mask', () => {
  it('shows a prefix and suffix but never the middle', () => {
    expect(mask('sk-abc123456789wxyz')).toBe('sk-ab…wxyz');
  });

  it('refuses to leak anything from a short secret', () => {
    expect(mask('short')).toBe('***');
  });
});

// Second argument `{}` replaces process.env, so no test depends on the real .env.
describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const cfg = loadConfig(VALID, {});
    expect(cfg.RETRIEVAL_TOP_K).toBe(5);
    expect(cfg.RETRIEVAL_MIN_SCORE).toBe(4.2);
    expect(cfg.PORT).toBe(3000);
  });

  it('throws a message naming every missing variable', () => {
    const { ANTHROPIC_API_KEY, SN_CLIENT_SECRET, ...partial } = VALID;
    expect(() => loadConfig(partial, {})).toThrowError(/ANTHROPIC_API_KEY[\s\S]*SN_CLIENT_SECRET/);
  });

  it('ignores process.env when a source is supplied', () => {
    expect(() => loadConfig({}, { ...VALID })).not.toThrow();
    expect(() => loadConfig({}, {})).toThrowError(/ANTHROPIC_API_KEY/);
  });

  it('rejects a base URL that is not a URL', () => {
    expect(() => loadConfig({ ...VALID, ANTHROPIC_BASE_URL: 'llmproxy' }, {})).toThrowError(
      /ANTHROPIC_BASE_URL/,
    );
  });

  it('splits the model choices and always includes the default model', () => {
    const cfg = loadConfig({ ...VALID, CLAUDE_MODEL_CHOICES: 'model-a, model-b' }, {});
    expect(cfg.modelChoices).toEqual(['gateway-claude-model', 'model-a', 'model-b']);
  });

  it('defaults model choices to the single configured model', () => {
    expect(loadConfig(VALID, {}).modelChoices).toEqual(['gateway-claude-model']);
  });

  it('does not duplicate the default model when it also appears in the choices', () => {
    const cfg = loadConfig({ ...VALID, CLAUDE_MODEL_CHOICES: 'gateway-claude-model, model-a' }, {});
    expect(cfg.modelChoices).toEqual(['gateway-claude-model', 'model-a']);
  });

  it('splits the knowledge base allowlist on commas', () => {
    expect(loadConfig(VALID, {}).kbAllowlist).toEqual(['aaa111', 'bbb222']);
  });
});

describe('redact', () => {
  it('masks every secret value wherever it appears in a log line', () => {
    const cfg = loadConfig(VALID, {});
    const line = `POST failed key=sk-abc123456789wxyz secret=super-secret-value`;
    const out = redact(line, cfg);
    expect(out).not.toContain('sk-abc123456789wxyz');
    expect(out).not.toContain('super-secret-value');
    expect(out).toContain('sk-ab…wxyz');
  });

  it('leaves non-secret config values alone', () => {
    const cfg = loadConfig(VALID, {});
    expect(redact('model=gateway-claude-model', cfg)).toBe('model=gateway-claude-model');
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — `Failed to resolve import "../src/config.js"`.

- [ ] **Step 8: Implement `src/config.ts`**

```ts
import 'dotenv/config';
import { z } from 'zod';

/**
 * Explicit deny-list of env vars whose values must never reach a log line.
 * Spec §7 rule 4 — masking is by value, so a secret is caught wherever it is
 * interpolated, not only where someone remembered to mask it.
 */
export const SECRET_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'SN_CLIENT_SECRET',
  'SN_REFRESH_TOKEN',
] as const;

const Env = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_BASE_URL: z.string().url(),
  CLAUDE_MODEL: z.string().min(1),
  CLAUDE_MODEL_CHOICES: z.string().optional(),

  SN_INSTANCE_URL: z.string().url(),
  SN_CLIENT_ID: z.string().min(1),
  SN_CLIENT_SECRET: z.string().min(1),
  SN_REFRESH_TOKEN: z.string().min(1),
  SN_KB_ALLOWLIST: z.string().min(1),

  RETRIEVAL_TOP_K: z.coerce.number().int().positive().default(5),
  RETRIEVAL_MIN_SCORE: z.coerce.number().nonnegative(),

  PORT: z.coerce.number().int().positive().default(3000),
  MAX_MESSAGE_CHARS: z.coerce.number().int().positive().default(2000),
  CONTEXT_CHAR_BUDGET: z.coerce.number().int().positive().default(12000),
});

export type RawEnv = z.input<typeof Env>;
export type Config = z.output<typeof Env> & {
  modelChoices: string[];
  kbAllowlist: string[];
};

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Spec §7 rule 3: override ?? env ?? throw, so a gateway move needs no code change.
 * `source` exists so tests can pass `{}` and stay independent of the real .env.
 */
export function loadConfig(
  overrides: Partial<RawEnv> = {},
  source: NodeJS.ProcessEnv = process.env,
): Config {
  const parsed = Env.safeParse({ ...source, ...overrides });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const env = parsed.data;
  const choices = splitList(env.CLAUDE_MODEL_CHOICES);
  return {
    ...env,
    modelChoices: [env.CLAUDE_MODEL, ...choices.filter((m) => m !== env.CLAUDE_MODEL)],
    kbAllowlist: splitList(env.SN_KB_ALLOWLIST),
  };
}

/** `sk-abc12…wxyz`. Anything too short to mask safely becomes `***`. */
export function mask(secret: string): string {
  if (secret.length <= 9) return '***';
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`;
}

/** Replace every configured secret value with its mask. Use on anything logged. */
export function redact(text: string, cfg: Config): string {
  let out = text;
  for (const key of SECRET_ENV_KEYS) {
    const value = cfg[key];
    if (value) out = out.split(value).join(mask(value));
  }
  return out;
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -- tests/config.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 10: Create `.env.example` (placeholders only — never real values)**

```
# ---- LLM gateway (from the project owner) ----
ANTHROPIC_API_KEY=sk-replace-me
ANTHROPIC_BASE_URL=https://llmproxy.example.com
CLAUDE_MODEL=replace-with-exact-gateway-model-id
# Optional, comma-separated; powers the UI model picker
CLAUDE_MODEL_CHOICES=

# ---- ServiceNow abhrademo4 ----
SN_INSTANCE_URL=https://abhrademo4.service-now.com
SN_CLIENT_ID=replace-me
SN_CLIENT_SECRET=replace-me
SN_REFRESH_TOKEN=replace-me
# Comma-separated knowledge base sys_ids, NOT titles (D9).
# Produced by: npx tsx scripts/discover-allowlist.ts
SN_KB_ALLOWLIST=

# ---- Retrieval ----
RETRIEVAL_TOP_K=5
# Produced by: npx tsx scripts/calibrate.ts
RETRIEVAL_MIN_SCORE=

# ---- Server ----
PORT=3000
MAX_MESSAGE_CHARS=2000
CONTEXT_CHAR_BUDGET=12000
```

- [ ] **Step 11: Verify `.env` is still ignored**

Run: `git status --porcelain && git check-ignore -v .env`
Expected: `.env` does not appear in `git status`; `check-ignore` prints the `.gitignore:2:.env` rule. **If `.env` appears as untracked, stop and fix `.gitignore` before committing anything.**

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json .nvmrc .env.example src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: project scaffold, validated config, secret masking"
```

---

## Task 2: HTML stripping, tokenisation and index building

**Files:**
- Create: `src/index/build.ts`
- Test: `tests/index-build.test.ts`

**Interfaces:**
- Consumes: `Article` from `src/types.ts`.
- Produces: `stripHtml(html: string): string`, `tokenize(text: string): string[]`, `isCode(token: string): boolean`, `buildIndex(articles: Article[]): KbIndex`, and the constants `K1`, `B`, `TITLE_WEIGHT`, `CODE_BOOST`. Types `IndexedDoc` and `KbIndex`:

```ts
export type IndexedDoc = {
  article: Article;
  /** Weighted term frequency: title terms count TITLE_WEIGHT times. */
  tf: Map<string, number>;
  /** Weighted document length, consistent with `tf`. */
  len: number;
  /** Tokens that look like identifiers or error codes. */
  codes: Set<string>;
};
export type KbIndex = {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLen: number;
  n: number;
};
```

- [ ] **Step 1: Write the failing test**

Create `tests/index-build.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildIndex, isCode, stripHtml, tokenize, TITLE_WEIGHT } from '../src/index/build.js';
import type { Article } from '../src/types.js';

const article = (over: Partial<Article> = {}): Article => ({
  sysId: 'sys-1',
  number: 'KB0010001',
  title: 'VPN will not connect',
  body: 'Restart the VPN client and retry.',
  kbSysId: 'kb-1',
  category: 'network',
  ...over,
});

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello   <b>world</b></p>')).toBe('Hello world');
  });

  it('drops script and style content entirely', () => {
    expect(stripHtml('<style>.a{color:red}</style><p>Keep</p><script>alert(1)</script>')).toBe(
      'Keep',
    );
  });

  it('decodes the entities ServiceNow actually emits', () => {
    expect(stripHtml('a&nbsp;&amp;&nbsp;b &lt;tag&gt; &quot;q&quot; &#39;s&#39;')).toBe(
      `a & b <tag> "q" 's'`,
    );
  });

  it('inserts a boundary where block tags ran two words together', () => {
    expect(stripHtml('<li>one</li><li>two</li>')).toBe('one two');
  });

  it('handles an empty body', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('tokenize', () => {
  it('lowercases, splits on punctuation and drops stopwords', () => {
    expect(tokenize('The VPN is not connecting!')).toEqual(['vpn', 'connecting']);
  });

  it('keeps identifiers intact as single tokens', () => {
    expect(tokenize('See KB0010096 for details')).toContain('kb0010096');
  });

  it('turns bracketed alert codes into plain tokens', () => {
    expect(tokenize('Critical alert [Alert2276070] .')).toEqual([
      'critical',
      'alert',
      'alert2276070',
    ]);
  });

  it('returns nothing for punctuation-only input', () => {
    expect(tokenize('... !!! ---')).toEqual([]);
  });
});

describe('isCode', () => {
  it('treats a token with three or more consecutive digits as a code', () => {
    expect(isCode('kb0010096')).toBe(true);
    expect(isCode('alert2276070')).toBe(true);
  });

  it('does not treat ordinary words or small numbers as codes', () => {
    expect(isCode('printer')).toBe(false);
    expect(isCode('lanes')).toBe(false);
    expect(isCode('24')).toBe(false);
  });
});

describe('buildIndex', () => {
  it('weights title terms above body terms', () => {
    const index = buildIndex([article({ title: 'vpn', body: 'vpn' })]);
    expect(index.docs[0]!.tf.get('vpn')).toBe(TITLE_WEIGHT + 1);
  });

  it('counts document frequency once per document', () => {
    const index = buildIndex([
      article({ sysId: 'a', title: 'vpn vpn vpn', body: 'vpn' }),
      article({ sysId: 'b', title: 'printer', body: 'printer' }),
    ]);
    expect(index.df.get('vpn')).toBe(1);
    expect(index.n).toBe(2);
  });

  it('collects code tokens from title and body', () => {
    const index = buildIndex([article({ title: 'Error KB0010096', body: 'code [ORA12154]' })]);
    expect(index.docs[0]!.codes).toEqual(new Set(['kb0010096', 'ora12154']));
  });

  it('computes average weighted length', () => {
    const index = buildIndex([article({ title: 'a b', body: 'c' })]);
    expect(index.avgLen).toBe(2 * TITLE_WEIGHT + 1);
  });

  it('survives an empty corpus without dividing by zero', () => {
    const index = buildIndex([]);
    expect(index).toMatchObject({ n: 0, avgLen: 0 });
    expect(index.docs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/index-build.test.ts`
Expected: FAIL — `Failed to resolve import "../src/index/build.js"`.

- [ ] **Step 3: Implement `src/index/build.ts`**

```ts
import type { Article } from '../types.js';

/** BM25 term-frequency saturation. */
export const K1 = 1.5;
/** BM25 length normalisation. */
export const B = 0.75;
/** Spec §9: on ~217-character articles the title carries most of the signal. */
export const TITLE_WEIGHT = 3;
/** Spec §9: users paste error codes, and BM25 under-weights a rare token that is the whole query. */
export const CODE_BOOST = 8;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on',
  'or', 'our', 'so', 'that', 'the', 'then', 'there', 'this', 'to', 'up', 'was', 'we', 'what',
  'when', 'where', 'which', 'will', 'with', 'you', 'your',
]);

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/** ServiceNow article bodies are HTML. Strip to plain text for both indexing and the prompt. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lowercase, split on anything non-alphanumeric, drop stopwords.
 * No stemming (spec §9) — on articles this short it hurts as often as it helps.
 * Splitting on punctuation is what turns `[Alert2276070]` into `alert2276070`.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** An identifier or error code: any token carrying a run of three or more digits. */
export function isCode(token: string): boolean {
  return /\d{3,}/.test(token);
}

export type IndexedDoc = {
  article: Article;
  tf: Map<string, number>;
  len: number;
  codes: Set<string>;
};

export type KbIndex = {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLen: number;
  n: number;
};

export function buildIndex(articles: Article[]): KbIndex {
  const docs: IndexedDoc[] = articles.map((article) => {
    const titleTokens = tokenize(article.title);
    const bodyTokens = tokenize(article.body);
    const tf = new Map<string, number>();
    for (const t of titleTokens) tf.set(t, (tf.get(t) ?? 0) + TITLE_WEIGHT);
    for (const t of bodyTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return {
      article,
      tf,
      len: titleTokens.length * TITLE_WEIGHT + bodyTokens.length,
      codes: new Set([...titleTokens, ...bodyTokens].filter(isCode)),
    };
  });

  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);

  const n = docs.length;
  const avgLen = n === 0 ? 0 : docs.reduce((sum, d) => sum + d.len, 0) / n;
  return { docs, df, avgLen, n };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/index-build.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/index/build.ts tests/index-build.test.ts
git commit -m "feat: HTML stripping, tokeniser and weighted BM25 index build"
```

---

## Task 3: BM25 search with title weighting and exact-code boost

**Files:**
- Create: `src/index/search.ts`
- Test: `tests/index-search.test.ts`

**Interfaces:**
- Consumes: `KbIndex`, `tokenize`, `isCode`, `K1`, `B`, `CODE_BOOST` from `src/index/build.js`; `Scored`, `Article` from `src/types.js`.
- Produces: `search(index: KbIndex, query: string, topK: number): Scored[]` — descending by score, zero-scoring documents excluded, at most `topK` entries.

- [ ] **Step 1: Write the failing test**

Create `tests/index-search.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/index/build.js';
import { search } from '../src/index/search.js';
import type { Article } from '../src/types.js';

const article = (sysId: string, title: string, body: string): Article => ({
  sysId,
  number: `KB${sysId}`,
  title,
  body,
  kbSysId: 'kb-1',
  category: 'test',
});

const corpus = buildIndex([
  article('a', 'VPN will not connect', 'Users cannot establish a VPN session from home.'),
  article('b', 'Printer label formatting', 'Information does not fit into the label template.'),
  article('c', 'Self-checkout NCR terminal will not boot after image push', 'Reimage the lane.'),
  article('d', 'Reference KB0010096', 'Unrelated body text about stationery orders.'),
]);

describe('search', () => {
  it('ranks the article whose title matches the query first', () => {
    const [top] = search(corpus, 'cannot connect to VPN', 5);
    expect(top!.article.sysId).toBe('a');
  });

  it('returns at most topK results', () => {
    expect(search(corpus, 'the label will not connect boot', 2)).toHaveLength(2);
  });

  it('sorts strictly by descending score', () => {
    const scores = search(corpus, 'label printer VPN boot', 5).map((r) => r.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });

  it('excludes documents that match nothing', () => {
    expect(search(corpus, 'zzzz nonexistent term', 5)).toEqual([]);
  });

  it('returns nothing for a query of pure stopwords', () => {
    expect(search(corpus, 'the and of it', 5)).toEqual([]);
  });

  it('boosts an exact code match above a stronger prose match', () => {
    const [top] = search(corpus, 'KB0010096', 5);
    expect(top!.article.sysId).toBe('d');
  });

  it('does not boost a code that appears in no document', () => {
    expect(search(corpus, 'Critical alert [Alert2276070]', 5).map((r) => r.article.sysId)).not.toContain('d');
  });

  it('returns an empty array for an empty index', () => {
    expect(search(buildIndex([]), 'anything', 5)).toEqual([]);
  });

  it('keeps distinct articles that share a KB number separable by sysId (D10)', () => {
    const dupes = buildIndex([
      { ...article('x', 'Self-checkout NCR terminal will not boot', 'Lane reimage.'), number: 'KB0010141' },
      { ...article('y', 'Epson receipt printer has stopped printing', 'Replace roll.'), number: 'KB0010141' },
    ]);
    const results = search(dupes, 'epson receipt printer stopped printing', 5);
    expect(results[0]!.article.sysId).toBe('y');
    expect(results[0]!.article.number).toBe('KB0010141');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/index-search.test.ts`
Expected: FAIL — `Failed to resolve import "../src/index/search.js"`.

- [ ] **Step 3: Implement `src/index/search.ts`**

```ts
import { B, CODE_BOOST, isCode, K1, tokenize, type KbIndex } from './build.js';
import type { Scored } from '../types.js';

/**
 * Okapi BM25 over the weighted index, plus a flat additive boost for each
 * query identifier that appears literally in a document (spec §9).
 */
export function search(index: KbIndex, query: string, topK: number): Scored[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || index.n === 0) return [];

  const uniqueTerms = new Set(queryTokens);
  const queryCodes = new Set([...uniqueTerms].filter(isCode));

  const scored: Scored[] = index.docs.map((doc) => {
    let score = 0;
    for (const term of uniqueTerms) {
      const df = index.df.get(term);
      const f = doc.tf.get(term);
      if (!df || !f) continue;
      const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
      const norm = f + K1 * (1 - B + (B * doc.len) / index.avgLen);
      score += (idf * f * (K1 + 1)) / norm;
    }
    for (const code of queryCodes) if (doc.codes.has(code)) score += CODE_BOOST;
    return { article: doc.article, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/index-search.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/index/search.ts tests/index-search.test.ts
git commit -m "feat: BM25 search with title weighting and exact-code boost"
```

---

## Task 4: ServiceNow OAuth and article fetch

**Files:**
- Create: `src/servicenow/auth.ts`, `src/servicenow/articles.ts`
- Test: `tests/servicenow.test.ts`

**Interfaces:**
- Consumes: `Config` from `src/config.js`; `Article` from `src/types.js`; `stripHtml` from `src/index/build.js`.
- Produces:
  - `getAccessToken(cfg: Config, now?: () => number): Promise<string>`
  - `resetTokenCache(): void`
  - `mapArticle(raw: RawArticle): Article`
  - `fetchArticles(cfg: Config, token: string): Promise<Article[]>`
  - `articleUrl(instanceUrl: string, sysId: string): string`
  - `type RawArticle` — the `kb_knowledge` row shape, where reference fields are `{ value, link }`.

- [ ] **Step 1: Write the failing test**

Create `tests/servicenow.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { getAccessToken, resetTokenCache } from '../src/servicenow/auth.js';
import { articleUrl, fetchArticles, mapArticle } from '../src/servicenow/articles.js';

const cfg = loadConfig(
  {
    ANTHROPIC_API_KEY: 'sk-abc123456789wxyz',
    ANTHROPIC_BASE_URL: 'https://llmproxy.example.com',
    CLAUDE_MODEL: 'gateway-model',
    SN_INSTANCE_URL: 'https://abhrademo4.service-now.com',
    SN_CLIENT_ID: 'cid',
    SN_CLIENT_SECRET: 'csecret',
    SN_REFRESH_TOKEN: 'rtoken',
    SN_KB_ALLOWLIST: 'kb-aaa,kb-bbb',
    RETRIEVAL_MIN_SCORE: '1',
  },
  {},
);

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.restoreAllMocks();
  resetTokenCache();
});

describe('getAccessToken', () => {
  it('exchanges the refresh token and returns the access token', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okJson({ access_token: 'at-1', expires_in: 1800 }));

    await expect(getAccessToken(cfg)).resolves.toBe('at-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://abhrademo4.service-now.com/oauth_token.do');
    const body = String((init as RequestInit).body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=rtoken');
  });

  it('reuses a cached token instead of refreshing again', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okJson({ access_token: 'at-1', expires_in: 1800 }));

    await getAccessToken(cfg);
    await getAccessToken(cfg);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes again once the cached token is inside the expiry margin', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okJson({ access_token: 'at-1', expires_in: 1800 }));

    let clock = 0;
    await getAccessToken(cfg, () => clock);
    clock = 1_800_000;
    await getAccessToken(cfg, () => clock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws a message naming the status when the grant is rejected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid_grant"}', { status: 401 }),
    );
    await expect(getAccessToken(cfg)).rejects.toThrowError(/401[\s\S]*invalid_grant/);
  });

  it('never puts the refresh token or client secret in the error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 400 }));
    await expect(getAccessToken(cfg)).rejects.toThrowError(
      expect.objectContaining({ message: expect.not.stringContaining('rtoken') }),
    );
  });
});

describe('mapArticle', () => {
  it('unwraps reference fields and strips HTML from the body', () => {
    expect(
      mapArticle({
        sys_id: 'sys-1',
        number: 'KB0010141',
        short_description: 'VPN will not connect',
        text: '<p>Restart the <b>client</b>.</p>',
        kb_category: { value: 'cat-1', link: 'https://x/cat-1' },
        kb_knowledge_base: { value: 'kb-aaa', link: 'https://x/kb-aaa' },
      }),
    ).toEqual({
      sysId: 'sys-1',
      number: 'KB0010141',
      title: 'VPN will not connect',
      body: 'Restart the client.',
      kbSysId: 'kb-aaa',
      category: 'cat-1',
    });
  });

  it('tolerates missing optional fields', () => {
    const mapped = mapArticle({ sys_id: 's', number: 'KB1', short_description: 'T' });
    expect(mapped.body).toBe('');
    expect(mapped.kbSysId).toBe('');
    expect(mapped.category).toBe('');
  });
});

describe('fetchArticles', () => {
  it('queries published articles restricted to the allowlisted knowledge base sys_ids', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ result: [] }));
    await fetchArticles(cfg, 'at-1');

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/now/table/kb_knowledge');
    expect(url.searchParams.get('sysparm_query')).toBe(
      'workflow_state=published^kb_knowledge_baseINkb-aaa,kb-bbb',
    );
    expect(url.searchParams.get('sysparm_fields')).toContain('sys_id');
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer at-1');
  });

  it('follows pagination until a short page comes back', async () => {
    const page = (n: number, size: number) =>
      okJson({
        result: Array.from({ length: size }, (_, i) => ({
          sys_id: `s${n}-${i}`,
          number: `KB${n}${i}`,
          short_description: 'T',
          text: '<p>b</p>',
        })),
      });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page(0, 500))
      .mockResolvedValueOnce(page(1, 7));

    const articles = await fetchArticles(cfg, 'at-1');
    expect(articles).toHaveLength(507);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('sysparm_offset')).toBe('500');
  });

  it('throws a clear error when the table API rejects the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(fetchArticles(cfg, 'at-1')).rejects.toThrowError(/403/);
  });
});

describe('articleUrl', () => {
  it('links by sys_kb_id, never by article number (D10)', () => {
    expect(articleUrl('https://abhrademo4.service-now.com', 'sys-1')).toBe(
      'https://abhrademo4.service-now.com/kb_view.do?sys_kb_id=sys-1',
    );
  });

  it('does not double a trailing slash on the instance URL', () => {
    expect(articleUrl('https://abhrademo4.service-now.com/', 'sys-1')).toBe(
      'https://abhrademo4.service-now.com/kb_view.do?sys_kb_id=sys-1',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/servicenow.test.ts`
Expected: FAIL — `Failed to resolve import "../src/servicenow/auth.js"`.

- [ ] **Step 3: Implement `src/servicenow/auth.ts`**

```ts
import type { Config } from '../config.js';

type Cached = { token: string; expiresAt: number };
let cached: Cached | null = null;

/** Refresh a minute early so a token never expires mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

/** Tests only — the cache is module-level so the server refreshes at most once per window. */
export function resetTokenCache(): void {
  cached = null;
}

/**
 * OAuth refresh-token grant (spec §8). Basic auth is not an option here: this
 * instance returns 401 for it, byte-identical to sending no credentials.
 */
export async function getAccessToken(cfg: Config, now: () => number = Date.now): Promise<string> {
  if (cached && cached.expiresAt > now() + EXPIRY_MARGIN_MS) return cached.token;

  const res = await fetch(new URL('/oauth_token.do', cfg.SN_INSTANCE_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.SN_CLIENT_ID,
      client_secret: cfg.SN_CLIENT_SECRET,
      refresh_token: cfg.SN_REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(
      `ServiceNow token refresh failed: ${res.status} ${detail}. ` +
        `The refresh token may have expired (they last ~100 days) — re-export it into .env.`,
    );
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error('ServiceNow token refresh returned no access_token');

  cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 1800) * 1000 };
  return cached.token;
}
```

Note on the "never leaks the secret" test: the thrown message interpolates only the HTTP status and the response body. ServiceNow does not echo the credentials back, so this passes — but if a future instance does, wrap the message in `redact()` from `src/config.js`.

- [ ] **Step 4: Implement `src/servicenow/articles.ts`**

```ts
import type { Config } from '../config.js';
import { stripHtml } from '../index/build.js';
import type { Article } from '../types.js';

type Ref = { value?: string; link?: string };
export type RawArticle = {
  sys_id: string;
  number: string;
  short_description?: string;
  text?: string;
  kb_category?: Ref | string;
  kb_knowledge_base?: Ref | string;
};

const PAGE_SIZE = 500;
const FIELDS = 'sys_id,number,short_description,text,kb_category,kb_knowledge_base';

/** Reference fields arrive as `{ value, link }` when sysparm_display_value=false. */
const ref = (v: Ref | string | undefined): string => (typeof v === 'string' ? v : (v?.value ?? ''));

export function mapArticle(raw: RawArticle): Article {
  return {
    sysId: raw.sys_id,
    number: raw.number,
    title: raw.short_description ?? '',
    body: stripHtml(raw.text ?? ''),
    kbSysId: ref(raw.kb_knowledge_base),
    category: ref(raw.kb_category),
  };
}

/** Link by sys_id. `sysparm_article=<number>` is ambiguous on this instance (D10). */
export function articleUrl(instanceUrl: string, sysId: string): string {
  return new URL(`/kb_view.do?sys_kb_id=${encodeURIComponent(sysId)}`, instanceUrl).toString();
}

export async function fetchArticles(cfg: Config, token: string): Promise<Article[]> {
  const query = `workflow_state=published^kb_knowledge_baseIN${cfg.kbAllowlist.join(',')}`;
  const all: Article[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL('/api/now/table/kb_knowledge', cfg.SN_INSTANCE_URL);
    url.searchParams.set('sysparm_query', query);
    url.searchParams.set('sysparm_fields', FIELDS);
    url.searchParams.set('sysparm_display_value', 'false');
    url.searchParams.set('sysparm_limit', String(PAGE_SIZE));
    url.searchParams.set('sysparm_offset', String(offset));

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(
        `ServiceNow kb_knowledge fetch failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
      );
    }

    const page = ((await res.json()) as { result?: RawArticle[] }).result ?? [];
    all.push(...page.map(mapArticle));
    if (page.length < PAGE_SIZE) break;
  }

  return all;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/servicenow.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add src/servicenow tests/servicenow.test.ts
git commit -m "feat: ServiceNow OAuth refresh grant and paged kb_knowledge fetch"
```

---

## Task 5: Discover the knowledge base allowlist and capture the test fixture

This is the task that turns D9 from a decision into a value. `SN_KB_ALLOWLIST` cannot be guessed: nine of the knowledge bases holding the best content have ACL-restricted `kb_knowledge_base` records, so their titles are unreadable and only their `sys_id` — visible on the articles themselves — identifies them.

**Files:**
- Create: `scripts/discover-allowlist.ts`, `tests/fixtures/kb-articles.json`
- Modify: `.env` (add `SN_KB_ALLOWLIST=`, uncommitted)

**Interfaces:**
- Consumes: `loadConfig`, `getAccessToken`, `mapArticle`.
- Produces: a committed `tests/fixtures/kb-articles.json` in raw API-response shape (`{ result: RawArticle[] }`), and the `SN_KB_ALLOWLIST` value written into `.env`.

- [ ] **Step 1: Write the discovery script**

Create `scripts/discover-allowlist.ts`:

```ts
/**
 * One-off operator script. Fetches every published kb_knowledge record with no
 * allowlist filter, groups by kb_knowledge_base sys_id, and prints what each
 * group contains so a human can choose the allowlist (D9).
 *
 * Run: npx tsx scripts/discover-allowlist.ts
 */
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { getAccessToken } from '../src/servicenow/auth.js';
import { mapArticle, type RawArticle } from '../src/servicenow/articles.js';

// This script runs before the gateway credentials arrive and before the allowlist
// exists, so satisfy the schema with placeholders for everything it does not use.
// Only the SN_* variables, already in .env, are actually exercised here.
const cfg = loadConfig({
  SN_KB_ALLOWLIST: 'pending',
  RETRIEVAL_MIN_SCORE: '0',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'unused-by-this-script',
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? 'https://placeholder.invalid',
  CLAUDE_MODEL: process.env.CLAUDE_MODEL ?? 'unused-by-this-script',
});
const token = await getAccessToken(cfg);

const PAGE = 500;
const raw: RawArticle[] = [];
for (let offset = 0; ; offset += PAGE) {
  const url = new URL('/api/now/table/kb_knowledge', cfg.SN_INSTANCE_URL);
  url.searchParams.set('sysparm_query', 'workflow_state=published');
  url.searchParams.set(
    'sysparm_fields',
    'sys_id,number,short_description,text,kb_category,kb_knowledge_base',
  );
  url.searchParams.set('sysparm_display_value', 'false');
  url.searchParams.set('sysparm_limit', String(PAGE));
  url.searchParams.set('sysparm_offset', String(offset));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
  const page = ((await res.json()) as { result: RawArticle[] }).result;
  raw.push(...page);
  if (page.length < PAGE) break;
}

const articles = raw.map(mapArticle);
const groups = new Map<string, typeof articles>();
for (const a of articles) {
  const list = groups.get(a.kbSysId) ?? [];
  list.push(a);
  groups.set(a.kbSysId, list);
}

console.log(`${articles.length} published articles in ${groups.size} knowledge bases\n`);
for (const [kbSysId, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  const avgLen = Math.round(list.reduce((s, a) => s + a.body.length, 0) / list.length);
  console.log(`${kbSysId || '(none)'}  ${String(list.length).padStart(4)} articles  avg ${avgLen} chars`);
  for (const a of list.slice(0, 5)) console.log(`      ${a.number}  ${a.title.slice(0, 76)}`);
  console.log('');
}

// Full-corpus length distribution — the one still-open measurement from spec §3.
const lengths = articles.map((a) => a.body.length).sort((x, y) => x - y);
const at = (p: number) => lengths[Math.floor((lengths.length - 1) * p)];
console.log(`body length  p50=${at(0.5)}  p90=${at(0.9)}  p99=${at(0.99)}  max=${at(1)}`);

// Duplicate-number check (D10).
const byNumber = new Map<string, number>();
for (const a of articles) byNumber.set(a.number, (byNumber.get(a.number) ?? 0) + 1);
const dupes = [...byNumber].filter(([, n]) => n > 1);
console.log(`\n${dupes.length} article numbers are duplicated: ${dupes.map(([n]) => n).join(', ')}`);

writeFileSync('tests/fixtures/kb-articles-full.json', JSON.stringify({ result: raw }, null, 2));
console.log('\nWrote tests/fixtures/kb-articles-full.json');
```

- [ ] **Step 2: Run the script against the live instance**

Run: `npx tsx scripts/discover-allowlist.ts`
Expected: a per-knowledge-base breakdown, the length percentiles, the duplicate-number list, and `tests/fixtures/kb-articles-full.json`.

If it fails with a token error, the refresh token in `.env` has expired — re-export it from the working PowerShell connection before continuing.

- [ ] **Step 3: Choose the allowlist**

Include every knowledge base whose sample titles are genuine content. Exclude the ~489-article **Security Incident** demo knowledge base — it is 67% of the corpus and it is noise (spec §3, D5).

Cross-check against `tests/fixtures/retrieval-eval.json`: **every `expectedSysId` in the eval set must belong to an article in an allowlisted knowledge base.** Verify it:

```bash
npx tsx -e "
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('tests/fixtures/kb-articles-full.json','utf8')).result;
const evalSet = JSON.parse(readFileSync('tests/fixtures/retrieval-eval.json','utf8'));
const allow = new Set(process.argv[1].split(','));
const kept = new Set(raw.filter(a => allow.has(a.kb_knowledge_base?.value ?? '')).map(a => a.sys_id));
const missing = evalSet.inScope.filter(q => !kept.has(q.expectedSysId));
console.log(missing.length ? 'MISSING: ' + missing.map(m => m.id + '/' + m.expectedSysId).join(', ') : 'all eval articles covered');
" "<comma,separated,sys_ids>"
```

Expected: `all eval articles covered`. If anything is missing, widen the allowlist — the eval set is the ground truth here, not the allowlist.

- [ ] **Step 4: Write the allowlist into `.env`**

Append to `.env` (this file is gitignored — never commit it):

```
SN_KB_ALLOWLIST=<the comma-separated sys_ids chosen in step 3>
```

Also record the same value in `.env.example` as a **comment** documenting the chosen list, so the next person does not have to rerun discovery:

```
# Chosen 2026-09-13 (excludes the Security Incident demo KB): <sys_ids>
SN_KB_ALLOWLIST=
```

- [ ] **Step 5: Reduce the full dump to a committed fixture**

The full dump may be large and contains every published article. Keep a filtered, allowlist-only fixture for tests:

```bash
npx tsx -e "
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
const raw = JSON.parse(readFileSync('tests/fixtures/kb-articles-full.json','utf8')).result;
const allow = new Set(process.env.SN_KB_ALLOWLIST.split(',').map(s=>s.trim()));
const kept = raw.filter(a => allow.has(a.kb_knowledge_base?.value ?? ''));
writeFileSync('tests/fixtures/kb-articles.json', JSON.stringify({ result: kept }, null, 2));
rmSync('tests/fixtures/kb-articles-full.json');
console.log('kept', kept.length, 'articles');
"
```

Expected: roughly 200 articles kept.

- [ ] **Step 6: Confirm the fixture carries no secrets**

Run: `grep -c -E 'refresh_token|client_secret|Bearer|sk-' tests/fixtures/kb-articles.json`
Expected: `0`. The fixture is article content only.

- [ ] **Step 7: Commit**

```bash
git add scripts/discover-allowlist.ts tests/fixtures/kb-articles.json .env.example
git commit -m "feat: discover knowledge base allowlist by sys_id; capture article fixture"
```

---

## Task 6: Retrieval eval and threshold calibration

This produces `RETRIEVAL_MIN_SCORE` — the constant the whole "I don't know" behaviour rests on — and leaves the eval behind as a regression test (spec §9, acceptance criterion 7).

**Files:**
- Create: `scripts/calibrate.ts`, `tests/retrieval-eval.test.ts`
- Modify: `.env` (set `RETRIEVAL_MIN_SCORE`, uncommitted), `.env.example` (document the calibrated value)

**Interfaces:**
- Consumes: `buildIndex`, `search`, `mapArticle`, and the fixtures from Task 5.
- Produces: the calibrated `RETRIEVAL_MIN_SCORE` value, plus the baseline constants `MIN_SCORE`, `MIN_RECALL_AT_1`, `MIN_RECALL_AT_5` recorded at the top of `tests/retrieval-eval.test.ts`.

- [ ] **Step 1: Write the calibration script**

Create `scripts/calibrate.ts`:

```ts
/**
 * One-off operator script. Sweeps RETRIEVAL_MIN_SCORE across the eval set and
 * prints the widest separating band between in-scope and out-of-scope top scores.
 *
 * Run: npx tsx scripts/calibrate.ts
 */
import { readFileSync } from 'node:fs';
import { buildIndex } from '../src/index/build.js';
import { search } from '../src/index/search.js';
import { mapArticle, type RawArticle } from '../src/servicenow/articles.js';

type InScope = { id: string; question: string; expectedSysId: string; confidence: string };
type OutOfScope = { id: string; question: string };

const raw = JSON.parse(readFileSync('tests/fixtures/kb-articles.json', 'utf8')) as { result: RawArticle[] };
const evalSet = JSON.parse(readFileSync('tests/fixtures/retrieval-eval.json', 'utf8')) as {
  inScope: InScope[];
  outOfScope: OutOfScope[];
};

const index = buildIndex(raw.result.map(mapArticle));
const TOP_K = 5;

const inScope = evalSet.inScope.map((q) => {
  const results = search(index, q.question, TOP_K);
  const rank = results.findIndex((r) => r.article.sysId === q.expectedSysId);
  return { ...q, top: results[0]?.score ?? 0, rank: rank === -1 ? null : rank + 1 };
});
const outOfScope = evalSet.outOfScope.map((q) => ({
  ...q,
  top: search(index, q.question, TOP_K)[0]?.score ?? 0,
}));

const recallAt = (n: number) =>
  inScope.filter((q) => q.rank !== null && q.rank <= n).length / inScope.length;

console.log(`index: ${index.n} articles, avg weighted length ${index.avgLen.toFixed(1)}\n`);
console.log(`recall@1 ${(recallAt(1) * 100).toFixed(1)}%   recall@5 ${(recallAt(5) * 100).toFixed(1)}%\n`);

console.log('in-scope misses (expected article not in top 5):');
for (const q of inScope.filter((x) => x.rank === null)) {
  console.log(`  ${q.id} [${q.confidence}] "${q.question.slice(0, 64)}"`);
}

const lowestInScope = Math.min(...inScope.map((q) => q.top));
const highestOutOfScope = Math.max(...outOfScope.map((q) => q.top));
console.log(`\nlowest in-scope top score    ${lowestInScope.toFixed(3)}`);
console.log(`highest out-of-scope score   ${highestOutOfScope.toFixed(3)}`);

if (lowestInScope > highestOutOfScope) {
  const threshold = (lowestInScope + highestOutOfScope) / 2;
  console.log(`\nCLEAN SEPARATION. RETRIEVAL_MIN_SCORE=${threshold.toFixed(2)}`);
} else {
  console.log('\nNO CLEAN SEPARATION — pick the threshold with the best trade-off:\n');
  const candidates = [...new Set([...inScope, ...outOfScope].map((q) => q.top))].sort((a, b) => a - b);
  for (const t of candidates) {
    const pass = inScope.filter((q) => q.top >= t).length;
    const leak = outOfScope.filter((q) => q.top >= t).length;
    console.log(
      `  t=${t.toFixed(2)}  in-scope answered ${pass}/${inScope.length}  out-of-scope leaked ${leak}/${outOfScope.length}`,
    );
  }
  console.log('\nPrefer zero leakage: an unsourced answer to noise is worse than an extra "no match".');
  console.log('Offenders at the chosen threshold:');
  for (const q of outOfScope.sort((a, b) => b.top - a.top).slice(0, 5)) {
    console.log(`  ${q.top.toFixed(2)}  ${q.id}  "${q.question.slice(0, 64)}"`);
  }
}
```

- [ ] **Step 2: Run the calibration**

Run: `npx tsx scripts/calibrate.ts`
Expected: recall figures, the separation report, and a recommended threshold.

Choose the threshold by this rule, in order:
1. **Zero out-of-scope leakage.** The out-of-scope set is built from the real dominant traffic on this instance (monitoring alerts, phishing reports, `"nan"`). A wrong grounded-looking answer to that traffic is the worst failure this system can produce.
2. Subject to that, the highest in-scope pass rate.
3. `medium`-confidence in-scope questions may fall below the threshold. That is acceptable — they test graceful degradation, not precision. `high`-confidence questions falling below is not acceptable; investigate scoring instead of lowering the threshold.

- [ ] **Step 3: If recall@5 on `high`-confidence questions is below ~85%, investigate before proceeding**

Look at the printed misses. The likely causes, in order of likelihood:
- The expected article is not in the allowlist → widen it (back to Task 5 step 3).
- The question and article share no vocabulary (e.g. `inc-04 "Network connectivity Issues"`) → this is a genuine limit of keyword retrieval on a 4-word query; record it, do not fix it by adding embeddings. Spec §3 is explicit that embeddings need a *measured* failure, and a handful of vocabulary-mismatch misses on hand-made mappings is not yet that.
- `TITLE_WEIGHT` or `CODE_BOOST` is miscalibrated → try 2 and 4 for `TITLE_WEIGHT`, rerun, keep the best. Changing a constant is in scope; adding a retrieval strategy is not.

Record whatever you conclude in the commit message.

- [ ] **Step 4: Write the failing regression test**

Create `tests/retrieval-eval.test.ts`. Replace the three baseline constants with the numbers step 2 actually produced — do not leave the placeholders:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/index/build.js';
import { search } from '../src/index/search.js';
import { mapArticle, type RawArticle } from '../src/servicenow/articles.js';

// ---- Baselines measured by scripts/calibrate.ts on 2026-09-13. ----
// Raise them when retrieval improves; never lower them to make a change pass.
const MIN_SCORE = 0; // <-- replace with the calibrated RETRIEVAL_MIN_SCORE
const MIN_RECALL_AT_1 = 0; // <-- replace with the measured recall@1, minus 0.05 margin
const MIN_RECALL_AT_5 = 0; // <-- replace with the measured recall@5, minus 0.05 margin
const TOP_K = 5;

type InScope = { id: string; question: string; expectedSysId: string; confidence: 'high' | 'medium' };
type OutOfScope = { id: string; question: string };

const raw = JSON.parse(readFileSync('tests/fixtures/kb-articles.json', 'utf8')) as { result: RawArticle[] };
const evalSet = JSON.parse(readFileSync('tests/fixtures/retrieval-eval.json', 'utf8')) as {
  inScope: InScope[];
  outOfScope: OutOfScope[];
};
const index = buildIndex(raw.result.map(mapArticle));

const rankOf = (question: string, sysId: string): number | null => {
  const i = search(index, question, TOP_K).findIndex((r) => r.article.sysId === sysId);
  return i === -1 ? null : i + 1;
};
const topScore = (question: string): number => search(index, question, TOP_K)[0]?.score ?? 0;

describe('retrieval eval', () => {
  it('indexes the captured corpus', () => {
    expect(index.n).toBeGreaterThan(100);
  });

  it('every eval article exists in the index', () => {
    const known = new Set(index.docs.map((d) => d.article.sysId));
    const missing = evalSet.inScope.filter((q) => !known.has(q.expectedSysId)).map((q) => q.id);
    expect(missing).toEqual([]);
  });

  it.each(evalSet.outOfScope)('out-of-scope $id scores below the threshold', (q) => {
    expect(topScore(q.question)).toBeLessThan(MIN_SCORE);
  });

  it('meets the recall@1 baseline', () => {
    const hits = evalSet.inScope.filter((q) => rankOf(q.question, q.expectedSysId) === 1).length;
    expect(hits / evalSet.inScope.length).toBeGreaterThanOrEqual(MIN_RECALL_AT_1);
  });

  it('meets the recall@5 baseline', () => {
    const hits = evalSet.inScope.filter((q) => rankOf(q.question, q.expectedSysId) !== null).length;
    expect(hits / evalSet.inScope.length).toBeGreaterThanOrEqual(MIN_RECALL_AT_5);
  });

  it('resolves the duplicated KB0010141 to the right article by sysId (D10)', () => {
    // syn-20 and inc-01 target two different articles that share one number.
    for (const id of ['syn-20', 'inc-01']) {
      const q = evalSet.inScope.find((x) => x.id === id)!;
      expect(rankOf(q.question, q.expectedSysId)).toBe(1);
    }
  });
});
```

- [ ] **Step 5: Run the test to verify it fails, then passes**

Run: `npm test -- tests/retrieval-eval.test.ts`
Expected: FAIL while the constants are still `0` (every out-of-scope assertion fails, since no score is below 0). Fill in the measured constants, rerun.
Expected: PASS.

If the `syn-20`/`inc-01` duplicate test cannot reach rank 1 for both, that is a genuine retrieval finding — record it and relax that single assertion to `toBeLessThanOrEqual(3)` with a comment explaining the measurement. Do not delete the test.

- [ ] **Step 6: Record the calibrated threshold**

Set `RETRIEVAL_MIN_SCORE=<calibrated value>` in `.env`, and update the `.env.example` comment to name the value and the date it was measured.

- [ ] **Step 7: Commit**

```bash
git add scripts/calibrate.ts tests/retrieval-eval.test.ts .env.example
git commit -m "feat: calibrate retrieval threshold against the eval set; add regression test"
```

---

## Task 7: Gateway client, prompt assembly and citation verification

**Files:**
- Create: `src/llm/client.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Consumes: `Scored` from `src/types.js`; `Turn` from `src/types.js`.
- Produces:
  - `SYSTEM_PROMPT: string`
  - `NO_MATCH_ANSWER: string`
  - `buildContextBlock(results: Scored[], budget: number): { block: string; used: Scored[] }`
  - `extractCitations(answer: string, maxLabel: number): { valid: number[]; invalid: number[] }`
  - `answerQuestion(client, opts): Promise<{ answer: string; used: Scored[]; valid: number[]; invalid: number[] }>` where `opts` is `{ question: string; results: Scored[]; history: Turn[]; model: string; budget: number }`
  - `preflight(client, model: string): Promise<void>`
  - `type MessagesClient = { messages: { create: (...) => Promise<{ content: Array<{ type: string; text?: string }> }> } }` — structurally satisfied by `Anthropic`, so tests need no SDK mock library.

- [ ] **Step 1: Write the failing test**

Create `tests/llm.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  answerQuestion,
  buildContextBlock,
  extractCitations,
  preflight,
  type MessagesClient,
} from '../src/llm/client.js';
import type { Scored } from '../src/types.js';

const scored = (sysId: string, number: string, title: string, body: string, score: number): Scored => ({
  article: { sysId, number, title, body, kbSysId: 'kb-1', category: 'c' },
  score,
});

const results = [
  scored('s1', 'KB0010141', 'Self-checkout will not boot', 'Reimage the lane.', 12),
  scored('s2', 'KB0010096', 'VPN will not connect', 'Restart the client.', 8),
];

const stubClient = (answer: string): MessagesClient & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    messages: {
      create: vi.fn(async (args: unknown) => {
        calls.push(args);
        return { content: [{ type: 'text', text: answer }] };
      }),
    },
  } as MessagesClient & { calls: unknown[] };
};

describe('buildContextBlock', () => {
  it('labels articles from 1 and includes number, title and body', () => {
    const { block, used } = buildContextBlock(results, 10_000);
    expect(used).toHaveLength(2);
    expect(block).toContain('[1] KB0010141 — Self-checkout will not boot');
    expect(block).toContain('[2] KB0010096 — VPN will not connect');
    expect(block).toContain('Restart the client.');
  });

  it('drops trailing articles that exceed the character budget', () => {
    const { used } = buildContextBlock(results, 60);
    expect(used).toHaveLength(1);
    expect(used[0]!.article.sysId).toBe('s1');
  });

  it('always includes the top article even if it alone exceeds the budget', () => {
    const { used } = buildContextBlock(results, 1);
    expect(used).toHaveLength(1);
  });

  it('returns an empty block for no results', () => {
    expect(buildContextBlock([], 10_000)).toEqual({ block: '', used: [] });
  });
});

describe('extractCitations', () => {
  it('collects valid labels, deduplicated and sorted', () => {
    expect(extractCitations('Do X [2] then Y [1] and see [2].', 2)).toEqual({
      valid: [1, 2],
      invalid: [],
    });
  });

  it('separates labels outside the supplied range', () => {
    expect(extractCitations('See [1] and [7].', 2)).toEqual({ valid: [1], invalid: [7] });
  });

  it('treats label 0 as invalid', () => {
    expect(extractCitations('See [0].', 2)).toEqual({ valid: [], invalid: [0] });
  });

  it('ignores a fabricated KB number, which is not a bracketed label', () => {
    expect(extractCitations('See KB0099999 for more.', 2)).toEqual({ valid: [], invalid: [] });
  });

  it('returns nothing for an uncited answer', () => {
    expect(extractCitations('No citation here.', 2)).toEqual({ valid: [], invalid: [] });
  });
});

describe('answerQuestion', () => {
  it('sends the system prompt, the context block and the question', async () => {
    const client = stubClient('Reimage the lane [1].');
    await answerQuestion(client, {
      question: 'lanes down after image push',
      results,
      history: [],
      model: 'gateway-model',
      budget: 10_000,
    });

    const args = client.calls[0] as { model: string; system: string; messages: Array<{ content: string }> };
    expect(args.model).toBe('gateway-model');
    expect(args.system).toMatch(/ONLY/);
    expect(args.messages.at(-1)!.content).toContain('[1] KB0010141');
    expect(args.messages.at(-1)!.content).toContain('lanes down after image push');
  });

  it('passes at most the last six turns of history', async () => {
    const client = stubClient('ok');
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as const,
      content: `turn-${i}`,
    }));
    await answerQuestion(client, { question: 'q', results, history, model: 'm', budget: 10_000 });

    const args = client.calls[0] as { messages: Array<{ content: string }> };
    expect(args.messages).toHaveLength(7); // 6 history + the current question
    expect(args.messages[0]!.content).toBe('turn-4');
  });

  it('reports valid and fabricated citations separately', async () => {
    const client = stubClient('Try [1], or see [9].');
    const out = await answerQuestion(client, {
      question: 'q',
      results,
      history: [],
      model: 'm',
      budget: 10_000,
    });
    expect(out.valid).toEqual([1]);
    expect(out.invalid).toEqual([9]);
    expect(out.used).toHaveLength(2);
  });

  it('joins multiple text blocks and ignores non-text blocks', async () => {
    const client = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'Part one. ' }, { type: 'thinking' }, { type: 'text', text: 'Part two.' }],
        }),
      },
    } as unknown as MessagesClient;
    const out = await answerQuestion(client, {
      question: 'q',
      results,
      history: [],
      model: 'm',
      budget: 10_000,
    });
    expect(out.answer).toBe('Part one. Part two.');
  });
});

describe('preflight', () => {
  it('resolves when the gateway accepts the configured model', async () => {
    await expect(preflight(stubClient('pong'), 'gateway-model')).resolves.toBeUndefined();
  });

  it('throws naming the model when the gateway rejects it', async () => {
    const client = {
      messages: { create: async () => { throw new Error('model_not_found'); } },
    } as unknown as MessagesClient;
    await expect(preflight(client, 'wrong-id')).rejects.toThrowError(/wrong-id[\s\S]*model_not_found/);
  });

  it('sends a minimal request so preflight stays cheap', async () => {
    const client = stubClient('pong');
    await preflight(client, 'gateway-model');
    expect((client.calls[0] as { max_tokens: number }).max_tokens).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/llm.test.ts`
Expected: FAIL — `Failed to resolve import "../src/llm/client.js"`.

- [ ] **Step 3: Implement `src/llm/client.ts`**

```ts
import type { Scored, Turn } from '../types.js';

/**
 * Structural shape of the bit of the Anthropic SDK this module uses.
 * `Anthropic` satisfies it, and tests can supply a plain object.
 */
export type MessagesClient = {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
};

export const NO_MATCH_ANSWER = 'No knowledge base match — not answered';

/**
 * Labels, not KB numbers (D10). Article numbers are not unique on this instance,
 * and a small integer drawn from a five-item list is much harder to fabricate
 * than a plausible-looking KB00… string.
 */
export const SYSTEM_PROMPT = `You answer questions using ONLY the knowledge base articles supplied in the CONTEXT block below.

Rules:
- Use only facts stated in the supplied articles. Never fall back on general knowledge.
- Cite every article you used with its bracketed label, for example [1] or [2][3].
- Cite labels only. Never cite an article number such as KB0010096.
- If the supplied articles do not answer the question, say exactly: The knowledge base does not cover this.
- Be concise: a direct answer first, then the steps the article gives.`;

const MAX_HISTORY_TURNS = 6;
const MAX_ANSWER_TOKENS = 1024;

/**
 * Assemble the delimited context block, capped by a total character budget so a
 * few long articles cannot crowd out the prompt (spec §9). The top-scoring
 * article is always included, budget or not — dropping it would mean calling the
 * model with nothing to ground on.
 */
export function buildContextBlock(
  results: Scored[],
  budget: number,
): { block: string; used: Scored[] } {
  const used: Scored[] = [];
  const parts: string[] = [];
  let spent = 0;

  for (const result of results) {
    const { number, title, body } = result.article;
    const part = `[${used.length + 1}] ${number} — ${title}\n${body}`;
    if (used.length > 0 && spent + part.length > budget) break;
    parts.push(part);
    used.push(result);
    spent += part.length;
  }

  return { block: parts.join('\n\n'), used };
}

/**
 * Prompt instructions are not guarantees (spec §10). Intersect what the model
 * cited with what was actually supplied; anything else is fabricated.
 */
export function extractCitations(
  answer: string,
  maxLabel: number,
): { valid: number[]; invalid: number[] } {
  const cited = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const inRange = (n: number) => n >= 1 && n <= maxLabel;
  return {
    valid: [...new Set(cited.filter(inRange))].sort((a, b) => a - b),
    invalid: [...new Set(cited.filter((n) => !inRange(n)))].sort((a, b) => a - b),
  };
}

export async function answerQuestion(
  client: MessagesClient,
  opts: { question: string; results: Scored[]; history: Turn[]; model: string; budget: number },
): Promise<{ answer: string; used: Scored[]; valid: number[]; invalid: number[] }> {
  const { block, used } = buildContextBlock(opts.results, opts.budget);

  const res = await client.messages.create({
    model: opts.model,
    max_tokens: MAX_ANSWER_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      ...opts.history.slice(-MAX_HISTORY_TURNS),
      { role: 'user', content: `CONTEXT\n${block}\nEND CONTEXT\n\nQuestion: ${opts.question}` },
    ],
  });

  const answer = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();

  return { answer, used, ...extractCitations(answer, used.length) };
}

/**
 * Spec §7 rule 2. The gateway renames models, and a wrong id is a silent wrong
 * answer rather than an error — so this must be a boot failure, not a surprise
 * in production.
 */
export async function preflight(client: MessagesClient, model: string): Promise<void> {
  try {
    await client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  } catch (err) {
    throw new Error(`Gateway preflight failed for model "${model}": ${(err as Error).message}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/llm.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/llm/client.ts tests/llm.test.ts
git commit -m "feat: gateway client, label-based prompting and citation verification"
```

---

## Task 8: Routes, app and boot sequence

**Blocked without the gateway credentials** for step 7 only; steps 1–6 stub the client and run offline.

**Files:**
- Create: `src/server/routes.ts`, `src/server/app.ts`, `src/main.ts`
- Test: `tests/routes.test.ts`

**Interfaces:**
- Consumes: everything built so far.
- Produces:
  - `type AppState = { index: KbIndex; articleCount: number; lastSync: string | null; gatewayOk: boolean }`
  - `type Deps = { cfg: Config; state: AppState; client: MessagesClient; sync: () => Promise<Article[]> }`
  - `pickModel(requested: unknown, cfg: Config): string`
  - `createRoutes(deps: Deps): Router`
  - `createApp(deps: Deps): Express`

- [ ] **Step 1: Write the failing test**

Create `tests/routes.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildIndex } from '../src/index/build.js';
import { createApp } from '../src/server/app.js';
import type { AppState } from '../src/server/routes.js';
import { pickModel } from '../src/server/routes.js';
import type { MessagesClient } from '../src/llm/client.js';
import type { Article } from '../src/types.js';

const cfg = loadConfig(
  {
    ANTHROPIC_API_KEY: 'sk-abc123456789wxyz',
    ANTHROPIC_BASE_URL: 'https://llmproxy.example.com',
    CLAUDE_MODEL: 'model-default',
    CLAUDE_MODEL_CHOICES: 'model-alt',
    SN_INSTANCE_URL: 'https://abhrademo4.service-now.com',
    SN_CLIENT_ID: 'cid',
    SN_CLIENT_SECRET: 'csecret',
    SN_REFRESH_TOKEN: 'rtoken',
    SN_KB_ALLOWLIST: 'kb-aaa',
    RETRIEVAL_MIN_SCORE: '3',
    MAX_MESSAGE_CHARS: '50',
  },
  {},
);

const articles: Article[] = [
  {
    sysId: 'sys-vpn',
    number: 'KB0010096',
    title: 'VPN will not connect from home',
    body: 'Restart the VPN client, then reconnect to the corporate VPN gateway.',
    kbSysId: 'kb-aaa',
    category: 'network',
  },
];

const makeState = (): AppState => ({
  index: buildIndex(articles),
  articleCount: articles.length,
  lastSync: '2026-09-13T10:00:00.000Z',
  gatewayOk: true,
});

/** Typed as a mock so the "was never called" assertions typecheck. */
type StubClient = MessagesClient & { messages: { create: ReturnType<typeof vi.fn> } };

const stub = (answer: string): StubClient =>
  ({
    messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: answer }] })) },
  }) as unknown as StubClient;

const appWith = (over: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({
    cfg,
    state: makeState(),
    client: stub('Restart the client [1].'),
    sync: async () => articles,
    ...over,
  });

describe('pickModel', () => {
  it('falls back to the configured default when none is requested', () => {
    expect(pickModel(undefined, cfg)).toBe('model-default');
  });

  it('accepts a model that is on the configured list', () => {
    expect(pickModel('model-alt', cfg)).toBe('model-alt');
  });

  it('rejects a model that is not on the list rather than forwarding it', () => {
    expect(() => pickModel('claude-3-opus-20240229', cfg)).toThrowError(/not available/);
  });

  it('rejects a non-string model', () => {
    expect(() => pickModel(42, cfg)).toThrowError(/not available/);
  });
});
```

Then add the route tests. They drive the app over a real HTTP round-trip using Node's own server — **no new dependency** (`supertest` is not on the allowed list):

```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

async function call(
  app: Express,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const server = createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    server.close();
  }
}

describe('POST /api/chat', () => {
  it('answers a grounded question with verified sources', async () => {
    const res = await call(appWith(), 'POST', '/api/chat', { message: 'cannot connect to VPN' });
    expect(res.status).toBe(200);
    expect(res.json.grounded).toBe(true);
    expect(res.json.answer).toContain('Restart the client');
    expect(res.json.sources).toEqual([
      expect.objectContaining({
        sysId: 'sys-vpn',
        number: 'KB0010096',
        url: 'https://abhrademo4.service-now.com/kb_view.do?sys_kb_id=sys-vpn',
      }),
    ]);
  });

  it('returns no match without calling the model when the score is below threshold', async () => {
    const client = stub('should never be called');
    const res = await call(appWith({ client }), 'POST', '/api/chat', { message: 'nan' });
    expect(res.json.grounded).toBe(false);
    expect(res.json.sources).toEqual([]);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('strips a fabricated citation from the source line', async () => {
    const res = await call(
      appWith({ client: stub('Restart it [1], and also see [4].') }),
      'POST',
      '/api/chat',
      { message: 'cannot connect to VPN' },
    );
    expect(res.json.sources).toHaveLength(1);
    expect(res.json.sources[0].sysId).toBe('sys-vpn');
  });

  it('returns every retrieved article when the model cites nothing', async () => {
    const res = await call(appWith({ client: stub('Restart it.') }), 'POST', '/api/chat', {
      message: 'cannot connect to VPN',
    });
    expect(res.json.sources).toHaveLength(1);
  });

  it('rejects an empty message', async () => {
    const res = await call(appWith(), 'POST', '/api/chat', { message: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects a message over the length cap before reaching the gateway', async () => {
    const client = stub('x');
    const res = await call(appWith({ client }), 'POST', '/api/chat', { message: 'x'.repeat(51) });
    expect(res.status).toBe(400);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('rejects a model that is not on the configured list', async () => {
    const res = await call(appWith(), 'POST', '/api/chat', {
      message: 'cannot connect to VPN',
      model: 'claude-3-opus-20240229',
    });
    expect(res.status).toBe(400);
  });

  it('returns 503 and preserves the conversation when the gateway fails', async () => {
    const client = {
      messages: { create: async () => { throw new Error('529 overloaded'); } },
    } as unknown as MessagesClient;
    const res = await call(appWith({ client }), 'POST', '/api/chat', { message: 'cannot connect to VPN' });
    expect(res.status).toBe(503);
    expect(res.json.error).toMatch(/busy/i);
  });

  it('never leaks a secret in an error response', async () => {
    const client = {
      messages: { create: async () => { throw new Error('auth failed for sk-abc123456789wxyz'); } },
    } as unknown as MessagesClient;
    const res = await call(appWith({ client }), 'POST', '/api/chat', { message: 'cannot connect to VPN' });
    expect(JSON.stringify(res.json)).not.toContain('sk-abc123456789wxyz');
  });
});

describe('POST /api/sync', () => {
  it('rebuilds the index and reports the count and duration', async () => {
    const res = await call(appWith(), 'POST', '/api/sync', {});
    expect(res.status).toBe(200);
    expect(res.json.articleCount).toBe(1);
    expect(typeof res.json.durationMs).toBe('number');
  });

  it('keeps serving the existing index when the sync fails', async () => {
    const app = appWith({ sync: async () => { throw new Error('invalid_grant'); } });
    const sync = await call(app, 'POST', '/api/sync', {});
    expect(sync.status).toBe(502);

    const health = await call(app, 'GET', '/api/health');
    expect(health.json.articleCount).toBe(1);
  });

  it('refuses to replace a working index with an empty one', async () => {
    const app = appWith({ sync: async () => [] });
    const res = await call(app, 'POST', '/api/sync', {});
    expect(res.status).toBe(502);
    expect((await call(app, 'GET', '/api/health')).json.articleCount).toBe(1);
  });
});

describe('GET /api/health', () => {
  it('reports the model, choices, article count and last sync', async () => {
    const res = await call(appWith(), 'GET', '/api/health');
    expect(res.json).toMatchObject({
      ok: true,
      model: 'model-default',
      models: ['model-default', 'model-alt'],
      articleCount: 1,
      lastSync: '2026-09-13T10:00:00.000Z',
      gateway: 'reachable',
    });
  });

  it('never includes a secret', async () => {
    const res = await call(appWith(), 'GET', '/api/health');
    expect(JSON.stringify(res.json)).not.toContain('sk-abc123456789wxyz');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/routes.test.ts`
Expected: FAIL — `Failed to resolve import "../src/server/app.js"`.

- [ ] **Step 3: Implement `src/server/routes.ts`**

```ts
import { Router, type Request, type Response } from 'express';
import { redact, type Config } from '../config.js';
import { buildIndex, type KbIndex } from '../index/build.js';
import { search } from '../index/search.js';
import { answerQuestion, NO_MATCH_ANSWER, type MessagesClient } from '../llm/client.js';
import { articleUrl } from '../servicenow/articles.js';
import type { Article, Scored, Source, Turn } from '../types.js';

export type AppState = {
  index: KbIndex;
  articleCount: number;
  lastSync: string | null;
  gatewayOk: boolean;
};

export type Deps = {
  cfg: Config;
  state: AppState;
  client: MessagesClient;
  sync: () => Promise<Article[]>;
};

/**
 * Input validation at a trust boundary: the model id comes from the browser and
 * is forwarded to the gateway, so it must be one we configured, not any string.
 */
export function pickModel(requested: unknown, cfg: Config): string {
  if (requested === undefined || requested === null || requested === '') return cfg.CLAUDE_MODEL;
  if (typeof requested !== 'string' || !cfg.modelChoices.includes(requested)) {
    throw new Error(`Model not available. Choose one of: ${cfg.modelChoices.join(', ')}`);
  }
  return requested;
}

const toSource = (cfg: Config, { article, score }: Scored): Source => ({
  number: article.number,
  title: article.title,
  sysId: article.sysId,
  score: Number(score.toFixed(3)),
  url: articleUrl(cfg.SN_INSTANCE_URL, article.sysId),
});

export function createRoutes(deps: Deps): Router {
  const { cfg, state, client } = deps;
  const router = Router();
  // Process-lifetime conversation memory. No database (spec §4).
  const conversations = new Map<string, Turn[]>();

  const log = (fields: Record<string, unknown>): void => {
    console.log(redact(JSON.stringify({ t: new Date().toISOString(), ...fields }), cfg));
  };

  router.post('/api/chat', async (req: Request, res: Response) => {
    const { message, conversationId = 'default', model } = (req.body ?? {}) as Record<string, unknown>;

    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'message is required' });
    }
    if (message.length > cfg.MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `message too long (max ${cfg.MAX_MESSAGE_CHARS} characters)` });
    }

    let chosenModel: string;
    try {
      chosenModel = pickModel(model, cfg);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    const started = Date.now();
    const results = search(state.index, message, cfg.RETRIEVAL_TOP_K);
    const topScore = results[0]?.score ?? 0;

    // Spec §4 step 3: "I don't know" is a retrieval decision, made before any model call.
    if (topScore < cfg.RETRIEVAL_MIN_SCORE) {
      log({
        event: 'chat',
        grounded: false,
        query: message,
        topScore: Number(topScore.toFixed(3)),
        latencyMs: Date.now() - started,
      });
      return res.json({ answer: NO_MATCH_ANSWER, sources: [], grounded: false });
    }

    const key = String(conversationId);
    const history = conversations.get(key) ?? [];

    try {
      const { answer, used, valid, invalid } = await answerQuestion(client, {
        question: message,
        results,
        history,
        model: chosenModel,
        budget: cfg.CONTEXT_CHAR_BUDGET,
      });

      // Cite only what was verified. An uncited answer still shows what was retrieved.
      const citedResults = valid.length > 0 ? valid.map((label) => used[label - 1]!) : used;
      const sources = citedResults.map((r) => toSource(cfg, r));

      conversations.set(key, [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: answer },
      ]);
      state.gatewayOk = true;

      if (invalid.length > 0) {
        log({ event: 'citation_stripped', conversationId: key, invalid, supplied: used.length });
      }
      log({
        event: 'chat',
        grounded: true,
        query: message,
        model: chosenModel,
        // sys_id, because the article number is not unique (D10).
        retrieved: results.map((r) => ({ sysId: r.article.sysId, number: r.article.number, score: Number(r.score.toFixed(3)) })),
        latencyMs: Date.now() - started,
      });

      return res.json({ answer, sources, grounded: true });
    } catch (err) {
      state.gatewayOk = false;
      log({ event: 'chat_error', model: chosenModel, error: (err as Error).message });
      // The conversation is untouched, so the user can retry on the same thread.
      return res.status(503).json({ error: 'The model is busy. Please try again.' });
    }
  });

  router.post('/api/sync', async (_req: Request, res: Response) => {
    const started = Date.now();
    try {
      const articles = await deps.sync();
      if (articles.length === 0) {
        // A stale index beats an empty one (spec §13).
        log({ event: 'sync_empty' });
        return res.status(502).json({ error: 'Sync returned no articles; the existing index is unchanged.' });
      }
      state.index = buildIndex(articles);
      state.articleCount = articles.length;
      state.lastSync = new Date().toISOString();
      const durationMs = Date.now() - started;
      log({ event: 'sync', articleCount: articles.length, durationMs });
      return res.json({ articleCount: articles.length, durationMs, lastSync: state.lastSync });
    } catch (err) {
      log({ event: 'sync_error', error: (err as Error).message });
      return res.status(502).json({
        error: `Sync failed: ${redact((err as Error).message, cfg)}. The existing index is still serving.`,
      });
    }
  });

  router.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: state.articleCount > 0,
      model: cfg.CLAUDE_MODEL,
      models: cfg.modelChoices,
      articleCount: state.articleCount,
      lastSync: state.lastSync,
      gateway: state.gatewayOk ? 'reachable' : 'unreachable',
    });
  });

  return router;
}
```

- [ ] **Step 4: Implement `src/server/app.ts`**

```ts
import express, { type Express } from 'express';
import { createRoutes, type Deps } from './routes.js';

export function createApp(deps: Deps): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(createRoutes(deps));
  app.use(express.static('public'));
  return app;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/routes.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 6: Implement `src/main.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, mask } from './config.js';
import { buildIndex } from './index/build.js';
import { preflight } from './llm/client.js';
import { fetchArticles } from './servicenow/articles.js';
import { getAccessToken } from './servicenow/auth.js';
import { createApp } from './server/app.js';
import type { AppState } from './server/routes.js';

/** Spec §7: each step fails fast with a specific, actionable message. */
const die = (message: string): never => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

const cfg = (() => {
  try {
    return loadConfig();
  } catch (err) {
    return die(`Startup failed while loading configuration.\n${(err as Error).message}`);
  }
})();

const client = new Anthropic({
  apiKey: cfg.ANTHROPIC_API_KEY,
  baseURL: cfg.ANTHROPIC_BASE_URL,
});

try {
  await preflight(client, cfg.CLAUDE_MODEL);
  console.log(`preflight ok  model=${cfg.CLAUDE_MODEL}  gateway=${cfg.ANTHROPIC_BASE_URL}`);
} catch (err) {
  die(
    `${(err as Error).message}\n` +
      `  gateway: ${cfg.ANTHROPIC_BASE_URL}\n` +
      `  key:     ${mask(cfg.ANTHROPIC_API_KEY)}\n` +
      `A wrong model id is a silent wrong answer, so this is a boot failure by design (spec §7).`,
  );
}

const sync = async () => fetchArticles(cfg, await getAccessToken(cfg));

const articles = await sync().catch((err: Error) =>
  die(`Startup failed while fetching articles from ${cfg.SN_INSTANCE_URL}.\n${err.message}`),
);

if (articles.length === 0) {
  die(
    `Startup failed: the allowlisted knowledge bases returned no published articles.\n` +
      `  SN_KB_ALLOWLIST: ${cfg.SN_KB_ALLOWLIST}\n` +
      `Nothing to ground on means every answer would be "no match" (spec §13).`,
  );
}

const state: AppState = {
  index: buildIndex(articles),
  articleCount: articles.length,
  lastSync: new Date().toISOString(),
  gatewayOk: true,
};

console.log(`index built  ${state.articleCount} articles`);

createApp({ cfg, state, client, sync }).listen(cfg.PORT, () => {
  console.log(`nowops-chat listening on http://localhost:${cfg.PORT}`);
});
```

- [ ] **Step 7: Typecheck, then boot (needs the gateway credentials in `.env`)**

Run: `npm run typecheck && npm test`
Expected: no type errors; all suites pass.

Run: `npm run dev`
Expected, in order:
```
preflight ok  model=<gateway model id>  gateway=https://llmproxy...
index built  <n> articles
nowops-chat listening on http://localhost:3000
```

If the gateway credentials are not yet available, stop here and record that acceptance criteria 1, 2, 3 and 5 are unverified. Everything else in this task is done.

- [ ] **Step 8: Commit**

```bash
git add src/server src/main.ts tests/routes.test.ts
git commit -m "feat: chat, sync and health routes with boot preflight"
```

---

## Task 9: Chat UI with the three-state source line

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/styles.css`

**Interfaces:**
- Consumes: `POST /api/chat`, `GET /api/health`.
- Produces: nothing importable.

No test framework for this — there is no DOM test runner on the dependency list and adding one is a plan violation. Verification is manual, in step 4.

- [ ] **Step 1: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NowOps Knowledge Assistant</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header>
      <h1>NowOps Knowledge Assistant</h1>
      <div class="meta">
        <label for="model">Model</label>
        <select id="model"></select>
        <span id="status" class="status">connecting…</span>
      </div>
    </header>

    <main id="log" aria-live="polite" aria-label="Conversation"></main>

    <form id="composer">
      <label class="sr-only" for="message">Your question</label>
      <input id="message" name="message" autocomplete="off" placeholder="Ask about a knowledge base article…" required />
      <button type="submit" id="send">Send</button>
    </form>

    <script src="app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `public/app.js`**

```js
const log = document.getElementById('log');
const form = document.getElementById('composer');
const input = document.getElementById('message');
const send = document.getElementById('send');
const modelSelect = document.getElementById('model');
const status = document.getElementById('status');

const conversationId = crypto.randomUUID();

function addBubble(role, text) {
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

/** Spec §12: three states, and links always resolve by sys_id (D10). */
function addSourceLine(after, data) {
  const el = document.createElement('div');
  el.className = 'sources';

  if (!data.grounded) {
    el.classList.add('no-match');
    el.textContent = 'No knowledge base match — not answered';
  } else if (data.sources.length === 0) {
    el.classList.add('no-match');
    el.textContent = 'No verified citation';
  } else {
    el.append('Sources: ');
    data.sources.forEach((s, i) => {
      if (i > 0) el.append(' · ');
      const a = document.createElement('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = s.number;
      a.title = `${s.title} (score ${s.score})`;
      el.append(a);
    });
  }

  after.insertAdjacentElement('afterend', el);
  log.scrollTop = log.scrollHeight;
}

async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    const health = await res.json();
    modelSelect.replaceChildren(
      ...health.models.map((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        return opt;
      }),
    );
    status.textContent = `${health.articleCount} articles · gateway ${health.gateway}`;
    status.classList.toggle('bad', !health.ok || health.gateway !== 'reachable');
  } catch {
    status.textContent = 'server unreachable';
    status.classList.add('bad');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  addBubble('user', message);
  input.value = '';
  send.disabled = true;

  const typing = addBubble('assistant typing', '…');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, conversationId, model: modelSelect.value }),
    });
    const data = await res.json();

    if (!res.ok) {
      typing.className = 'bubble error';
      typing.textContent = data.error ?? 'Request failed.';
      return;
    }

    typing.className = 'bubble assistant';
    typing.textContent = data.answer;
    addSourceLine(typing, data);
  } catch (err) {
    typing.className = 'bubble error';
    typing.textContent = 'Could not reach the server.';
  } finally {
    send.disabled = false;
    input.focus();
  }
});

loadHealth();
```

- [ ] **Step 3: Create `public/styles.css`**

```css
:root {
  --bg: #0f1115;
  --panel: #171a21;
  --text: #e6e8ec;
  --muted: #949bab;
  --accent: #4b9fff;
  --bad: #ff6b6b;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}

header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: baseline;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid #262b36;
}

h1 { font-size: 17px; margin: 0; font-weight: 600; }

.meta { display: flex; gap: 10px; align-items: center; font-size: 13px; color: var(--muted); }
.meta select { background: var(--panel); color: var(--text); border: 1px solid #2c323f; border-radius: 6px; padding: 4px 8px; }
.status.bad { color: var(--bad); }

main {
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bubble {
  max-width: 68ch;
  padding: 10px 14px;
  border-radius: 12px;
  white-space: pre-wrap;
  margin-top: 10px;
}
.bubble.user { align-self: flex-end; background: var(--accent); color: #06101f; }
.bubble.assistant { align-self: flex-start; background: var(--panel); }
.bubble.error { align-self: flex-start; background: #2a1618; color: var(--bad); }
.bubble.typing { color: var(--muted); }

.sources { align-self: flex-start; font-size: 13px; color: var(--muted); padding-left: 14px; }
.sources a { color: var(--accent); }
.sources.no-match { font-style: italic; }

form { display: flex; gap: 10px; padding: 14px 20px; border-top: 1px solid #262b36; }
input[name='message'] {
  flex: 1;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid #2c323f;
  background: var(--panel);
  color: var(--text);
  font: inherit;
}
button {
  padding: 10px 20px;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: #06101f;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: default; }

.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
```

- [ ] **Step 4: Verify the three source-line states by hand**

Run: `npm run dev`, open `http://localhost:3000`, and check each:

1. **Grounded** — ask a question from `tests/fixtures/retrieval-eval.json` `inScope` (e.g. `"Workday password reset"`). Expect an answer plus `Sources: KB00…`. **Click the link and confirm it opens the article whose `sys_id` matches `expectedSysId`.**
2. **No match** — ask an `outOfScope` question (e.g. `"nan"`). Expect `No knowledge base match — not answered`, and **no entry in the server log with `"grounded":true`**.
3. **Model picker** — switch models and re-ask question 1. Expect an answer still carrying a source line.

- [ ] **Step 5: Commit**

```bash
git add public/
git commit -m "feat: chat UI with model picker and three-state source line"
```

---

## Task 10: Acceptance run

**Files:**
- Create: `docs/superpowers/plans/2026-09-13-acceptance.md` (the recorded result)
- Modify: `README.md` (create it — setup and run instructions)

- [ ] **Step 1: Create `README.md`**

```markdown
# nowops-chat

Answers questions from the abhrademo4 ServiceNow knowledge base using Claude via the
UST LLM gateway. Every answer cites the articles it used, and questions the knowledge
base cannot answer are refused before the model is ever called.

Design: [docs/superpowers/specs/2026-09-13-nowops-chatbot-design.md](docs/superpowers/specs/2026-09-13-nowops-chatbot-design.md)

## Setup

```bash
nvm use          # Node 22
npm install
cp .env.example .env   # then fill in the values
npm run dev            # http://localhost:3000
```

`.env` needs the gateway key, base URL and exact model id from the project owner, plus the
ServiceNow OAuth client id, secret and refresh token. `SN_KB_ALLOWLIST` and
`RETRIEVAL_MIN_SCORE` are produced by the two scripts below.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Boot with preflight, sync and index |
| `npm test` | Unit, route and retrieval-eval suites |
| `npx tsx scripts/discover-allowlist.ts` | List knowledge bases by sys_id to choose `SN_KB_ALLOWLIST` |
| `npx tsx scripts/calibrate.ts` | Sweep the eval set to choose `RETRIEVAL_MIN_SCORE` |

## Things that will bite you

- **Article numbers are not unique on this instance.** `KB0010004` maps to four articles.
  Resolve and link by `sys_id` only.
- **The knowledge base allowlist is keyed by knowledge base `sys_id`, not title.** The nine
  most useful knowledge bases have ACL-restricted records with no readable title.
- **The gateway renames Claude model ids.** A public id will not work, and a wrong one is a
  silent wrong answer — which is why the server refuses to start if preflight fails.
- **Most real traffic on this instance is not knowledge-base-answerable.** Monitoring alerts
  and phishing reports dominate. "No knowledge base match" is the correct answer for them.
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: every suite passes, including `tests/retrieval-eval.test.ts`. **Paste the actual output into the acceptance record — do not summarise it.**

- [ ] **Step 3: Walk the acceptance criteria from spec §16**

Record a verbatim result for each in `docs/superpowers/plans/2026-09-13-acceptance.md`:

1. `npm run dev` boots, preflight passes, the index reports its article count.
2. `curl -s localhost:3000/api/health | jq` shows gateway reachable, model id, article count, last sync.
3. Five `inScope` eval questions return correct answers with correct citations, **and each link opens the article whose `sys_id` matches `expectedSysId`**. Check the `sys_id` in the URL, not the KB number on screen — that is the whole point of D10.
4. An `outOfScope` question returns no match, **and the server log line for it carries `"grounded":false` with no model call**.
5. The model picker switches models and answers still ground correctly.
6. `npm run dev 2>&1 | tee /tmp/boot.log` then `grep -E "$(node -e "const e=process.env;console.log([e.ANTHROPIC_API_KEY,e.SN_CLIENT_SECRET,e.SN_REFRESH_TOKEN].join('|'))")" /tmp/boot.log` returns nothing. Repeat against a chat request log.
7. The retrieval eval passes (step 2).

- [ ] **Step 4: Record what is not done**

In the same file, list explicitly: anything from spec §2 "out of scope", plus any acceptance criterion that could not be verified and why. A criterion skipped for missing credentials is a recorded gap, not a pass.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/plans/2026-09-13-acceptance.md
git commit -m "docs: README and acceptance run record"
```

---

## Spec coverage

| Spec section | Covered by |
|---|---|
| §2 scope | Tasks 1–9; out-of-scope items recorded in Task 10 step 4 |
| §4 architecture, request flow | Tasks 2–4, 7, 8 |
| §6 layout, thin dependencies | Task 1 (plus the three deviations noted above) |
| §7 config, gateway rules, startup sequence | Tasks 1, 7, 8 |
| §8 ServiceNow ingestion | Tasks 4, 5 |
| §9 indexing, scoring, calibration | Tasks 2, 3, 6 |
| §10 prompt, labels, citation verification, history | Tasks 7, 8 |
| §11 API contract | Task 8 |
| §12 frontend, three source states | Task 9 |
| §13 error handling — all seven rows | Tasks 4, 7, 8 (`tests/routes.test.ts`, `src/main.ts`) |
| §14 observability | Task 8 (`log()` in `routes.ts`) |
| §15 testing — all four layers | Tasks 1–8 unit and integration, Task 6 eval, Task 10 smoke |
| §16 acceptance criteria | Task 10 |
| §17 remaining inputs | Task 5 (allowlist, full-corpus length distribution), Task 6 (threshold) |
| D1–D10 | D1/D3/D6 by construction; D2 Task 8; D4 Task 8; D5/D9 Task 5; D7 Task 4; D8 already true; D10 Tasks 3, 4, 7, 8, 9 |

One spec item is deliberately **not** given a task: §3's open "full-corpus article length distribution". It is folded into Task 5 step 2, which prints the percentiles — a measurement, not a deliverable.
