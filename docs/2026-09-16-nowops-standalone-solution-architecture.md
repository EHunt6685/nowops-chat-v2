# NowOps Standalone — Solution Architecture Document

## Document Control

| Attribute | Value |
|---|---|
| Document Title | NowOps Standalone — Solution Architecture |
| Version | 0.1 |
| Status | Draft for AI & Architecture Group Review |
| Owner | UST NowOps team |
| Scope | NowOps standalone application (dashboards, KPI engine, platform connectors) and the embedded NowOps Assistant chatbot |
| Related | NowOps Chatbot V2 design spec (rev 10); NowOps KPI inventory (2026-09-13); NowOps KPI data pull (2026-09-14) |

Sections marked **Decision pending** record questions the architecture group must settle before build. The design shown is the recommended default under stated assumptions.

---

## 1. Executive Summary

NowOps Standalone is UST's Application Management and IT Operations framework re-platformed as an independent web application. Today NowOps exists as dashboards, catalog items and scoped applications inside a customer's ServiceNow instance. The standalone application separates NowOps from any one ticketing platform: a customer connects their own ServiceNow or Jira instance, and NowOps renders its standard operational, engagement and backlog dashboards from that customer's live data.

An embedded conversational assistant answers two kinds of question against the connected instance: procedural questions grounded in the customer's knowledge base, and operational questions ("how many open P1 incidents are there") answered with a live number, the exact query that produced it, and a link to the underlying records.

The architecture rests on four commitments established and measured in the chatbot proof-of-concept (September 2026):

1. **NowOps owns every KPI definition.** Each KPI has an owner, a written meaning and one query per platform. Definitions are data, not code, and are shown beside every number.
2. **The model supplies data, never requests.** The language model composes queries as structured data; NowOps code validates and executes them read-only. Nothing the model emits is ever executed as a URL, path or method.
3. **Every number is checkable.** A metric is always rendered with its filter and a deep link to the records it counted. A number without its definition is treated as unfalsifiable and is not shown.
4. **Platform knowledge lives in connectors and configuration.** No NowOps component above the connector layer knows a platform's API, query language or field names.

---

## 2. Core System & Deployment Architecture

### 2.1 Components

| Component | Responsibility | Depends on |
|---|---|---|
| **Web application** | Dashboards (Application 360, SDM QBR, Backlog Beacon), dashboard-level filters, the chat panel, SSO login, tenant/role scoping | API layer |
| **API layer** (Node/TypeScript, Express) | Authentication, tenant resolution, request routing, response assembly | KPI engine, chatbot service, tenancy |
| **KPI engine** | Catalogue of KPI definitions; executes definitions through connectors; short-lived result cache; daily snapshots for trends | Connectors, Postgres |
| **Chatbot service** | Guard, knowledge retrieval, single model call, reply parsing, query validation, citation verification | Connectors, KPI engine, LLM gateway |
| **Connectors** | One per platform. Authenticate, search knowledge, run a metric, describe schema, build deep links, report health | Secrets store, customer instance |
| **Tenancy & connections** | Tenants, their connections (one instance of one platform each), discovered schema summaries, per-tenant KPI overrides | Postgres, secrets store |
| **Platform services** | Postgres, secrets store, scheduler (snapshots, health checks), structured logging, audit log | Cloud infrastructure |

### 2.2 Deployment model

- **Hosted by UST, one codebase.** Containerised Node/TypeScript services on AWS, following the NowStudio/Codon platform conventions (Express, Postgres, standard Anthropic SDK against the UST LLM gateway).
- **Customer instances are never modified.** All traffic to a customer's ServiceNow or Jira is outbound, read-only HTTPS over that customer's own OAuth or API credentials. No NowOps code is installed in the customer instance.
- **LLM access via the UST LLM gateway** (LiteLLM proxy). Model identifiers are explicit configuration; a startup preflight call fails the deployment if the configured model does not answer, because the gateway renames models and a wrong name otherwise fails silently.

**Decision pending — tenancy model.** The default shown is multi-tenant: one deployment serving many customers, with strict per-tenant scoping of connections, data and secrets. The alternative, one deployment per customer, removes an entire class of isolation risk at the cost of operating many instances. This choice shapes the tenancy layer and the secrets design and must be settled first.

### 2.3 Trust zones

```
┌───────────────────────────── UST hosted ─────────────────────────────┐
│  Web app  ──►  API layer  ──►  KPI engine ──►  Connectors  ──HTTPS──┼──► Customer instance
│                   │              │                 │                  │    (ServiceNow / Jira)
│                   │              ▼                 │                  │
│                   │          Postgres          Secrets store         │
│                   ▼                                                   │
│             Chatbot service ──HTTPS──► UST LLM gateway ──► Claude    │
└──────────────────────────────────────────────────────────────────────┘
```

Three boundaries: the customer instance (governed by the customer's credentials and ACLs), UST's hosted environment (governed by SSO, tenancy and the audit log), and the LLM gateway (governed by UST's model agreements). Customer data crosses into the model boundary only as the text of a question, the retrieved article excerpts, and aggregate numbers; never as raw record exports.

---

## 3. Connector Layer

A connector is the only code that knows a platform. Each implements one small interface:

| Capability | ServiceNow (built) | Jira (planned) |
|---|---|---|
| Authenticate | OAuth refresh-token grant, cached access token, shared across all calls | API token or OAuth 2.0 (3LO) |
| Search knowledge | Table API full-text search over `kb_knowledge`, top 5 | Confluence CQL search over the customer's knowledge spaces |
| Run metric | `/api/now/stats/` count, avg, sum, min, max with an encoded query | JQL `search` for counts (`total`); averages computed server-side over paged issues |
| Describe schema | `sys_dictionary` and choice lists per table | Jira field, status and issue-type APIs per project |
| Deep link | `<table>_list.do?sysparm_query=…`, `kb_view.do?sys_kb_id=…` | JQL issue search URL, Confluence page URL |
| Health | One cheap search | One cheap search |

Two properties of the built ServiceNow connector generalise and are required of every connector:

- **A single client owns authentication, timeouts and error mapping.** Search and metrics share one token cache and one request timeout. "Instance unreachable" is a distinct error type from "no results" and produces a distinct user-facing message.
- **Guardrails execute inside the connector, before any request leaves.** The aggregate must be one of the permitted set; the entity name must be a plain identifier (it is interpolated into a path); the filter must have the shape of the platform's query language; every field the filter names must exist on the entity (verified by a one-record probe, because ServiceNow silently ignores unknown fields and returns the whole table — measured); grouping constructs the aggregate endpoint cannot serve are refused. Nothing is repaired; a failing check is a decline.

**Extract, do not predict.** The connector interface will be fixed only after the Jira connector exists as a working implementation alongside ServiceNow. An abstraction drawn from two real implementations is reliable; one drawn from one implementation and a guess is not. The ServiceNow proof deliberately omitted the seam for this reason.

**Decision pending — second and third platforms.** Jira with Confluence as its knowledge base is assumed. If a third platform (for example Freshservice or BMC) is in scope for the first year, a neutral intermediate query form translated per connector becomes worth the cost; with two platforms, model-composed native queries with per-connector validation are simpler and are what the proof measured.

---

## 4. KPI Engine and Definition Ownership

The KPI inventory established that on a live instance access is not the constraint; definition is. "Open" meant three different things across three tiles of the same dashboard, and several stored report definitions were wrong (relationship counts labelled as CI counts, an SLA tile reading zero because of a text-match clause, a "TCO" that counts applications with no cost). NowOps Standalone therefore owns definitions rather than reading them from the customer's reporting tables.

### 4.1 Definition catalogue

Each KPI definition carries: identifier, display name, owner, plain-language meaning, one query per supported platform, aggregate and field, permitted dashboard filters, and a version. Definitions are stored in Postgres and are data, editable without a deployment.

Three tiers:

1. **Standard core** — KPIs universal to ticketing platforms: volume, open, closed, cancelled, on hold, aging buckets, backlog, opening versus closure rate, mean time to resolve, SLA adherence and breach counts where the platform has SLAs. Defined once by UST; approximately fifteen to twenty definitions.
2. **Per-tenant mapping** — how a customer's entities and statuses map onto NowOps concepts (which Jira projects and issue types are "incidents"; which ServiceNow states count as "open"). Configuration captured at onboarding.
3. **Per-tenant overrides and extensions** — a customer's house definition of a standard KPI, shown beside the standard rather than replacing it silently; and customer-specific KPIs expressed as a query in their platform's language, with an owner and description.

**Decision pending — override policy.** Whether customers may override standard definitions, and whether overrides are visible to UST portfolio views, is a product decision with support-cost implications.

### 4.2 Execution and snapshots

The engine executes a definition through the tenant's connector, caches the result briefly (seconds to minutes; live values drift continuously and dashboards tolerate this), and records a daily snapshot of every definition per tenant. Snapshots are the only source of trends: opening versus closure, backlog management index, monthly SLA adherence and aging trends cannot be reconstructed from a live instance that keeps no history.

**Decision pending — historical backfill.** A newly onboarded customer expecting twelve months of trend on day one requires backfilling from the instance's own timestamps, a heavier and platform-specific job distinct from daily snapshots going forward.

### 4.3 Data not available from ticketing platforms

Uptime, latency, synthetic checks, SLO breaches and CI health telemetry do not exist in ServiceNow or Jira. They enter NowOps only through an observability connector (Dynatrace, Datadog, AppDynamics), which is a further connector type with the same interface and is out of scope for the first release unless the architecture group decides otherwise.

---

## 5. NowOps Assistant (Chatbot)

The assistant is the chatbot proven against abhrademo4 in September 2026, with four substitutions for the standalone context.

### 5.1 Request flow

1. **Tenant resolution.** The session identifies the tenant; every subsequent step is scoped to that tenant's connections.
2. **Token guard.** Fewer than two words of three or more characters is declined before any network or model call. This is a cost gate for one-word noise; judgement is left to the model.
3. **Knowledge retrieval.** The tenant's knowledge connector returns up to five candidate articles, labelled [1]–[5].
4. **KPI catalogue match.** If the question corresponds to a catalogued NowOps definition, that definition is used and the answer says so. Composition is the fallback for questions nobody catalogued.
5. **One model call.** The model receives the rules, the tenant's discovered schema summary, the recent conversation, the labelled articles and the question, and must reply in exactly one of four forms: **ANSWER** (prose citing labels), **METRIC** (entity, filter, aggregate, field, display label — as data), **SEARCH** (better keywords), or **NO_ANSWER**.
6. **Execution with guardrails.** METRIC passes through the connector's checks (section 3) and runs read-only. SEARCH triggers one further retrieval and one further model call; a second SEARCH is never honoured. ANSWER has its citations intersected with the articles actually supplied; anything else is stripped and logged.
7. **Response.** Article answers carry linked sources keyed by record identity (sys_id, page ID), never by display number. Metric answers carry the value, the display label, the entity, the aggregate, the full filter rendered without truncation, and a deep link to the records counted. Declines state the reason.

### 5.2 What changes from the proof

| Proof (ServiceNow only) | Standalone |
|---|---|
| ServiceNow knowledge hardcoded in the prompt | Schema summary discovered from the tenant's instance and injected per tenant |
| Composition only | Catalogue match first, composition as fallback |
| One connector, called directly | Tenant's connector resolved at request time |
| Conversation state in process memory | Conversation state in Postgres per tenant |

### 5.3 Tool use as the planned evolution

The proof uses one speculative knowledge search followed by one model call, chosen so every failure was attributable during measurement. The standalone assistant is expected to move to model-driven tool use (the model chooses `search_knowledge` or `run_metric`; the server executes with the same guardrails; the model may chain within a turn). This removes the wasted search on counting questions and supports compound questions, at the cost of two to four model calls per turn and nondeterministic call counts. The move is gated on two measurements: a spike confirming client-side tool use passes through the UST LLM gateway, and the metric evaluation showing whether irrelevant articles distract the model from composing queries.

---

## 6. Identity, Credentials and Connection Mapping

### 6.1 User identity

Users authenticate to NowOps via UST SSO, with a single break-glass local account per deployment. Roles are per tenant: a service delivery manager sees their customer; a UST portfolio lead may see several.

**Decision pending — customer users.** Whether customer staff log in directly (requiring federation with customer identity providers) or only UST staff use the application.

### 6.2 Connection credentials

NowOps does not act as the user against the customer instance. Each connection holds a service credential issued by the customer — a ServiceNow OAuth client with a refresh token, or a Jira API token — whose access controls bound what NowOps can read. Credentials are stored in the secrets store, referenced from Postgres by identifier only, and never logged; the proof's masking rule (`sk-ab…mnop`) applies to every secret in every log line.

The Converse pattern of on-demand, point-of-interaction credential linking is not required in the first release because all access is read-only through a per-tenant service credential. It becomes relevant if NowOps ever performs writes on behalf of a named user (section 9).

### 6.3 Onboarding a connection

1. Customer creates the service credential in their instance and supplies it through a secure form that never echoes it.
2. NowOps performs a health probe and a schema discovery, storing the schema summary.
3. Standard KPI definitions are validated against the discovered schema; any that reference a missing field are flagged for mapping before the dashboard is enabled.
4. The tenant mapping (section 4.1, tier 2) is completed and the first snapshot is taken.

---

## 7. Observability Strategy

### 7.1 The three pillars

**Metrics** follow the RED pattern per tenant and per connector: request rate; error rate split by cause (instance unreachable, instance rejected, model declined, guardrail refused, fabricated citation stripped); and duration for the end-to-end turn, the connector call and the model call separately.

**Logs** are one JSON object per line, as in the proof. Every chat turn logs the question, the rewritten query when a retry fired, the candidate record identifiers returned, the reply kind, the cited identifiers, and latency. Every metric turn additionally logs the entity, filter, aggregate, field and value exactly as executed — a number in a log that cannot be reproduced is not evidence of anything. A correlation identifier is assigned at the API layer and propagated through connector and model calls.

**Traces** use OpenTelemetry spans for the turn, the retrieval, the model call and each connector call, so a slow turn can be attributed to the instance, the gateway or NowOps itself.

### 7.2 Audit log

Every query executed against a customer instance is recorded with tenant, connection, user, timestamp, the exact request and the result size. This is the customer-facing account of what NowOps read and when, and is separate from operational logs.

### 7.3 Security observability

Guardrail refusals are first-class events: an aggregate outside the permitted set, an entity name that is not a plain identifier, a filter that is not a query, an unknown field, a fabricated citation. Rates of these per tenant and per model version are the earliest signal of prompt injection attempts, model drift, or a schema change on the customer's instance.

### 7.4 Quality measurement

The proof's evaluation harness is retained and generalised. Each tenant has a retrieval evaluation set (real user questions with acceptable answer identifiers) run in a deterministic search-only mode as a regression gate, and a metric evaluation set measuring whether composed queries execute and hit the intended entity. Recall is a property of a specific search engine over specific content; every new platform and every new tenant needs its own baseline before quality claims are made.

---

## 8. Data Privacy & PII Standards

- **Minimal data to the model.** The model receives the question, up to five article excerpts, a schema summary (field names, not values), recent conversation turns, and aggregate numbers. It never receives record exports, user lists or ticket bodies beyond what the retrieval returns as knowledge content.
- **Gateway-level masking.** PII detection and redaction on the outbound path to the LLM gateway, aligned with the Converse gateway pattern, applied to the question and retrieved excerpts.
- **Read-only by construction.** Connectors expose no write capability; the model cannot request one.
- **Encryption.** TLS 1.3 in transit; AES-256 at rest for Postgres and the secrets store.
- **Sanitised logging.** Secrets are masked; article bodies and user free text are not logged in full; the audit log records queries, not result rows.
- **Regulated data.** Where a connected instance holds patient or other regulated records, the tenant mapping excludes those entities from both dashboards and the assistant, and the retrieval connector is restricted to non-clinical knowledge bases. Organisational policy forbids requesting, storing, processing or displaying such identifiers, and the architecture enforces this at the connector configuration rather than relying on the model.

---

## 9. Human-in-the-Loop & Quality Controls

- **Grounded synthesis.** Knowledge answers are restricted to retrieved articles; if the articles do not contain the answer and better keywords will not help, the assistant declines rather than answering from general knowledge.
- **Citation protocol.** The model cites small bracketed labels drawn from the five articles it was shown, never record numbers. Labels are mapped back to record identities server-side and verified before rendering; fabricated labels are stripped and logged.
- **Number protocol.** Every metric answer renders its filter in full and links to the records counted. Where a customer's house definition differs from the NowOps standard, both are visible.
- **Decline over guess.** Malformed model output is declined, not repaired. A filter the instance rejects is declined, not retried with a variation. A false negative can be asked again; a confident wrong number cannot be recalled.
- **Confirm-before-commit, reserved.** The first release is read-only, so no action cards are needed. If NowOps later performs writes (assignment, work notes, ticket creation), the Converse action-card pattern applies: read-only operations auto-execute; write or destructive actions render a confirmation requiring user validation, executed under a credential attributable to that user, and recorded in the audit log.

**Decision pending — read-only forever, or writes later.** This single decision determines whether sections 6.2 and 9 need the per-user credential linking and action-card machinery. The recommendation is to commit to read-only for the first release and design the audit log so that writes can be added without restructuring it.

---

## 10. Open Decisions Summary

| # | Decision | Affects |
|---|---|---|
| 1 | Multi-tenant SaaS versus per-customer deployment | Tenancy layer, secrets isolation, operations |
| 2 | Read-only forever versus writes in a later release | Credential model, action cards, audit design |
| 3 | Confirmed second platform (Jira + Confluence) and any third | Connector seam timing, neutral query form |
| 4 | Historical trend expectations at onboarding | Backfill versus snapshot-forward |
| 5 | Standard definitions only versus per-tenant overrides | KPI catalogue tiers, support burden |
| 6 | Location of the AI Next Best Action capability | Whether it moves from the ServiceNow scoped app into NowOps |
| 7 | Observability sources in first release | Third connector type |
| 8 | Hosting confirmation and identity provider; customer user access | Deployment, SSO federation |
| 9 | Expected customer and user counts in year one | Caching and snapshot scheduling |
