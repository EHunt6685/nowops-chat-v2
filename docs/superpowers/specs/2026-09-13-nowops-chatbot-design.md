# NowOps Chatbot — Design Spec

- **Date:** 2026-09-13
- **Status:** Approved, pending implementation plan
- **Owner:** Sachin Chavan (UST)

---

## 1. Purpose

Build a lightweight chatbot that answers questions from the ServiceNow knowledge base
on the `abhrademo4` instance, using Claude via the UST LLM API Gateway.

The chatbot's job is to **prove two things work together** before anything is built on
top of them:

1. The UST LLM gateway is correctly wired and serving Claude models.
2. The abhrademo4 knowledge base can ground useful, citable answers.

It is a proof of the pipeline, not a product. It will later be placed on the NowOps
dashboard page, and later still be absorbed into the NowOps standalone application.
Neither of those is in scope here.

### Background

NowOps is UST's proprietary Application Management and IT Operations framework, built on
ServiceNow. It unifies dashboards (Application 360, SDM QBR), service catalogs,
automation workflows, and cross-application visibility. It is live today on the
`abhrademo4` instance.

The longer-term goal is a **NowOps standalone application**, so a client arriving with a
different ticketing platform (Jira, for example) can use NowOps by connecting their own
instance. That standalone app is a **separate project with its own spec**. This chatbot
precedes it deliberately: it de-risks the LLM and retrieval layer in isolation, where
failures are cheap to diagnose.

---

## 2. Scope

### In scope

- Node/TypeScript Express service
- Knowledge base sync from abhrademo4 over OAuth: automatic at startup, re-runnable on demand
- In-memory keyword (BM25) retrieval index
- Single-shot Claude call per question, grounded strictly in retrieved articles
- Static HTML + vanilla JS chat UI
- A visible source line under every answer, linking cited articles back to abhrademo4
- Model picker across the Claude models available on the gateway
- Health endpoint and manual re-sync endpoint

### Out of scope

Deliberate later increments, not oversights:

Auth/SSO · Postgres persistence · web search fallback · embeddings / vector search ·
streaming responses · multi-user sessions · AWS deployment · NowOps dashboard embedding ·
Jira or any non-ServiceNow connector.

---

## 3. Context that shaped the design

Measured on abhrademo4, 2026-09-13:

| Metric | Value |
|---|---|
| Total `kb_knowledge` records | 821 |
| Published | 732 |
| Largest knowledge base | Security Incident — 489 (demo data) |
| Content knowledge bases | Knowledge 108, IT 72, KCS 8, SOP 4, Known Error 3 |
| Article body length | avg ~217 chars, max ~2,000 (40-article sample) |

**Consequence:** the corpus is tiny — roughly 40k tokens for everything published. This is
the single most important design input. It means **no vector database, no embeddings, and
no RAG pipeline**. Keyword retrieval over an in-memory index is faster to build, easier to
debug, and likely more accurate on articles this short. Embeddings are revisited only if a
measured retrieval failure justifies them.

Two findings from follow-up investigation on 2026-09-13:

- The length statistics come from a 40-article sample, not the full corpus. Still open.
- **The ~123 articles in "unresolved" knowledge bases are the most valuable content in the
  instance.** Their `kb_knowledge_base` records are unreadable via the API (ACL-restricted),
  so they have no resolvable title — but the articles themselves read fine. They hold 68
  Service Graph Connector / Dynatrace integration errors, 17 Oracle Fusion SOPs and tax
  issues, 10 IT operations runbooks (onboarding, offboarding, licence allocation, SLA breach
  triage), 9 payroll questions written in genuine user voice, and 8 hardware troubleshooting
  guides. A title-based allowlist would have excluded all of it. See D9.
- **Article numbers are not unique on this instance.** `KB0010004` identifies four different
  articles; `KB0010141`, `KB0010145`, `KB0010147` and `KB0010005` are also duplicated across
  knowledge bases. See D10.

The LLM gateway integration follows `nowstudio-reference.md`, distilled from the
NowStudio/Codon platform.

---

## 4. Architecture

```
Browser (static HTML + vanilla JS)
    │  POST /api/chat  { message, conversationId, model? }
    ▼
Express server (TypeScript, Node 22)
    ├── KB index        in-memory, built at startup
    ├── Retriever       BM25 → top-K articles + scores
    ├── Claude client   Anthropic SDK → UST LiteLLM gateway
    └── Conversation    in-memory Map, process lifetime only
    ▲
    │  OAuth REST sync
ServiceNow abhrademo4  (kb_knowledge)
```

Four modules with distinct responsibilities, each testable in isolation:

| Module | Responsibility | Depends on |
|---|---|---|
| `servicenow/` | OAuth token refresh, fetch articles | env config |
| `index/` | HTML strip, tokenise, build index, score queries | nothing (pure) |
| `llm/` | Gateway client, prompt assembly, citation verification | env config |
| `server/` | Routes, static files, conversation state | all three |

No database. Conversation state lives in memory and dies with the process. Postgres
arrives with the standalone app, following the nowstudio-reference shape.

### Request flow

1. User sends a message.
2. Retriever scores it against the index; returns top-K (K=5) articles with scores.
3. **If the best score is below threshold → return "not in the knowledge base" and do not
   call the model.** "I don't know" is a retrieval decision, not a hoped-for model
   behaviour. Cheaper, faster, and far more reliable than a prompt instruction.
4. Otherwise retrieved articles enter the prompt as a delimited context block carrying
   their KB numbers.
5. Claude answers, instructed to ground strictly in the supplied articles.
6. Citations are verified against the supplied set; fabricated ones are stripped and logged.
7. Response returns `{ answer, sources[], grounded }`; the UI renders the source line.

---

## 5. Decisions

Each was chosen over stated alternatives during design.

| # | Decision | Chosen | Rejected alternatives and why |
|---|---|---|---|
| D1 | Backend language | **TypeScript + Node/Express** | Python/FastAPI — would diverge from the NowStudio/Codon stack this may later be hosted on |
| D2 | Retrieval source | **Sync to local index at startup** | Live query per question (couples every turn to instance uptime); whole corpus in cached prompt (no relevance signal, won't scale to client KBs) |
| D3 | Frontend | **Static HTML + vanilla JS** | React/Vite (build step before a working chat box); embeddable widget (solves embedding before the pipeline is proven) |
| D4 | Fallback when KB has no answer | **Say so; no fallback** | Model-knowledge answers (unsourced answers look authoritative); web search (gateway support for Anthropic server-side tools is unverified, and egress is default-deny) |
| D5 | Corpus | **Curated, configurable allowlist** | Everything published (67% security-incident demo noise); Knowledge+SOP only (loses 72 IT how-tos) |
| D6 | Retrieval/LLM wiring | **Single-shot** | Tool-use (2-3x calls, nondeterministic, harder to debug); two-pass query rewrite (extra latency for a corpus this small) |
| D7 | Article ingestion | **Node performs its own OAuth** | PowerShell exports `kb.json` (manual refresh, proves nothing about live integration). Node cannot read the DPAPI-encrypted PowerShell token store |
| D8 | Project location | **`C:\dev\nowops-chat`** | Inside OneDrive — `node_modules` sync-thrash, and `.env` secrets uploaded to cloud version history |
| D9 | Corpus allowlist keyed by | **Knowledge base `sys_id`** | Title — 9 knowledge bases holding 123 of the most relevant articles have ACL-restricted records and no readable title, so a title-based allowlist silently drops them |
| D10 | Citation and identity key | **Article `sys_id`**, with `[n]` labels in the prompt | Article `number` — not unique on this instance, so number-based citation can resolve to the wrong article |

---

## 6. Project layout

```
nowops-chat/
├── .nvmrc                 Node 22 LTS
├── package.json
├── tsconfig.json
├── .env.example           placeholder keys only, committed
├── .env                   real secrets, gitignored, never committed
├── src/
│   ├── config.ts          load + validate env (zod), fail fast
│   ├── servicenow/
│   │   ├── auth.ts        refresh-token grant → access token
│   │   └── articles.ts    fetch kb_knowledge for allowlisted KBs
│   ├── index/
│   │   ├── build.ts       strip HTML, tokenise, build BM25 index
│   │   └── search.ts      score query → top-K + scores
│   ├── llm/
│   │   └── client.ts      Anthropic SDK → gateway; prompts; citation checks
│   └── server/
│       ├── app.ts         Express, static, middleware
│       └── routes.ts      /api/chat, /api/sync, /api/health
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── tests/
```

**No virtualenv equivalent is needed.** `node_modules/` is project-local and isolated by
default with no activation step. `.nvmrc` pins the Node version; `package-lock.json` pins
dependencies exactly.

Dependencies stay thin: `express`, `@anthropic-ai/sdk`, `dotenv`, `zod`; dev-only
`typescript`, `tsx`, `vitest`. **BM25 is hand-rolled (~40 lines)** rather than taken as a
dependency — over a ~195-article corpus the code must be readable when retrieval
misbehaves.

---

## 7. Configuration

```
# LLM gateway
ANTHROPIC_API_KEY        gateway key
ANTHROPIC_BASE_URL       https://llmproxy.<domain>
CLAUDE_MODEL             exact gateway model id
CLAUDE_MODEL_CHOICES     optional, comma-separated, powers the UI model picker

# ServiceNow
SN_INSTANCE_URL          https://abhrademo4.service-now.com
SN_CLIENT_ID
SN_CLIENT_SECRET
SN_REFRESH_TOKEN         exported once from the existing PowerShell connection
SN_KB_ALLOWLIST          comma-separated knowledge base sys_ids (NOT titles — see D9)

# Retrieval
RETRIEVAL_TOP_K          default 5
RETRIEVAL_MIN_SCORE      set by calibration (section 9)
```

Gateway base URL and model IDs are **inputs supplied at implementation time**, not open
design questions. They are held by the project owner.

### Gateway rules

Taken directly from `nowstudio-reference.md`, where each cost real debugging time:

1. **No `GET /v1/models` discovery.** LiteLLM gates the model list behind an admin key;
   discovery returns empty and the fallback list silently becomes the live answer. The
   model list is explicit configuration.
2. **Never assume a public Anthropic model id works.** The gateway renames them and a wrong
   id is a *silent wrong answer*, not an error. Therefore **startup preflight**: one cheap
   call against the configured model, and the server refuses to start if it fails.
3. **Runtime-repointable config.** `config.ts` resolves `override ?? env ?? throw`, so a
   gateway move needs no code change.
4. **Mask keys in logs** (`sk-abc12…wxyz`), with an explicit deny-list of secret env names
   in the logger.

### Startup sequence

```
load+validate config → preflight gateway → SN token refresh
→ fetch articles → build index → listen
```

Each step fails fast with a specific, actionable message.

---

## 8. ServiceNow ingestion

Fields fetched per published article in an allowlisted knowledge base: `number`,
`short_description`, `text`, `kb_category`, `kb_knowledge_base`, `sys_id`.

Authentication uses the OAuth **refresh-token grant** against
`https://abhrademo4.service-now.com/oauth_token.do`. The instance is already configured
with an authorization-code OAuth client; the refresh token is exported once from the
existing working connection and placed in `.env`. Refresh tokens last ~100 days.

Two instance-specific behaviours already confirmed and relevant to future work:

- The instance **enforces the OAuth `state` parameter** on authorize requests.
- Basic authentication against the REST API returns 401 with responses byte-identical to
  sending no credentials at all; OAuth is the supported path.

---

## 9. Retrieval

### Indexing

Article bodies are HTML: ingestion strips tags and decodes entities. Tokenisation is
lowercase, punctuation-stripped, stopword-filtered. **No stemming initially** — on
~217-character articles it hurts about as often as it helps; add it only if the eval says
otherwise.

### Scoring

BM25 with two corpus-specific adjustments:

- **Title weighting** — `short_description` scores ~3x the body. On articles this short the
  title carries most of the signal.
- **Exact-code boost** — identifiers such as `KB0010096` or bracketed failure codes get a
  large boost on literal match. Users paste error codes, and BM25 under-weights rare tokens
  that constitute the entire question.

Top-K = 5, capped by a total context character budget so a few long articles cannot crowd
out the prompt.

### Threshold calibration

The "I don't know" threshold is **not** a guessed constant. It is set by an eval set:

- 15-20 realistic questions, each with the article that should be returned
- 5 deliberately out-of-scope questions that must return nothing

The threshold is chosen where in-scope questions pass and out-of-scope questions do not.
The eval set then lives on as a regression test, so future scoring changes are measurable
rather than vibes.

**The eval set is written:** `tests/fixtures/retrieval-eval.json` — 35 in-scope questions
and 10 out-of-scope, each in-scope entry naming its expected article by `sys_id`.

Every question carries a `source`:

- **`incident` (15 in-scope, 7 out-of-scope)** — verbatim `short_description` text from real
  tickets on this instance, matched by hand to the article that answers them. Spelling,
  casing and truncation left exactly as users wrote them (`"windows security pop up
  everytime i try to use outlook."`).
- **`synthetic` (20 in-scope, 3 out-of-scope)** — authored from article titles and
  paraphrased. Retained for coverage of topics real tickets did not exercise, notably the
  Service Graph Connector and Oracle Fusion articles.

Entries also carry a `confidence` of `high` (the article directly answers the ticket) or
`medium` (best available match, should rank first, does not fully resolve). Medium cases
test graceful degradation rather than precision.

`syn-20` and `inc-01`/`inc-02` form a paired regression test for D10: they target the two
*different* articles that both carry the number `KB0010141`, proving resolution must happen
by `sys_id`.

### The finding that should shape demo expectations

The instance holds 36,023 incidents, and **most of them are not knowledge-base-answerable.**
The dominant traffic is machine-generated monitoring alerts
(`Critical alert [Alert2276070] . Created on Node: []…`), reported-phishing emails, and
fragments such as `"Hi Team,"`, `"nan"` and `"711 Tech Support Phone# - 2106249028"`. Only a
minority of genuine tickets map to an article.

**Expect this chatbot to answer "no knowledge base match" for most real traffic.** That is
correct behaviour, not a defect — but it needs saying before a demo, not after. The
out-of-scope set is built from exactly this noise, so the threshold is calibrated against
what the bot will really see rather than against trivia questions.

There is also no instance-provided ground truth: `m2m_kb_task` is empty and `kb_use` carries
no task reference. All question-to-article mappings are hand-made and therefore fallible.

---

## 10. Prompt and grounding

The system prompt establishes: answer only from the supplied articles; cite by label; if the
articles do not contain the answer, say so rather than reaching for general knowledge.

**Articles are labelled `[1]`–`[5]` in the context block, and the model cites those labels —
not KB numbers.** Two reasons. Article numbers are not unique here (D10), so a number-based
citation can resolve to the wrong article. And a small integer drawn from a five-item list
is far harder to fabricate than a plausible-looking `KB00…` string. The server maps labels
back to `sys_id` when building the source line.

**Citation verification.** Prompt instructions are not guarantees. After each response, the
labels the model cited are intersected with the labels actually supplied. Anything outside
that set is stripped from the source line and the discrepancy is logged. Combined with
label-based citation, this makes it structurally impossible for the source line to point at
an article that was not really retrieved.

### Conversation handling

The last ~6 turns go to the model for continuity. **Retrieval runs on the current message
only.** Using full history for retrieval makes results drift as conversations wander, and
makes debugging unpleasant. If follow-ups such as "what about the second one?" retrieve
poorly, that is the signal to revisit — and precisely the case the rejected tool-use
approach (D6) would address later.

---

## 11. API contract

| Endpoint | Purpose |
|---|---|
| `POST /api/chat` | `{ message, conversationId, model? }` → `{ answer, sources[], grounded }` |
| `POST /api/sync` | Rebuild the index from abhrademo4; returns article count and duration |
| `GET /api/health` | Gateway reachability, model id in use, article count, last sync time |

`sources[]` entries: `{ number, title, sysId, score, url }`.

---

## 12. Frontend

One static page served by Express — no bundler, no build step. Chosen partly because
ServiceNow Service Portal widgets are HTML/JS, so this markup ports across with little
rework when the chatbot moves onto the NowOps dashboard page.

The **source line under each answer is a first-class requirement**, with three states:

| State | Rendering |
|---|---|
| Grounded | `Sources: KB0010096 · KB0010112`, each linked by **sys_id**: `.../kb_view.do?sys_kb_id=<sys_id>` |
| No match above threshold | `No knowledge base match — not answered` |
| Citations stripped | Verified citations only, plus a server-side warning log |

Links resolve by `sys_id`, never by article number — `kb_view.do?sysparm_article=KB0010141`
is ambiguous on this instance and can open the wrong article (D10). The number is displayed
as the human-readable label only.

A typing indicator covers perceived latency while responses are non-streaming.

---

## 13. Error handling

Principle: **fail loudly at boot, degrade gracefully at runtime.**

| Failure | Handling |
|---|---|
| Gateway unreachable or key rejected | Preflight fails; server refuses to start, reporting masked key and base URL |
| Wrong model id | Same preflight. This is the reference's "silent wrong answer" trap and must be a boot failure |
| Gateway 429 / 5xx at runtime | SDK retry with backoff; on exhaustion the UI shows "the model is busy" and the conversation is preserved |
| ServiceNow refresh token expired or revoked | `/api/sync` returns a clear error; **the existing index keeps serving**. A stale bot beats a dead one |
| abhrademo4 hibernating or reset | As above; `/api/health` surfaces the stale sync time |
| Index empty at boot | Refuse to start — nothing to ground on means every answer is "I don't know" |
| Oversized or abusive input | Message length cap, rejected before reaching the gateway |

---

## 14. Observability

Every chat request logs: the query, the top-K article numbers **with their scores**, the
model used, and latency.

This single log line is what makes "it gave a stupid answer" diagnosable — it distinguishes
a retrieval failure from a model failure without guesswork. Secrets never appear in logs
(masking plus env deny-list, section 7).

---

## 15. Testing

Test-first. The design deliberately concentrates the interesting logic in pure functions
that need no network.

| Layer | Covers |
|---|---|
| Unit | HTML stripping, tokeniser, BM25 scoring, threshold decision, citation verification |
| Retrieval eval | The 20-question set from section 9, run as a test — the one that catches real regressions |
| Integration | Routes against a stubbed gateway and recorded ServiceNow fixtures, so CI never needs live credentials |
| Live smoke | Manual: `/api/health` plus a handful of real questions |

---

## 16. Acceptance criteria

1. `npm run dev` boots; preflight passes; the index reports its article count.
2. `/api/health` shows gateway reachable, model id, article count, last sync time.
3. Five known questions return correct answers with correct KB citations, and every link
   opens the right article in abhrademo4.
4. An out-of-scope question returns "No knowledge base match" **without calling the model**.
5. The model picker switches between gateway Claude models and answers still ground
   correctly.
6. No secrets appear in any log line.
7. The retrieval eval passes.

---

## 17. Required inputs before implementation

| Input | Source |
|---|---|
| Gateway base URL and exact model ids | Project owner (in hand) |
| Gateway API key | Project owner |
| ServiceNow OAuth client id, secret, refresh token | Existing abhrademo4 OAuth app |
| ~~Eval question list~~ | **Done** — `tests/fixtures/retrieval-eval.json`, 22 in-scope + 5 out-of-scope |
| ~~Identity of the ~123 articles in unresolved knowledge bases~~ | **Done** — identified 2026-09-13; see section 3 and D9 |
| Full-corpus article length distribution | Investigation task, minor |
| Real user phrasing sampled from `incident.short_description` | Follow-up to strengthen the eval set (section 9) |

---

## 18. Later increments

In rough order of likely value:

1. Streaming responses.
2. Tool-use retrieval (D6) once multi-part follow-ups demand it.
3. Postgres-backed conversation persistence, per the nowstudio-reference shape.
4. Auth/SSO, following the UST posture: SSO with a single break-glass local account.
5. Embedding into the NowOps dashboard page.
6. Web search fallback — gated on a spike confirming the gateway forwards Anthropic
   server-side tools.
7. Absorption into the NowOps standalone application (separate spec).
