# NowOps Chatbot V2 — Design Spec

- **Date:** 2026-09-14 (revision 10 — build-readiness review: one ServiceNow client, table-name guard, metric label, no build step, stale rev 6–8 text removed)
- **Status:** Approved for implementation
- **Owner:** Sachin Chavan (UST)
- **Supersedes:** revision 5 (article path only). Revisions 6–9 were never built

> **What V2 adds.** Revision 5 answers from knowledge articles only. V2 adds a second
> answer path for operational KPIs — open incidents, SLA breaches, security incidents,
> assignment and aging counts — by **composing a read-only aggregate query and showing
> it alongside the number**. Everything in revision 5 is carried forward unchanged
> unless a decision says otherwise.
>
> **Revision 6 is superseded and was never built.** It specified a curated catalogue of
> `sys_report` definitions the model would select from. Measurement killed it: 15 of 15
> model-composed queries executed correctly on the first attempt, and the catalogue's
> only advantage — agreeing with a house definition — turned out to cost the ability to
> answer anything nobody had pre-catalogued. See D14 and D15.

---

## 1. Purpose

Build a lightweight chatbot that answers two kinds of question about the `abhrademo4`
instance, using Claude via the UST LLM API Gateway:

- **"How do I…"** — answered from the ServiceNow knowledge base.
- **"How many…"** — answered by composing a read-only aggregate query and running it live.

The chatbot's job is to **prove three things work together** before anything is built on
top of them:

1. The UST LLM gateway is correctly wired and serving Claude models.
2. The abhrademo4 knowledge base can ground useful, citable answers.
3. NowOps KPIs can be answered with a live number whose definition is the same one the
   dashboards use — and shown, so a reader can check it.

It is a proof of the pipeline, not a product. It will later be placed on the NowOps
dashboard page, and later still be absorbed into the NowOps standalone application.
Neither of those is in scope here.

Point 3 is what makes this worth building twice. A chatbot beside a dashboard that
disagrees with the dashboard is worse than no chatbot. Executing the dashboard's own
stored definition is what makes disagreement structurally impossible.

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
- **Operational KPI answers**: Claude composes a read-only aggregate query, the server
  executes it against `/api/now/stats/`, and the query is always shown (D14)
- A two-layer relevance gate deciding whether to answer or decline
- Single Claude call per question, which either answers from articles, selects one
  metric, or declines (D16)
- Static HTML + vanilla JS chat UI
- A visible source line under every answer: cited articles linked back to abhrademo4,
  or — for a metric — the table, the aggregate, **the filter that produced the number**, and
  a deep link to the matching record list
- Health endpoint
- One eval script — `npm run eval` for article recall, `npm run eval -- --metrics` for
  composed-query correctness

### Out of scope

Deliberate later increments, not oversights:

Auth/SSO · Postgres persistence · web search fallback · embeddings / vector search ·
streaming responses · multi-user sessions · AWS deployment · NowOps dashboard embedding ·
Jira or any non-ServiceNow connector.

Specifically out of scope on the metrics side, and each for a measured reason:

- **Writes of any kind.** Read-only `GET` against `/api/now/stats/` only. The model
  supplies `table`, `filter`, `aggregate` and `field` as data — never a URL, method or
  path.
- **Series and trends.** V2 answers a single number per question. *"Open incidents by
  priority"* as a breakdown needs a formatter and a UI decision; see section 18.
- **Guaranteeing agreement with a NowOps tile.** Where a KPI has a house definition the
  composed query may differ. The query is shown so the difference is visible; see
  section 8b.
- **Uptime, latency, synthetic checks, SLO breaches.** Not present anywhere in the
  instance — see the KPI inventory, section 2. No integration exists to source them.
- **Correcting NowOps' broken reports.** Several stored definitions are wrong (section
  8b). V2 reproduces them faithfully and shows the filter; fixing them is a NowOps task.

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

Measured for V2, same date, same instance:

| Metric | Value |
|---|---|
| Saved reports in `sys_report` | 963 |
| …excluding per-user `DYNAMIC` filters | 830 |
| …also excluding `GROUPBY` series | **456 scalar, answerable** |
| Incidents / open / open P1 | 36,030 / 5,513 / 14 |
| `task_sla` records / breached | 50,197 / 23,429 |
| Incidents carrying a CI | **183 (0.5%)** |
| Uptime, latency, synthetic-check data | **none — no such table exists** |

Findings that shaped D14 and D16:

- **Composed queries work.** 15 of 15 executed correctly on the first attempt, covering
  dotted-field traversal, `javascript:` date functions, relative-date windows and AVG
  aggregates. This is the measurement that removed the catalogue — see D14 and section 8b.
- **A tile's label does not define its query.** `Backlog Incidents Count` reads 1,292; a
  composed query for "the backlog" returns 5,377. The stored definition requires a UST
  custom field, requires an assignee and excludes P1 and P5. Real, and handled by showing
  the filter rather than by preventing composition.
- **Report titles are too short to retrieve against.** Text search over `sys_report`
  scored 5/8 and failed *"how many open incidents are there"*. Recorded because it rules
  out the obvious future shortcut, should house-definition lookup ever be revisited.
- **Report titles are not unique either.** `Vulnerable Items` exists three times across two
  tables; `SLA Adherence% Trend (Resolution) - P4` twice with different filters. The same
  problem as article numbers (D10) — anything keyed on reports must key on sys_id.
- **Some stored definitions are wrong** — `Tickets Approaching SLA Breach` never touches
  `task_sla`, and the four MTTR reports use four different time windows. A point against
  treating them as ground truth.
- **CMDB and observability limits are structural.** At 0.5% incident-to-CI linkage there is
  no service-mapped answer to give, and no uptime data exists to give one from. Both are
  recorded in the KPI inventory as NowOps problems, not chatbot problems.

Full survey: [`docs/2026-09-13-nowops-kpi-inventory.md`](../../2026-09-13-nowops-kpi-inventory.md).

The LLM gateway integration follows `nowstudio-reference.md`, distilled from the
NowStudio/Codon platform.

---

## 4. Architecture

```
Browser (static HTML + vanilla JS)
    │  POST /api/chat  { message, conversationId, model? }
    ▼
Express server (TypeScript, Node 22)
    ├── servicenow/    one OAuth client (token cache, timeout)
    │                  kb_knowledge search → ≤5 Articles
    │                  /stats/ aggregate   → MetricResult                [V2]
    ├── guard.ts       token-count guard (gate layer 1, pure)
    ├── llm/           Anthropic SDK → UST LiteLLM gateway (gate layer 2)
    └── server.ts      routes + in-memory conversation, process lifetime only
    ▲
    │  OAuth REST, per question
ServiceNow abhrademo4   kb_knowledge · /api/now/stats/*
```

Four modules with distinct responsibilities, each testable in isolation:

| Module | Responsibility | Depends on |
|---|---|---|
| `servicenow/` | One authenticated client (token cache, 10 s timeout); article search and aggregate execution built on it | env config |
| `guard.ts` | Tokenise, count meaningful terms, decline one-word noise | nothing (pure) |
| `llm/` | Gateway client, prompt assembly, reply parsing, citation verification | env config |
| `server.ts` | Routes, static files, conversation state, metric formatting | all three |

V2 adds no module. It adds one function to `servicenow/` (run an aggregate), one output
shape to `llm/`, and one branch in `server.ts`. Nothing is cached, nothing is curated and
nothing needs to stay in sync — D7 (no ingestion) is preserved by construction.

Search and stats share **one** ServiceNow client, so the process holds one OAuth token
cache and every request to the instance carries the same timeout. There is no build
step: the app runs under `tsx` and `tsc --noEmit` type-checks `src/`, `tools/` and
`tests/` together.

`Article` is the record type search returns. It is a plain data shape, not an abstraction
layer — there is no connector interface and no second implementation (D12).

No database and **no local index**. Conversation state lives in memory and dies with the
process. Postgres arrives with the standalone app, following the nowstudio-reference shape.

### Request flow

1. User sends a message.
2. **Token guard** (gate layer 1). Fewer than 2 meaningful words → decline immediately,
   before any network call.
3. Search abhrademo4 live, returning up to 5 candidate articles.
4. Claude is called **once**, given the question and the ≤5 articles labelled `[1]`–`[5]`.
   It replies with exactly one of:
   - **`ANSWER`** — prose grounded in the articles, citing `[n]` labels;
   - **`METRIC`** — `{ table, filter, aggregate, field? }`;
   - **`SEARCH`** — better keywords, because the articles are poor but the question is fair;
   - **`NO_ANSWER`** — nothing here answers it.
5. **`METRIC`:** check the aggregate is one of the five permitted, execute a read-only
   `GET` against `/api/now/stats/<table>`, format. → step 8.
6. **`SEARCH`:** search once more, union with the first set deduplicated by `sys_id`, and
   call Claude again with the combined articles. **One retry maximum, ever** — the second
   call may return `ANSWER` or `NO_ANSWER`, never another `SEARCH`.
7. **`ANSWER`:** cited labels are verified against those supplied; fabrications are
   stripped and logged.
8. Response returns `{ answer, kind, sources[], metric?, grounded, gateReason, retried }`;
   the UI renders the source line appropriate to `kind`.

Two properties are worth stating explicitly, because they are what make the metric path
safe:

- **The model supplies data, never a request.** It returns a table name, a filter string
  and an aggregate keyword. Our code builds the URL, and it can only ever build a
  read-only `GET` to `/api/now/stats/`.
- **The number and its filter are always shown together.** A number alone is
  unfalsifiable; a number beside `active=true^state=2` can be checked in one glance, and
  the deep link resolves the argument.

Steps 6–7 are the measured +15-point improvement (D13), unchanged from revision 5;
`RETRY_ENABLED=false` restores the pre-retry behaviour exactly. The article path's
regression check is `npm run eval` against the recorded revision 5 baseline (section 9).

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
| D11 | Relevance gate | **Two layers: token-count guard, then Claude** | *Reduced from three in rev 8.* Rev 1–7 had a coverage floor between them. It was justified when a decline cost zero model calls — but D13 removed that: once a weak result triages instead of declining, the floor no longer saves a call, it only chooses which prompt to send (spec's own words, previously in section 9: *"a decline now costs one Claude call instead of zero"*). Merging the two prompts into one call (D16) gives **identical call counts** while deleting a tuned threshold, a scoring function, a config knob, a decline reason and a branch. Also rejected, still: a single coverage threshold as the *only* gate — the distributions overlap, `"Hi Team,"` scores 1.00, which is why the token guard remains and runs first |
| D13 | Weak search results | **Triage with Claude, then retry the search once with better terms** | Accepting the first result set. Measured: of the 6 questions the baseline misses, **5 are recovered at rank 1** by rewriting the query — lifting recall@1 from 26/35 (74%) to roughly 31/35 (89%). Both worst failures (`"windows security pop up everytime i try to use outlook."` and `"new joiner starts on monday"` both returning *"What is the Windows key?"*) are vocabulary mismatches, which rewriting fixes and no scoring change can. Rejected alternatives: re-ranking the existing 5 results, capped at recall@5 = 83% because it cannot promote an article it was never given; and unconditional retry, which doubles cost on traffic that is mostly noise |
| D12 | Platform coupling | **Call ServiceNow directly. No connector interface** | *Reversed in rev 4.* Rev 3 introduced a `KnowledgeConnector` seam for future Jira support. Reversed on the owner's decision: this proof targets ServiceNow only, and the seam added an interface, a selector, a fake implementation and a contract test to a project whose whole point is to be small. Adding a second platform later means refactoring two files rather than adding one — an acceptable trade at this size. `Article` remains as a plain record type |
| D14 | How KPI questions are answered | **Claude composes a read-only aggregate query; the server executes it and always shows it** | *Reversed in rev 7.* Rev 6 forbade query composition and required selecting a stored `sys_report` definition. **Measured: 15 of 15 model-composed queries executed correctly on the first attempt** — including dotted-field traversal (`assignment_group.name=Network`), `javascript:` date functions, relative-date windows and AVG aggregates. Zero syntax errors, zero permission failures, every number defensible; `state=3` returned 1, matching the QBR On-Hold tile exactly. The rev 6 justification was the `Backlog Incidents Count` tile: 1,292 stored versus 5,377 generated. That gap is real but was misread — they are **two different questions**, and "5,377 open and in-progress" is not wrong, merely not NowOps' house definition. Rendering the filter beside the number makes the difference visible in one glance, which is the same safety property the catalogue offered at a fraction of the cost. Decisively, generation answers questions nobody anticipated: *"how many P1s are still unresolved after 30 days"* returned 6, and no catalogue would have held that entry |
| D15 | *withdrawn* | — | Specified the curated catalogue's construction, curation rules and staleness handling. Deleted in rev 7 along with the catalogue itself (D14). Retained as a numbered placeholder so D16 keeps its identity in earlier commits and discussion. The measurement that produced it stands and is worth keeping: Zing text search over `sys_report` scores **5 of 8**, failing *"how many open incidents are there"* — so had a catalogue been needed, selection rather than retrieval would have been the right way to build it |
| D16 | Routing between the paths | **One Claude call, one prompt, four possible replies: `ANSWER`, `METRIC`, `SEARCH`, `NO_ANSWER`** | *Widened in rev 8 to absorb triage.* Rejected: a separate classifier call (doubles latency and cost on every question, and a wrong route is unrecoverable downstream); keyword routing on "how many" (brittle both ways — *"what is our SLA adherence"* has no count word, *"how many steps to reset a password"* is an article question); and keeping triage as its own prompt behind a coverage threshold, which costs the same number of calls for more machinery (D11). Preserves D6: exactly one model call on the common path, two only when a rewrite is attempted |

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
│   ├── log.ts             one-line JSON logging, masks secrets
│   ├── guard.ts           tokenise + token-count guard  (~25 lines, pure)
│   ├── servicenow/
│   │   ├── types.ts       Article + ServiceNowUnavailableError
│   │   ├── client.ts      refresh-token grant, cached token, authenticated get() with timeout
│   │   ├── search.ts      live kb_knowledge text search
│   │   └── stats.ts       run one aggregate → value + deep link      [V2]
│   ├── llm/
│   │   └── client.ts      gateway client; one prompt; parse reply; citation checks
│   └── server.ts          Express, /api/chat, /api/health, boot
├── tools/
│   └── eval.ts            npm run eval — recall@k; --metrics for composed queries
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

Dependencies stay thin — **three** runtime: `express`, `@anthropic-ai/sdk`, `zod`; dev-only
`typescript`, `tsx`, `vitest`.

---

## 7. Configuration

```
# LLM gateway
ANTHROPIC_API_KEY        gateway key
ANTHROPIC_BASE_URL       https://llmproxy.<domain>
CLAUDE_MODEL             exact gateway model id

# ServiceNow
SN_INSTANCE_URL          https://abhrademo4.service-now.com
SN_CLIENT_ID
SN_CLIENT_SECRET
SN_REFRESH_TOKEN         exported from the existing connection via Export-SnEnvFile
(no knowledge base filter — see D5)

# Behaviour
RETRY_ENABLED            default true — set false to treat SEARCH as NO_ANSWER

# Optional
PORT                     default 3000
LLM_MODE                 live | stub — stub only while the gateway key is unavailable
```

`.env` is loaded by Node itself (`--env-file`), not by a library.

**Everything else is a constant in the file that uses it**, not configuration:
`MIN_TOKENS = 2` in `guard.ts`, `SEARCH_LIMIT = 5` in `search.ts`, `TIMEOUT_MS = 10_000` in
`servicenow/client.ts`. Nobody retunes these, and a knob nobody turns is a knob that has to be
documented, validated, tested and kept consistent. `RETRY_ENABLED` survives because the
plan has a real path where it gets set to false — if the measured retry gain does not hold,
that is the switch.

There is no `METRICS_ENABLED`. The article path is guarded by the deterministic eval and
its recorded baseline, not by a flag — a flag can drift from what it claims to reproduce.

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

## 8b. The metrics path

### What the model returns

Claude returns a small structured object, or declines:

```ts
{
  table: string       // 'incident', 'task_sla', 'sn_si_incident', ...
  filter: string      // a ServiceNow encoded query, e.g. 'active=true^priority=1'
  aggregate: 'count' | 'avg' | 'sum' | 'min' | 'max'
  field?: string      // required for everything except count
  label?: string      // display only — "open P1 incidents", so the UI can say "14 open P1 incidents"
}
```

This is the whole interface. There is no catalogue, no report lookup, no curation step,
and nothing to keep in sync (D14). `label` never touches the query; it is the noun
phrase that follows the number, and a missing label just means the number stands alone.

### Execution

```
count : GET /api/now/stats/<table>?sysparm_count=true&sysparm_query=<filter>
other : GET /api/now/stats/<table>?sysparm_<agg>_fields=<field>&sysparm_query=<filter>
```

Constraints, enforced in our code rather than requested of the model:

- **GET only, `/stats/` only.** The model supplies `table`, `filter`, `aggregate` and
  `field` as data; it never supplies a URL, a method or a path.
- **`aggregate` must be one of the five listed.** Anything else is a decline.
- **`table` must match `^[a-z0-9_]+$`.** It is the one model-supplied value that is
  interpolated into a URL *path*, so a value like `../oauth_token.do` must be refused
  before any request is built. This is a shape check on a trust boundary, not a list.
- A request timeout (shared with search), so a pathological filter cannot hang a chat turn.

There is deliberately **no table allowlist**. The OAuth user's ACLs already bound what is
readable, and an allowlist would block legitimate questions (*"how many users are
there?"* is a fair question with a correct answer) while providing no protection the
ACLs do not already give. The shape check above is not an allowlist: any real table
name passes it.

Malformed filters are **not** reliably rejected by ServiceNow. Measured 2026-09-14: the
filter `this is not a query!!` was silently ignored and `/stats/incident` returned the
whole table, 36,030, as confidently as any real answer. So the filter gets a shape check
before it leaves the process: every `^`-separated clause must start with a field name
followed immediately by an operator (`=`, `!=`, `<`, `>`, `IN`, `ISEMPTY`, `ON`, …). It is
a shape check, not a validator — a wrong field name still goes through and ServiceNow
answers it — but prose can no longer masquerade as a query. A filter containing
`GROUPBY` is also declined: `/stats/` ignores it and returns the total, which is a right
number for the wrong question (series are out of scope, section 2). Whatever ServiceNow
does reject, we catch and decline rather than attempt repair — a second guess at a
query is a second chance to be confidently wrong.

### Measured basis (2026-09-14, live)

Fifteen questions, queries written before any were run, ambiguous cases included
deliberately:

| Question | Result | Query |
|---|---|---|
| how many open incidents are there | 5,513 | `incident` · `active=true` |
| how many P1 incidents are open | 14 | `incident` · `active=true^priority=1` |
| how many incidents are unassigned | 4,184 | `incident` · `active=true^assigned_toISEMPTY` |
| Network group's open incidents | 866 | `incident` · `active=true^assignment_group.name=Network` |
| how many incidents breached their SLA | 23,429 | `task_sla` · `has_breached=true` |
| how many SLAs are at risk right now | 150 | `task_sla` · `active=true^has_breached=false^percentage>80` |
| how many security incidents are open | 246 | `sn_si_incident` · `active=true` |
| how many incidents are on hold | 1 | `incident` · `state=3` |
| P1s unresolved after 30 days | 6 | `incident` · `active=true^priority=1^opened_at<daysAgoStart(30)` |
| average resolution time for P2 | 00:43:22 | AVG `incident.calendar_duration` |

**15 of 15 executed. No syntax errors, no permission failures.** `state=3` returning 1
matches the QBR On-Hold tile exactly. Dotted-field traversal, `javascript:` date
functions and relative-date windows all worked unaided.

Two failure modes are accepted rather than engineered away, because both are visible in
the rendered filter and neither is worth a subsystem:

- **A plausible-but-wrong filter.** `state=7` for "closed" silently omits resolved
  incidents. The filter is on screen; the deep link settles it.
- **A meaningless aggregate.** `AVG(task_sla.percentage)` returned **326,252** — SLA
  percentages exceed 100 without bound on breached records, so the mean is garbage. It is
  obvious garbage, and the field name is displayed. Likewise `AVG(incident.short_description)`
  returns 35,245,419 (measured): ServiceNow averages a text field without complaint.
  Rejecting this properly needs a `sys_dictionary` type lookup per field, which is a
  subsystem; the rendered `avg(short_description)` is the guard for now.

### Presentation

Every metric answer shows the number **and the query that produced it**. A number alone
is unfalsifiable:

> **5,377 open and in-progress incidents**
>
> *Source:* `incident` · count · `active=true^state=2` · [open in abhrademo4 →]

The sentence is the number formatted with thousands separators followed by the model's
`label`. Metric turns are also written to the conversation history, with the filter, so
*"and how many of those are P1?"* has something to build on.

The deep link is `/<table>_list.do?sysparm_query=<filter>`, resolving to the same records
the number counted, so a disagreement is settled by clicking rather than by argument.

**The filter is rendered, not hidden behind a tooltip.** It is long and it is ugly; it is
also the only thing that makes the number checkable, and concealing it would defeat the
purpose of D14. Wrap it, do not truncate it.

### Where this will disagree with the dashboard

It will, and that is understood rather than prevented. The `Backlog Incidents Count` tile
reads 1,292 because its stored definition is
`active=true^u_past_incidentsISNOTEMPTY^stateIN2^assigned_toISNOTEMPTY^priorityNOT IN1,5`
— a UST custom field, an assignee requirement and an exclusion of P1 and P5. A composed
query for "the backlog" returns 5,377.

Neither number is wrong; they answer different questions. The rendered filter is what
turns a silent contradiction into a visible one, and a user who needs the house figure
can see immediately that they are not looking at it.

If this becomes a real complaint in use, the fix is to look the definition up in
`sys_report` for the handful of KPIs that have house definitions — and by then there will
be a concrete failing example to build against, rather than the speculation that produced
revision 6. Several stored definitions are themselves wrong (`Tickets Approaching SLA
Breach` never touches `task_sla`; the four MTTR reports use four different time windows),
so deferring is not obviously the worse trade.

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

Threshold sweep — retained as the evidence that **no cutoff works**, which is why rev 8
removed the coverage floor rather than retuning it:

| Cutoff | Keeps good answers | Rejects noise |
|---|---|---|
| 0.3 | 31/35 | 7/10 |
| 0.5 | 26/35 | 8/10 |
| 0.7 | 20/35 | 9/10 |

At 0.7 a third of correct answers are discarded to reject 90% of noise. The degenerate
case shows why: `"Hi Team,"` scores **1.00**, because after stopword removal only "team"
remains and it appears in the article. Short queries saturate the metric.

### The two-layer gate (D11)

1. **Token-count guard** — fewer than `MIN_TOKENS` (2) words of three or more characters
   → decline immediately, without searching and without a model call. Eliminates
   `"Hi Team,"` and `"nan"` for free. (`"Bky OLO"` is two tokens, exactly at the floor,
   and falls through to layer 2.) **There is no stopword list.** Rev 10 removed it after
   a scenario run showed it declining *"how many incidents"*, *"how many users do we
   have"* and *"what is our uptime"* for free — every word but one was a stopword. The
   guard exists for one-word noise; judging three real words is the model's job.
2. **Claude** — everything else goes to the model, which returns `ANSWER`, `METRIC`,
   `SEARCH` or `NO_ANSWER` (D16).

**Why the coverage floor was removed in rev 8.** It sat between these two and declined
anything scoring below 0.3. That earned its place when a decline cost zero model calls.
D13 ended that: a weak result now triages rather than declining, so the floor stopped
saving calls and merely selected which prompt to send. Merging the prompts costs the same
and deletes a threshold, a scoring function, a config knob, a decline reason and a branch.

The coverage measurements that justified it remain true and remain the reason the token
guard runs first: the in-scope and out-of-scope distributions overlap badly, and
`"Hi Team,"` scores 1.00 because one term survives stopword removal and appears in the
article. No single coverage cutoff was ever going to work.

### Query rewriting and retry (D13)

When the articles are poor but the question is fair, Claude replies `SEARCH` with better
keywords instead of `NO_ANSWER`, and we try once more.

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

- **One retry maximum.** The second call may return `ANSWER` or `NO_ANSWER`, never another
  `SEARCH`. No loops.
- **Results are unioned**, deduplicated by `sys_id`, so a good article found by the first
  search is never lost by the second.
- `RETRY_ENABLED=false` makes `SEARCH` behave as `NO_ANSWER`, restoring pre-D13 behaviour
  for A/B comparison.

**The cost, stated plainly.** Distinguishing "badly worded" from "genuinely absent" is a
judgement, not a score — `"windows security pop up… outlook"` is rescuable and `"what is
the capital of France"` is not, and no coverage number separates them. So the model makes
that call, which means **a decline costs one Claude call rather than zero**, and a rescued
answer costs two. Latency for a rescued answer roughly doubles, to ~5s. The token guard is
what keeps the cheapest noise — `"Hi Team,"`, `"nan"` — free.

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
| `POST /api/chat` | `{ message, conversationId, model? }` → `{ answer, kind, sources[], metric?, grounded, gateReason? }` |
| `GET /api/health` | Gateway reachability, model id in use, ServiceNow search reachability |

`kind` is `'article' \| 'metric' \| 'decline'` and tells the UI which source line to draw.

`sources[]` entries: `{ id, label, title, url }` — `id` is the sys_id, `label` the display
KB number.

`metric` is present only when `kind === 'metric'`, and `answer` is then the sentence
*"5,513 open incidents"*:

```ts
{
  table: string         // e.g. 'incident'
  filter: string        // the executed filter, verbatim — rendered to the user
  aggregate: string     // count | avg | sum | min | max
  field?: string        // present for everything except count
  label?: string        // the noun phrase after the number, if the model gave one
  value: number | string // string for durations, e.g. '00:43:22'
  url: string           // deep link to the same filter as a record list
}
```

`gateReason` explains a decline (`too_few_tokens`, `model_declined`,
`servicenow_unavailable`, `metric_unavailable`) and `retried: boolean`
records whether D13 fired, so the UI and logs can distinguish them.

There is no `/api/sync` — nothing is cached to sync (D7).

---

## 12. Frontend

One static page served by Express — no bundler, no build step. Chosen partly because
ServiceNow Service Portal widgets are HTML/JS, so this markup ports across with little
rework when the chatbot moves onto the NowOps dashboard page.

The **source line under each answer is a first-class requirement**, with three states:

| State | Rendering |
|---|---|
| Grounded (article) | `Sources: KB0010096 · KB0010112`, each linked by **sys_id**: `.../kb_view.do?sys_kb_id=<sys_id>` |
| Grounded (metric) | `Source: incident · count · open in abhrademo4 →`, with `<filter>` rendered in full beneath it |
| Declined | `No knowledge base match — not answered` |
| Citations stripped | Verified citations only, plus a server-side warning log |

Links resolve by `sys_id`, never by article number — `kb_view.do?sysparm_article=KB0010141`
is ambiguous on this instance and can open the wrong article (D10).

The metric deep link is `/<table>_list.do?sysparm_query=<filter>`, so it opens the exact
record set the number counted. **The filter is rendered in the source line, not hidden
behind a tooltip.** It is long and it is ugly; it is also the only thing that makes the
number checkable, and hiding it would defeat the purpose of D14. Wrap it, do not truncate
it.

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
| Search returns zero results | Claude is called with an empty context block and replies `NO_ANSWER` → `gateReason: model_declined` |
| Triage call fails (D13) | Fall back to declining on the first result set. A retry failure must never surface as an error — the user gets the ordinary "not in the knowledge base" |
| Triage returns an unusable rewrite (empty, or the original query unchanged) | Skip the second search and decline. No loop |
| Oversized or abusive input | Message length cap, rejected before reaching search or the gateway |
| Model returns an aggregate outside the five permitted | Decline, and log what it asked for. Same discipline as stripping fabricated `[n]` citations (D10) |
| Model returns a filter that is not an encoded query (prose, spaces around `=`) | Refused by the shape check before any request; decline with `metric_unavailable`. ServiceNow would have ignored it and returned the whole table |
| Model returns a filter with `GROUPBY` | Declined at parse time. `/stats/` ignores it and would return a total for a breakdown question |
| Model returns a filter ServiceNow does reject | Decline with `metric_unavailable`. **No repair attempt** — a second guess at a query is a second chance to be confidently wrong |
| Model wraps its reply in a code fence, adds a preamble, writes `METRIC:` or `COUNT` | Parsed as intended. These are formatting variations, not different intents; the verb line is found wherever it is, fences are stripped, the first JSON object is taken, aggregate case is normalised |
| Request body is not JSON | HTTP 400, not 500 |
| Model names a table that is not a plain identifier (`../x`, `incident?y=1`) | Refused before any request is built; decline with `metric_unavailable` and log what it asked for |
| Model names a table that does not exist or is not readable | ServiceNow returns an error; same decline. The OAuth user's ACLs are the access boundary |
| Article search exceeds the 10 s timeout | Abort; the turn returns "I can't reach the knowledge base right now" (same client, same timeout as aggregates) |
| Aggregate returns a non-numeric or empty body | Decline. Never render a partial or guessed number |
| Aggregate exceeds `TIMEOUT_MS` (10 s, `servicenow/client.ts`) | Abort and decline, so one pathological filter cannot hang a chat turn |

With live search (D2) the availability of abhrademo4 is now on the **request** path rather
than the startup path. That is the main cost of this design, and the row above is how it is
contained.

---

## 14. Observability

Every chat request logs: the query, **the rewritten query when D13 fires**, the candidate
article numbers returned by each search, the cited labels, the gate decision and reason,
whether a retry fired, and latency.

Metric turns additionally log: **the table, filter, aggregate and field as composed**,
and the value returned. The filter is logged verbatim for the same reason it is shown to
the user — a number in a log that cannot be reproduced is not evidence of anything. This
log is also the raw material for judging, after real use, whether composed queries drift
from house definitions often enough to matter (section 8b).

This single log line distinguishes a search failure from a gate failure from a model
failure from a wrong metric selection, without guesswork. Secrets never appear in logs
(section 7).

---

## 15. Testing

Test-first. The design concentrates the interesting logic in pure functions needing no
network.

| Layer | Covers |
|---|---|
| Unit | Tokeniser, token guard, config parsing, secret masking, OAuth token caching, reply parsing (all four forms), citation verification, aggregate URL construction, aggregate and table-name checks, value coercion, deep-link building |
| Retrieval eval | `npm run eval` — the 45-question set, search only, **deterministic** |
| Retry eval | `npm run eval -- --with-retry` — same set through the full D13 path, using Claude |
| **Metric eval** | `npm run eval -- --metrics` — question set measuring *query correctness*: did the composed query execute, and did it match the expected filter? |
| Integration | Routes against stubbed search and a stubbed gateway, so CI needs no live credentials |
| Live smoke | Manual: `/api/health` plus a handful of real questions |

**Two eval modes, deliberately.** Retry makes the system nondeterministic, and a regression
guard that wobbles run to run is worse than none. So the default mode measures raw search —
deterministic, free, and the thing that fails the build if it drops below 26/35 recall@1.
`--with-retry` measures the end-to-end improvement (expected ~31/35), costs Claude calls, and
is reported rather than enforced.

**The metric eval measures the query, not the number.** Asserting on values would fail
every time a ticket is raised. Three assertions instead, all stable:

1. **It executes.** No syntax error, no permission error. This was 15/15 by hand and is
   the floor a regression must not drop below.
2. **The filter is semantically right.** Compare against an expected filter, normalising
   clause order — `active=true^priority=1` and `priority=1^active=true` are the same query.
3. **`state`-style codes are correct.** The sharpest known failure mode: "closed" as
   `state=7` silently omits `state=6` resolved. Worth its own cases.

The question set must include questions that **should be declined** — *"what is our
uptime"* (no such data exists in the instance), *"how many incidents will we get next
month"* (not a query) — because a model that can always compose *something* will.

---

## 16. Acceptance criteria

1. `npm run dev` boots; gateway preflight passes; the ServiceNow probe search succeeds.
2. `/api/health` shows gateway reachable, model id, and ServiceNow search reachable.
3. Five known questions return correct answers with correct citations, and every link opens
   the right article in abhrademo4.
4. `"Hi Team,"` is declined **without calling the model at all** (`too_few_tokens`).
   `"what is the capital of France"` returns `NO_ANSWER` on the first call and is declined
   **without a second search**.
5. `"new joiner starts on monday"` — a baseline miss — returns `SEARCH`, then is
   **answered correctly on the second call**, with `retried: true` and the rewritten query
   visible in the logs.
6. A second `SEARCH` is never honoured, and a failed second call degrades to an ordinary
   decline rather than an error.
7. Stopping network access to abhrademo4 produces "can't reach the knowledge base", not
   "no match".
8. No secrets appear in any log line.
9. `npm run eval` matches or beats the section 9 baseline (74% recall@1, 83% @5).
10. `npm run eval -- --with-retry` reports materially better recall@1 than the deterministic
    run. If it does not, D13 is not earning its cost and should be reconsidered.

V2 adds:

11. *"How many open incidents are there?"* returns **"5,513 open incidents"** (the number
    will have drifted), the filter `active=true`, and a working deep link. Clicking it opens a record list whose count equals the number
    shown. **This is the acceptance test for the whole metrics path** — the question an SDM
    asks first.
12. *"How many P1 incidents are open?"* returns 14, and *"how many incidents are on hold?"*
    returns 1 — the latter matching the QBR On-Hold tile, which is the cheapest available
    check that composed queries agree with NowOps where no house definition intervenes.
13. *"What is our uptime?"* is declined. The data does not exist in the instance, and it
    must not be answered from an approximate metric that does.
14. *"How do I reset my SAP password?"* still routes to the article path with
    `kind: 'article'`. Adding metrics must not cannibalise article answering — run the full
    45-question eval and confirm recall matches the revision 5 baseline.
15. A metric reply naming a table such as `../oauth_token.do` (forced in a test) is declined
    before any request leaves the process.
16. A deliberately malformed filter (forced in a test) produces a decline, never a repair
    attempt and never a partial number.
17. `npm run eval -- --metrics` reports execution rate and filter accuracy, and declines
    every question that should be declined.

---

## 17. Required inputs before implementation

| Input | Status |
|---|---|
| Eval question list | **Done** — `tests/fixtures/retrieval-eval.json` |
| Identity of the ~123 articles in unresolved knowledge bases | **Done** — see section 3 |
| ServiceNow OAuth client id, secret, refresh token | **Done** — written to `.env` by `Export-SnEnvFile` |
| Gateway API key, base URL, model ids | **Outstanding** — held by the project owner |
| ~~Allowlisted knowledge base sys_ids~~ | **Not needed** — measured as ineffective and removed (D5) |
| ~~Metric catalogue~~ | **Not needed** — measured as unnecessary and removed (D14). 15 of 15 composed queries executed correctly |
| **Metric eval question set** | **Built during implementation**, same pattern as the retrieval eval. The 15 measured questions in section 8b are its starting point |

Nothing in V2 is blocked on anything the owner does not already have. The gateway key
remains the only outstanding external dependency, and `LLM_MODE=stub` continues to unblock
every task that does not need a live model.

---

## 18. Later increments

In rough order of likely value:

1. **Improve recall past 74%@1** — the measured ceiling. Query preprocessing, synonym
   handling, or ServiceNow AI Search if it can be activated on the instance.
2. **Series and trend metrics.** 383 of 963 reports carry `GROUPBY`/`TRENDBY`. Answering
   *"open incidents by priority"* with a breakdown rather than a total needs a formatter
   and a UI decision (table? sparkline?), which is why V2 answers scalars only.
3. **House-definition lookup** — for the handful of KPIs where NowOps has an official
   filter (backlog, SLA adherence), read it from `sys_report` instead of composing one.
   Deferred until real use shows the disagreement matters; by then there will be a
   concrete example rather than speculation.
4. Streaming responses.
5. Articles describing NowOps and MemorialCare — neither exists in the knowledge base
   today, so *"what is NowOps?"* currently cannot be answered. Likely the first question
   anyone asks a NowOps chatbot.
6. Tool-use retrieval (D6) once multi-part follow-ups demand it.
7. Postgres-backed conversation persistence, per the nowstudio-reference shape.
8. Auth/SSO, following the UST posture: SSO with a single break-glass local account.
9. Embedding into the NowOps dashboard page.
10. Web search fallback — gated on a spike confirming the gateway forwards Anthropic
    server-side tools.
11. Absorption into the NowOps standalone application (separate spec).


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
