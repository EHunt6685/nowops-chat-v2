# NowOps Chatbot — Design Spec

- **Date:** 2026-09-13 (revision 5 - knowledge base allowlist removed after A/B measurement)
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

- Node/TypeScript Express service, **ServiceNow only**
- **Live knowledge base search against abhrademo4** over OAuth, per question
- A three-layer relevance gate deciding whether to answer or decline
- Single Claude call per question, grounded strictly in retrieved articles
- Static HTML + vanilla JS chat UI
- A visible source line under every answer, linking cited articles back to abhrademo4
- Health endpoint
- One eval script (`npm run eval`) reporting recall and a threshold sweep

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
| Incidents | 36,023 |

Findings from investigation, each of which changed a decision:

- **The ~123 articles in "unresolved" knowledge bases are the most valuable content in the
  instance.** Their `kb_knowledge_base` records are ACL-restricted, so they have no
  resolvable title — but the articles themselves read fine. They hold 68 Service Graph
  Connector / Dynatrace integration errors, 17 Oracle Fusion SOPs, 10 IT operations
  runbooks, 9 payroll questions in genuine user voice, and 8 hardware guides. This is why
  no filtering by knowledge base title could ever have worked — and, once measured, why no
  filtering happens at all (D5).
- **Article numbers are not unique.** `KB0010004` identifies four different articles;
  `KB0010141`, `KB0010145`, `KB0010147` and `KB0010005` are also duplicated. See D10.
- **The knowledge base contains duplicate articles** with identical titles and different
  sys_ids (`KB0010237`/`KB0010239`; `KBSGC0000019`/`KBSGC0000021`). "The correct answer"
  is therefore sometimes a set, not a single record.
- **ServiceNow's own text search is good enough to use directly**, measured at 83%
  recall@5 across the eval set. This removed the need for a local index entirely. See D2.
- **Most incident traffic is not knowledge-base-answerable** — see section 9.

The LLM gateway integration follows `nowstudio-reference.md`, distilled from the
NowStudio/Codon platform.

---

## 4. Architecture

```
Browser (static HTML + vanilla JS)
    │  POST /api/chat  { message, conversationId, model? }
    ▼
Express server (TypeScript, Node 22)
    ├── servicenow/    OAuth + live query → abhrademo4, ≤5 Articles
    ├── gate/          3 layers → answer or decline
    ├── llm/           Anthropic SDK → UST LiteLLM gateway
    └── server/        routes + in-memory conversation, process lifetime only
    ▲
    │  OAuth REST, per question
ServiceNow abhrademo4  (kb_knowledge text search)
```

Four modules with distinct responsibilities, each testable in isolation:

| Module | Responsibility | Depends on |
|---|---|---|
| `servicenow/` | OAuth token refresh, knowledge base text search | env config |
| `gate/` | Tokenise, score coverage, decide answer vs decline | nothing (pure) |
| `llm/` | Gateway client, prompt assembly, citation verification | env config |
| `server/` | Routes, static files, conversation state | all three |

`Article` is the record type search returns. It is a plain data shape, not an abstraction
layer — there is no connector interface and no second implementation (D12).

No database and **no local index**. Conversation state lives in memory and dies with the
process. Postgres arrives with the standalone app, following the nowstudio-reference shape.

### Request flow

1. User sends a message.
2. **Token guard** (gate layer 1). Fewer than 2 meaningful words → decline immediately,
   before any network call.
3. Search abhrademo4 live, returning up to 5 candidate articles.
4. **Coverage floor** (gate layer 2). If the best candidate clears it, jump to step 7.
5. **Otherwise triage the weak result** (D13). Show Claude the question and the poor
   candidates; it either declares the question out of scope, or proposes better search
   terms.
6. Given better terms, **search once more** and union the results with the first set,
   deduplicated by `sys_id`. Re-apply the coverage floor; still weak → decline.
   **One retry maximum, ever.**
7. Surviving articles enter the prompt as a delimited context block, labelled `[1]`–`[5]`.
8. Claude answers, instructed to ground strictly in the supplied articles and permitted to
   decline if they do not contain the answer.
9. Cited labels are verified against those supplied; fabrications are stripped and logged.
10. Response returns `{ answer, sources[], grounded, gateReason, retried }`; the UI renders
    the source line.

Steps 5 and 6 are the measured +15-point improvement (D13). Everything else is unchanged
from the version without retry, and setting `RETRY_ENABLED=false` restores it exactly.

---

## 5. Decisions

| # | Decision | Chosen | Rejected alternatives and why |
|---|---|---|---|
| D1 | Backend language | **TypeScript + Node/Express** | Python/FastAPI — would diverge from the NowStudio/Codon stack this may later be hosted on |
| D2 | Retrieval | **Live ServiceNow text search (`123TEXTQUERY321`) per question** | *Revised in rev 2.* A hand-rolled BM25 index over a synced corpus was the original choice; measurement showed the instance's own search reaches 83% recall@5 with no index, no sync job, no staleness, and no failure mode when the instance is unreachable at boot. Rebuilding it locally would be reinventing a working wheel — and copying each client's knowledge base does not scale to the standalone app, where clients connect their own systems |
| D3 | Frontend | **Static HTML + vanilla JS** | React/Vite (build step before a working chat box); embeddable widget (solves embedding before the pipeline is proven) |
| D4 | Fallback when KB has no answer | **Say so; no fallback** | Model-knowledge answers (unsourced answers look authoritative); web search (gateway support for Anthropic server-side tools is unverified, and egress is default-deny) |
| D5 | Corpus | **No knowledge base filter — search everything published** | *Reversed in rev 5.* Rev 1-4 filtered to a curated allowlist on the theory that 489 of 732 published articles are Security Incident demo noise. **Measured A/B over all 45 eval questions: the allowlist changed exactly one result, promoting `syn-03` from rank 2 to rank 1. recall@5 identical (29/35), noise rejection identical (7/10), average coverage within 0.01.** Since the top 5 articles all reach the prompt, a rank shift inside the top 5 changes no answer a user sees. It was costing a 461-character env var, ongoing maintenance, and an entire second decision (the old D9) that existed only to serve it. Residual risk accepted: no eval question targets security-incident content, so a filter may yet be warranted — but re-adding one clause to the query is trivial, and by then there would be a real failing example to test against |
| D6 | Retrieval/LLM wiring | **Single-shot** | Tool-use (2-3x calls, nondeterministic, harder to debug). Note: tool use does *not* mean Claude searches the instance — our server always executes the query either way; the only difference is who decides when to search |
| D7 | Article ingestion | **None — no ingestion** | *Revised in rev 2.* Follows from D2: with live search there is nothing to ingest, so the OAuth refresh token is used per request rather than at startup sync |
| D8 | Project location | **`C:\dev\nowops-chat`** | Inside OneDrive — `node_modules` sync-thrash, and `.env` secrets uploaded to cloud version history |
| D9 | *withdrawn* | — | Specified how to key the corpus allowlist. Deleted in rev 5 along with the allowlist itself (D5). Retained as a numbered placeholder so D10–D13 keep their identities in earlier commits and discussion |
| D10 | Citation and identity key | **Article `sys_id`**, with `[n]` labels in the prompt | Article `number` — not unique on this instance, so number-based citation can resolve to the wrong article |
| D11 | Relevance gate | **Three layers: token-count guard, coverage floor, then Claude** | A single coverage threshold — measured, and the distributions overlap too much (section 9). No single cutoff both keeps good answers and rejects noise |
| D13 | Weak search results | **Triage with Claude, then retry the search once with better terms** | Accepting the first result set. Measured: of the 6 questions the baseline misses, **5 are recovered at rank 1** by rewriting the query � lifting recall@1 from 26/35 (74%) to roughly 31/35 (89%). Both worst failures (`"windows security pop up � outlook."` and `"new joiner starts on monday"` both returning *"What is the Windows key?"*) are vocabulary mismatches, which rewriting fixes and no scoring change can. Rejected alternatives: re-ranking the existing 5 results, capped at recall@5 = 83% because it cannot promote an article it was never given; and unconditional retry, which doubles cost on traffic that is mostly noise |
| D12 | Platform coupling | **Call ServiceNow directly. No connector interface** | *Reversed in rev 4.* Rev 3 introduced a `KnowledgeConnector` seam for future Jira support. Reversed on the owner's decision: this proof targets ServiceNow only, and the seam added an interface, a selector, a fake implementation and a contract test to a project whose whole point is to be small. Adding a second platform later means refactoring two files rather than adding one — an acceptable trade at this size. `Article` remains as a plain record type |

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
│   │   ├── types.ts       Article + PlatformUnavailableError
│   │   ├── auth.ts        refresh-token grant → cached access token
│   │   └── search.ts      live kb_knowledge text search
│   ├── gate/
│   │   ├── tokenise.ts    lowercase, strip punctuation, stopwords
│   │   └── decide.ts      token guard + coverage floor → answer or decline
│   ├── llm/
│   │   └── client.ts      Anthropic SDK → gateway; prompts; citation checks
│   └── server/
│       ├── app.ts         Express, static, middleware
│       └── routes.ts      /api/chat, /api/health
├── tools/
│   └── eval.ts            npm run eval — recall@k plus a threshold sweep
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── tests/
    └── fixtures/
        └── retrieval-eval.json
```

### The Article record

```ts
interface Article {
  id: string          // ServiceNow sys_id
  label?: string      // display only — KB0010141
  title: string
  body: string
  url: string         // how a human opens it
}
```

`Article.id` is the identity key throughout — on ServiceNow that is `sys_id` (D10). This is
a record type, not an interface anything implements.

**No virtualenv equivalent is needed.** `node_modules/` is project-local and isolated by
default with no activation step. `.nvmrc` pins the Node version; `package-lock.json` pins
dependencies exactly.

Dependencies stay thin: `express`, `@anthropic-ai/sdk`, `dotenv`, `zod`; dev-only
`typescript`, `tsx`, `vitest`.

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
SN_REFRESH_TOKEN         exported from the existing connection via Export-SnEnvFile
(no knowledge base filter — see D5)

# Relevance gate
GATE_MIN_TOKENS          default 2
GATE_MIN_COVERAGE        default 0.3
SEARCH_LIMIT             default 5
RETRY_ENABLED            default true — set false to disable D13 retry entirely
```

Gateway base URL and model IDs are **inputs supplied at implementation time**, not open
design questions.

### Gateway rules

Taken directly from `nowstudio-reference.md`, where each cost real debugging time:

1. **No `GET /v1/models` discovery.** LiteLLM gates the model list behind an admin key;
   discovery returns empty and the fallback list silently becomes the live answer. The
   model list is explicit configuration.
2. **Never assume a public Anthropic model id works.** The gateway renames them and a wrong
   id is a *silent wrong answer*, not an error. Therefore **startup preflight**: one cheap
   call against the configured model, and the server refuses to start if it fails.
3. **Runtime-repointable config.** `config.ts` resolves `override ?? env ?? throw`.
4. **Mask keys in logs** (`sk-abc12…wxyz`), with an explicit deny-list of secret env names.

### Startup sequence

```
load+validate config → preflight gateway → ServiceNow token refresh + one probe search
→ listen
```

Each step fails fast with a specific, actionable message. Note the probe search verifies
connectivity and credentials; unlike rev 1 there is no corpus to load.

---

## 8. ServiceNow search

Per question, one query against `kb_knowledge`:

```
sysparm_query = workflow_state=published^123TEXTQUERY321=<user question>
sysparm_fields = sys_id,number,short_description,text
sysparm_limit  = 5
```

Two clauses, no knowledge base filter (D5).

`123TEXTQUERY321` invokes ServiceNow's own indexed text search with relevance ordering.
The user's question is passed through after stripping `^`, `=` and `&`, which would
otherwise break query syntax.

Authentication uses the OAuth **refresh-token grant** against `/oauth_token.do`. Access
tokens are cached in memory until expiry rather than refreshed per request.

Two instance behaviours confirmed and relevant:

- The instance **enforces the OAuth `state` parameter** on authorize requests.
- The Knowledge Management API (`/api/sn_km_api/...`) is **not activated** here — it
  returns `Requested URI does not represent any resource`. The Table API text search is
  the available path.

---

## 9. Relevance gate

Search returns something for almost any input, so the gate — not search — is what makes
"I don't know" possible.

### Measured baseline (2026-09-13, 45 eval questions, live)

| Metric | Result |
|---|---|
| Recall@1 | 26/35 (74%) |
| Recall@3 and @5 | 29/35 (83%) |
| Synthetic questions | 18/20 (90%) |
| **Real incident questions** | **11/15 (73%)** |
| Real incident, high-confidence only | **10/11 (91%)** |

The 90%/73% split is the title-vocabulary bias made visible: questions authored from
article titles score better than real user text. **73% is the number to trust**, and the
91% on high-confidence tickets is the realistic ceiling for questions the knowledge base
genuinely covers.

Three of the four remaining misses are `medium`-confidence entries — cases where no article
really answers the ticket and the eval nominates a best-available stretch.

Two instructive failures: `"windows security pop up everytime i try to use outlook."` and
`"new joiner starts on monday"` both returned *"What is the Windows key?"* — the search
matched on "windows" and "starts/monday". No scoring scheme fixes that; it is a recall
limitation to improve on, not a gate problem.

### Why a single threshold does not work

Term coverage — the fraction of a question's meaningful tokens appearing in the top
article — separates well on average and badly in the tails:

```
In-scope  coverage: avg 0.68
Out-scope coverage: avg 0.26, max 1.00
```

Threshold sweep:

| Cutoff | Keeps good answers | Rejects noise |
|---|---|---|
| 0.3 | 31/35 | 7/10 |
| 0.5 | 26/35 | 8/10 |
| 0.7 | 20/35 | 9/10 |

At 0.7 a third of correct answers are discarded to reject 90% of noise. The degenerate
case shows why: `"Hi Team,"` scores **1.00**, because after stopword removal only "team"
remains and it appears in the article. Short queries saturate the metric.

### The three-layer gate (D11)

1. **Token-count guard** — fewer than `GATE_MIN_TOKENS` (2) meaningful terms → decline
   immediately, without searching. Eliminates `"Hi Team,"`, `"nan"`, `"Bky OLO"`.
2. **Coverage floor** — top candidate below `GATE_MIN_COVERAGE` (0.3) → decline. Removes
   `"what is the capital of France"` (0.00) and `"Critical alert…"` (0.11) while keeping
   31/35 good answers.
3. **Claude as final judge** — survivors go to the model, which is explicitly permitted to
   decline. Not trusted alone; it is the last line behind two mechanical filters.

Applied to the measured run, this rejects 9–10 of 10 noise cases while keeping 31 of 35
good answers. The sole survivor is `"EOM JOB STATUS"` → *"SOP – Resolving Batch Job Non-OK
Status"*, which is arguably a fair answer.

### Query rewriting and retry (D13)

Failing layer 2 no longer means an immediate decline. Instead Claude triages the weak
result and either declares the question out of scope, or proposes better search terms for
one more attempt.

**Measured on the six baseline misses, five are recovered at rank 1:**

| Question | First search | After rewriting |
|---|---|---|
| `"windows security pop up … outlook."` | *What is the Windows key?* | **#1** Outlook after password reset |
| `"Warehouse printer … IP not acquired"` | Citizen thermal printer | **#1** Zebra Label & Receipt Printers |
| `"Unable to login VPN"` | Oracle environment login | **#1** Unable to Launch VPN Client |
| `"gcp integration will not connect…"` | Unable to load connection alias | **#1** Unable to make a connection to GCP API |
| `"new joiner starts on monday…"` | *What is the Windows key?* | **#1** New Starter Onboarding |
| `"Cannot connect to VPN"` | Schroders Intranet | still missed — but returns *VPN Login Redirect Failure in Cisco Secure Client*, arguably a better answer than the eval's expectation |

Expected recall@1: **26/35 (74%) → ~31/35 (89%)**.

**Constraints that keep this safe:**

- **One retry maximum.** No loops, no second rewrite.
- **Results are unioned**, deduplicated by `sys_id`, so a good article found by the first
  search is never lost by the second.
- **Triage is a separate, small call** — it returns either `OUT_OF_SCOPE` or a query string,
  never prose.
- `RETRY_ENABLED=false` restores the previous behaviour exactly, for A/B comparison.

**The cost, stated plainly.** Coverage cannot distinguish "badly worded" from "genuinely
absent" — `"windows security pop up… outlook"` scores 0.29 and `"what is the capital of
France"` scores 0.00, and the first is rescuable while the second is not. So triage fires on
every question that passes the token guard and fails the coverage floor. Since most real
traffic is declined, **a decline now costs one Claude call instead of zero**, and a rescued
answer costs three. Latency for a rescued answer roughly doubles, to ~5s.

Claude is the right judge for that discrimination — telling "capital of France" from "Outlook
password prompt" is exactly what a model is good at, and the token guard still filters the
cheapest noise for free before any of this runs.

This also makes the system **nondeterministic**: the same question may take different paths
on different runs. The eval therefore keeps a deterministic search-only mode as its
regression guard, with retry measured separately (section 15).

### The eval set

`tests/fixtures/retrieval-eval.json` — 35 in-scope and 10 out-of-scope questions. Each
carries a `source` (`incident` = verbatim ticket text, `synthetic` = authored from titles)
and a `confidence` (`high` / `medium`).

Because the knowledge base contains duplicate articles, expected answers are expressed as
`acceptableSysIds` — a set, not a single record. Measurement proved this necessary:
`inc-14` was scored a miss when search returned a Salesforce login SOP that is a *better*
answer than the article originally nominated.

### The finding that should shape demo expectations

Of 36,023 incidents, the dominant traffic is machine-generated monitoring alerts
(`Critical alert [Alert2276070] . Created on Node: []…`), reported-phishing emails, and
fragments such as `"Hi Team,"`, `"nan"` and `"711 Tech Support Phone# - 2106249028"`.

**Expect this chatbot to answer "no knowledge base match" for most real traffic.** That is
correct behaviour, not a defect — but it needs saying before a demo, not after.

There is also no instance-provided ground truth: `m2m_kb_task` is empty and `kb_use`
carries no task reference. All question-to-article mappings are hand-made and fallible.

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
that set is stripped from the source line and the discrepancy is logged.

### Conversation handling

The last ~6 turns go to the model for continuity. **Search runs on the current message
only.** Using full history makes results drift as conversations wander. If follow-ups such
as "what about the second one?" retrieve poorly, that is the signal to revisit D6.

---

## 11. API contract

| Endpoint | Purpose |
|---|---|
| `POST /api/chat` | `{ message, conversationId, model? }` → `{ answer, sources[], grounded, gateReason? }` |
| `GET /api/health` | Gateway reachability, model id in use, ServiceNow search reachability |

`sources[]` entries: `{ number, title, sysId, label, url }`.
`gateReason` explains a decline (`too_few_tokens`, `low_coverage`, `out_of_scope`,
`model_declined`, `servicenow_unavailable`) and `retried: boolean` records whether D13 fired, so the
UI and logs can distinguish them.

There is no `/api/sync` — nothing is cached to sync (D7).

---

## 12. Frontend

One static page served by Express — no bundler, no build step. Chosen partly because
ServiceNow Service Portal widgets are HTML/JS, so this markup ports across with little
rework when the chatbot moves onto the NowOps dashboard page.

The **source line under each answer is a first-class requirement**, with three states:

| State | Rendering |
|---|---|
| Grounded | `Sources: KB0010096 · KB0010112`, each linked by **sys_id**: `.../kb_view.do?sys_kb_id=<sys_id>` |
| Declined | `No knowledge base match — not answered` |
| Citations stripped | Verified citations only, plus a server-side warning log |

Links resolve by `sys_id`, never by article number — `kb_view.do?sysparm_article=KB0010141`
is ambiguous on this instance and can open the wrong article (D10).

A typing indicator covers perceived latency while responses are non-streaming.

---

## 13. Error handling

Principle: **fail loudly at boot, degrade gracefully at runtime.**

| Failure | Handling |
|---|---|
| Gateway unreachable or key rejected | Preflight fails; server refuses to start, reporting masked key and base URL |
| Wrong model id | Same preflight. The reference's "silent wrong answer" trap must be a boot failure |
| Gateway 429 / 5xx at runtime | SDK retry with backoff; on exhaustion the UI shows "the model is busy" and the conversation is preserved |
| **ServiceNow unreachable or search fails at runtime** | The chat turn returns "I can't reach the knowledge base right now" — explicitly *not* the same message as "no match", so users and logs can tell an outage from an absent answer |
| ServiceNow refresh token expired or revoked | Same user-facing message; logs name the cause and the fix (`Connect-SnOAuth` then `Export-SnEnvFile`) |
| Search returns zero results | Normal decline path, `gateReason: low_coverage` |
| Triage call fails (D13) | Fall back to declining on the first result set. A retry failure must never surface as an error — the user gets the ordinary "not in the knowledge base" |
| Triage returns an unusable rewrite (empty, or the original query unchanged) | Skip the second search and decline. No loop |
| Oversized or abusive input | Message length cap, rejected before reaching search or the gateway |

With live search (D2) the availability of abhrademo4 is now on the **request** path rather
than the startup path. That is the main cost of this design, and the row above is how it is
contained.

---

## 14. Observability

Every chat request logs: the query, **the rewritten query when D13 fires**, the candidate
article numbers returned by each search, the coverage score of the top candidate before and
after any retry, the gate decision and reason, the model used, and
latency.

This single log line distinguishes a search failure from a gate failure from a model
failure without guesswork. Secrets never appear in logs (section 7).

---

## 15. Testing

Test-first. The design concentrates the interesting logic in pure functions needing no
network.

| Layer | Covers |
|---|---|
| Unit | Tokeniser, coverage scoring, token guard, gate decision, citation verification, triage-response parsing |
| Retrieval eval | `npm run eval` — the 45-question set, search only, **deterministic** |
| Retry eval | `npm run eval -- --with-retry` — same set through the full D13 path, using Claude |
| Integration | Routes against stubbed search and a stubbed gateway, so CI needs no live credentials |
| Live smoke | Manual: `/api/health` plus a handful of real questions |

**Two eval modes, deliberately.** Retry makes the system nondeterministic, and a regression
guard that wobbles run to run is worse than none. So the default mode measures raw search —
deterministic, free, and the thing that fails the build if it drops below 26/35 recall@1.
`--with-retry` measures the end-to-end improvement (expected ~31/35), costs Claude calls, and
is reported rather than enforced.

---

## 16. Acceptance criteria

1. `npm run dev` boots; gateway preflight passes; the ServiceNow probe search succeeds.
2. `/api/health` shows gateway reachable, model id, and ServiceNow search reachable.
3. Five known questions return correct answers with correct citations, and every link opens
   the right article in abhrademo4.
4. `"Hi Team,"` is declined **without calling the model at all** (`too_few_tokens`).
   `"what is the capital of France"` reaches triage, is declared `out_of_scope`, and is
   declined **without a second search and without an answer call**.
5. `"new joiner starts on monday"` — a baseline miss — is **answered correctly after one
   retry**, with `retried: true` and the rewritten query visible in the logs.
6. Retry never fires twice for one question, and a failing triage call degrades to an
   ordinary decline rather than an error.
7. Stopping network access to abhrademo4 produces "can't reach the knowledge base", not
   "no match".
8. No secrets appear in any log line.
9. `npm run eval` matches or beats the section 9 baseline (74% recall@1, 83% @5) and prints
   a threshold sweep.
10. `npm run eval -- --with-retry` reports materially better recall@1 than the deterministic
    run. If it does not, D13 is not earning its cost and should be reconsidered.

---

## 17. Required inputs before implementation

| Input | Status |
|---|---|
| Eval question list | **Done** — `tests/fixtures/retrieval-eval.json` |
| Identity of the ~123 articles in unresolved knowledge bases | **Done** — see section 3 |
| ServiceNow OAuth client id, secret, refresh token | **Done** — written to `.env` by `Export-SnEnvFile` |
| Gateway API key, base URL, model ids | **Outstanding** — held by the project owner |
| ~~Allowlisted knowledge base sys_ids~~ | **Not needed** — measured as ineffective and removed (D5) |

---

## 18. Later increments

In rough order of likely value:

1. **Improve recall past 74%@1** — the measured ceiling. Query preprocessing, synonym
   handling, or ServiceNow AI Search if it can be activated on the instance.
2. Streaming responses.
3. Articles describing NowOps and MemorialCare — neither exists in the knowledge base
   today, so *"what is NowOps?"* currently cannot be answered. Likely the first question
   anyone asks a NowOps chatbot.
4. Tool-use retrieval (D6) once multi-part follow-ups demand it.
5. Postgres-backed conversation persistence, per the nowstudio-reference shape.
6. Auth/SSO, following the UST posture: SSO with a single break-glass local account.
7. Embedding into the NowOps dashboard page.
8. Web search fallback — gated on a spike confirming the gateway forwards Anthropic
   server-side tools.
9. Absorption into the NowOps standalone application (separate spec).


---

## 19. A note on other ticketing platforms

Rev 3 carried a section here on making the chatbot platform-agnostic, plus a
`KnowledgeConnector` seam to support Jira. Both were removed in rev 4 (D12).

The reasoning is recorded because it stays true if the question returns: the
**architecture** would port, but the **measurements** would not. Retrieval quality is a
property of a specific search engine over specific content, so any new platform needs its
own eval set and its own calibrated threshold before anyone can say whether it works.
That is an information problem, not an engineering one, and no interface removes it.

Given that, adding the seam bought little: the expensive part of supporting Jira was never
the code. When a Jira client actually exists, `src/servicenow/` is two small files to
generalise.
