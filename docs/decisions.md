# NowOps Standalone — Decision Log

Running record of product and architecture decisions for the NowOps standalone application. One entry per decision. Entries are appended, not rewritten; a reversed decision gets a new entry that names the one it supersedes. Updated only when the owner asks.

Each entry: what was decided, why, what follows from it, and what would make us revisit it.

---

## D-001 · ServiceNow is the only platform for now; Jira is deferred

**Date:** 2026-09-16 · **Status:** Active

**Decision.** The standalone NowOps product is built against ServiceNow only. Jira (and any other platform) stays in the pipeline for a much later phase and is not designed for now.

**Why.** Every piece of complexity discussed in the platform-agnostic designs existed only to make two platforms look alike: a canonical ticket schema, a sync database, a connector interface, a core-versus-pack dashboard split, a neutral query language. With one platform none of it is needed. ServiceNow's aggregate endpoint answers every dashboard tile live; the KPI data pull (2026-09-14) computed all of them in minutes.

**Consequences.** No sync database, no canonical schema, no connector abstraction, no packs. ServiceNow code stays plain ServiceNow code. UST holds no copy of client ticket data, only aggregates, definitions, conversations and audit logs.

**Kept cheap for later.** Three habits, costing nothing now: (1) every line that knows ServiceNow lives in the `servicenow/` folder or the definitions table; (2) the definitions table has a `platform` column even though every row says `servicenow`; (3) the audit log and API response shapes stay platform-neutral (entity, filter, aggregate, value, link). When a second platform is actually signed, build it deliberately similar in shape, then extract the seam from two working implementations. Do not build the seam from one implementation and a guess.

**Revisit when.** A second platform is contractually real, or a measured dashboard chart is too slow to serve live (then snapshot that chart, not everything).

---

## D-002 · Scope of the first product release: dashboards and the chatbot

**Date:** 2026-09-16 · **Status:** Active

**Decision.** The first release contains the three NowOps dashboards (SDM QBR, Application 360, Backlog Beacon) recreated in the standalone app, and the NowOps Assistant chatbot. Workflow-automation agents and a self-service catalog are the next two features in the pipeline and are out of scope for this release.

**Why.** Dashboards are where the definition problem lives (three meanings of "open" on one instance) and where the cross-client portfolio view comes from; those are the two things an in-instance dashboard cannot provide. The chatbot is already built and measured against abhrademo4.

**Consequences.** Everything in the first release is read-only against the client instance. Write-side controls (per-user credentials, confirm-before-commit action cards) are designed for when agents arrive, not now. The audit log is designed so writes can be added to it without restructuring.

**Build order within the release.** Tenancy and connections, the definitions table, then the QBR dashboard first. Application 360's CMDB, licence and security tiles are later additions within the release because they depend on optional plugins.

---

## D-003 · Live queries with a short cache; no sync database

**Date:** 2026-09-16 · **Status:** Active

**Decision.** Dashboard tiles and chatbot metrics run live against the client instance through the ServiceNow stats API, with results cached per tenant for a few minutes. Trends are computed live by date bucket (as the KPI data pull did), not from a synced store.

**Why.** ServiceNow aggregates server-side, so live is fast enough. A sync database was justified only by Jira's inability to aggregate (see D-001).

**Consequences.** The dashboard and the chatbot always show the same number for the same definition because both run the same query. Client instance downtime means the dashboard is unavailable for that tenant; this is accepted for a read-only proof of value.

**Revisit when.** A specific chart is measured too slow. The fix is a nightly snapshot of that chart only, added when measured, not up front.

---

## D-004 · NowOps owns every KPI definition, stored as data

**Date:** 2026-09-16 · **Status:** Active

**Decision.** Each KPI has a definition owned by NowOps: identifier, display name, owner, plain-language meaning, encoded query, aggregate, field, permitted dashboard filters, `platform` column, version. Definitions live in a table, editable without deployment. Dashboards run them; the chatbot matches a question against them before composing its own query.

**Why.** The KPI inventory established that access is not the constraint, definition is. Stored `sys_report` definitions on abhrademo4 were inconsistent (three meanings of "open") and several were wrong (relationship counts labelled as CI counts; an SLA tile reading 0 because of a close-notes clause; "TCO" counting apps with zero cost; "Tickets Approaching SLA Breach" never reading `task_sla`). NowOps cannot read definitions out of the client's reporting tables and be trusted.

**Consequences.** Every number is rendered with its definition (filter) and a deep link to the records counted. Where a client's house definition differs, both are visible; NowOps never silently substitutes.

**Open.** Whether clients may override standard definitions, and whether overrides are visible in UST portfolio views (see Pending decisions).

---

## D-005 · Multi-tenant across ServiceNow instances: automated instance scan, no onboarding checklist

**Date:** 2026-09-16 · **Status:** Active (reworded 2026-09-16; supersedes the "onboarding checklist" wording)

**Decision.** A tenant is one client; a connection is that client's instance URL plus a service credential held in a secrets store. On connection, the product **scans the instance itself**: it reads ServiceNow's own metadata (`sys_db_object`, `sys_dictionary`, `sys_choice`, `contract_sla`, `kb_knowledge_base`, installed plugins) for the ~25 standard tables NowOps uses and produces a per-connection summary and an onboarding report. No consultant fills in a form. The only human step is confirming two or three **meanings** the scan can detect but not decide: which of the client's SLA definitions is "P1 resolution" (sys_ids differ per instance), and whether any client-added states count as open or closed. These are pre-filled with the standard answer.

**Why.** The product uses only fields that ship with ServiceNow ITSM (D-006), so per-client field inspection is unnecessary. What still differs between instances is (a) **licensed plugins**: Software Asset Management, Security Incident Response and Vulnerability Response are separately licensed; a client without them has no `alm_license`, `sn_si_incident` or `sn_vul_vulnerable_item` table at all; (b) **instance-specific record identifiers** such as SLA definition sys_ids; (c) **choice values** where a client has added states (abhrademo4 has an incident in state 15). Measured on abhrademo4: ServiceNow silently drops a filter clause whose field does not exist and returns the whole table with HTTP 200 (the three licence tiles read 202, the full table, because `product_type` is not a column). The scan is what stops a confident wrong number reaching a client.

**Tiles are built once; the scan switches them on.** The product does not build tiles per client.
- **Core tiles** (incident, problem, change, request, `task_sla`, `cmdb_ci` counts) are always on; every ITSM instance has these tables.
- **Plugin tiles** (licences and entitlements, security incidents, vulnerable items) exist once in the product and are enabled only when the scan finds the table. When missing: the onboarding report lists them as "not available — requires <plugin>", so SDM and client know why; the daily dashboard hides them by default with a "show unavailable" toggle, because a permanent grey tile is noise for daily users. Whether the unavailable list becomes a commercial conversation is a sales decision.
- **Never a silent wrong number.** A tile whose definition references a missing table or field is shown as unavailable, not as an empty or full-table count.

**Alternatives rejected.** Assume the standard schema and fix on report (failures are silent). Hand-configure each client via a checklist (slow, drifts, does not scale, and unnecessary once custom fields are out of scope). Mirror all instance metadata (heavy, mostly unused). Build tiles per client according to what they have (a fork per client).

**Fallback.** If the service account cannot read metadata tables, the one-record field probe already used by the chatbot answers table and field existence without metadata access.

**Consequences.** Same code for every client; per-client facts as data. The summary also grounds the chatbot's per-tenant prompt and is refreshed on a schedule with drift alerts. The chatbot keeps its per-request field probe as a safety net for the gap between refreshes. Agents and the catalog later extend the same scan (write permissions, `sc_cat_item`), not a new system.

**Open.** Whether clients want the plugin-dependent data at all is unknown; abhrademo4's Application 360 content is largely demo data (0.5% CI linkage, all vulnerable items at risk zero, sample licence data). Build order in D-002 therefore puts QBR core first and plugin tiles only when a client with those products asks. Developer interview question: which dashboards do clients actually open.

---

## D-006 · No dependency on UST scoped-app fields; Backlog definition corrected

**Date:** 2026-09-16 · **Status:** Active

**Decision.** The standalone product does not read `x_ustgl_*` fields (Backlog Beacon, App360 event alerts, App Support application category, AURA). Standard dashboards run on standard ServiceNow fields only. The NowOps backlog definition is: active, In Progress, has an assignee, priority 2–4. The stored Backlog Beacon clause requiring `past_incidents` to be populated is dropped.

**Why.** Measured on abhrademo4: only the Backlog Beacon dashboard depends on UST fields. The application-category field is empty on all 36,030 incidents. Aging fields (`u_priority_aging`) are derivable from `opened_at`. The `past_incidents` clause does not describe the ticket; it records whether UST's AI job has processed it, shrinking the count from 5,377 to 239 for a reason unrelated to operations. A product that owns its definitions should not mix an AI-processing artefact into a business KPI.

**Consequences.** Backlog Beacon in the standalone app reduces to standard-field tiles: corrected backlog count, SLA active split, backlog by assignee, plain backlog list. The Next Best Action and Relevant Knowledge Articles columns are a later feature computed by NowOps itself (same gateway, same guardrails, same citation rules, results in our database), so it works for any client regardless of installed UST apps. Automation accounts such as "AURA Agent" (1,207 open assignments on abhrademo4) need a presentation decision in people-oriented tiles.

---

## D-007 · Chatbot keeps the single-call design; tool use is the planned evolution, gated on measurement

**Date:** 2026-09-16 · **Status:** Active

**Decision.** The chatbot proven against abhrademo4 is carried into the product as is: token guard, one speculative knowledge search, one model call with four reply forms (ANSWER / METRIC / SEARCH / NO_ANSWER), at most one retry, citation verification, guardrails at query execution, every number shown with its filter and link. Two additions for the product: a definitions-table match before composition (D-004) and per-tenant prompt grounding from the schema summary (D-005). Model-driven tool use (the model chooses `search_knowledge` or `run_metric`; the server executes with the same guardrails) is the intended next step, not built now.

**Why.** The single-call design isolates each component for measurement and costs one wasted ~200 ms search on counting questions. Tool use removes that waste and supports compound questions, at two to four model calls per turn and nondeterministic call counts. The trade depends on the share of counting questions in real traffic, which is unmeasured.

**Gates for moving to tool use.** (1) A spike confirming client-side tool use passes through the UST LLM gateway. (2) The metric evaluation (`npm run eval -- --metrics`, needs the gateway key) showing whether irrelevant articles distract the model from composing queries ("NOT A METRIC" count). If either shows a problem, the move is a rework of the request flow and parser only, a few days.

**Invariants that do not change with the design.** The model supplies data, never a request; our code validates and executes read-only; every number is shown with the query that produced it; malformed output is declined, never repaired.

---

## Pending decisions

Open questions that shape the architecture. Each names what it affects. Answered items become numbered entries above.

| # | Question | Affects |
|---|---|---|
| P-1 | One deployment for all clients, or one per client | Tenancy layer, secrets isolation, operations |
| P-2 | Hosting confirmation (AWS assumed) and identity provider for SSO; do client users log in, or UST staff only | Deployment, federation |
| P-3 | May clients override standard definitions; are overrides visible to UST portfolio views | D-004, support burden |
| P-4 | Expected client and user counts in year one | Cache and scheduling design |
| P-5 | Whether automation accounts (AURA Agent) appear in people-oriented tiles | Backlog and assignment tiles |
| P-6 | Observability sources (Dynatrace, Datadog) — uptime and latency exist in no ticketing platform | Scope of a later release |
| P-7 | Write access for agents: credential model and confirm-before-commit controls | Agents release (D-002) |
| P-8 | Server-side cache for model output (suggested steps, brief, drafts), keyed by tenant, ticket and the ticket's `sys_updated_on`, with a time backstop of about 24 h for changes outside the ticket (new articles, new look-alikes). Regenerates only when the record changed; shared across agents. Mockup uses an in-memory map; the product needs a small persistent table in the per-tenant store or a cache service, since instances restart and scale out. Not a copy of ServiceNow data, so it does not reopen D-003. Open: where it lives, TTL, and a per-tenant daily budget with fallback to rules. | Agents release (D-002), D-003, cost and latency of the LLM gateway |

---

## Sources

- NowOps Chatbot V2 design spec, rev 10 — `docs/superpowers/specs/2026-09-13-nowops-chatbot-design.md`
- NowOps KPI inventory — `docs/2026-09-13-nowops-kpi-inventory.md`
- NowOps KPI data pull — `docs/2026-09-14-nowops-kpi-data-pull.md`
- NowOps Standalone solution architecture, draft 0.1 — `docs/2026-09-16-nowops-standalone-solution-architecture.md` (sections 3–4 predate D-001 and D-003 and describe the multi-platform design; treat this log as authoritative where they differ)
