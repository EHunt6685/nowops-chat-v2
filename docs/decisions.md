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

**Date:** 2026-09-16 · **Status:** Active in part (reworded 2026-09-16; supersedes the "onboarding checklist" wording). The upfront scan step, the human confirm step and the scheduled refresh are superseded by D-008; the rest stands.

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

## D-008 · Zero-touch onboarding: definitions resolve themselves on first run; no scan step, no confirm step, no scheduled rescan

**Date:** 2026-09-23 · **Status:** Active (supersedes the scan, confirm and scheduled-refresh parts of D-005)

**Decision.** Onboarding is sign in, connect the instance, dashboard. There is no scan phase, no profile or validation screen, and no human confirmation. The definitions engine resolves everything it needs the first time a definition runs, from the instance's own data, and keeps the result in the tenant profile. Two settings pages replace the removed steps: **Connection health**, which shows what was resolved and why, with an override for each choice; and **Tiles**, which lists every definition with an on/off switch.

**How each former human decision is made automatically.**
- **Table and field availability.** The first run of each definition is the scan. A definition whose table or field is missing is marked "not available" with the reason, using the one-record probe and missing-table check that already exist. Nothing is probed ahead of time.
- **Which custom states count as open.** Not read from the label. For each non-standard state value, the engine measures the share of records in that state that have no resolution date. Above about 90 percent unresolved the state counts as open; above about 90 percent resolved it does not. A mixed state defaults to open and is noted in the tile recipe and on Connection health. The instance's own behaviour decides, not our guess.
- **Which SLA definition is "P1 resolution".** Structural match: SLA definitions on the incident table, type SLA, active, condition referencing priority 1, name containing "resolution" or "resolve". One match is used. Several matches: the one with the most `task_sla` records attached, because that is the one the instance actually runs. The reason is written into the tile recipe ("chosen because it carries 6,910 of 7,100 P1 resolution SLA records"). A near tie is noted, never blocking.
- **Priority labels and other choice lists.** Read from `sys_choice` on first use, cached in the profile.

**No scheduled rescan.** Resolved values are re-derived whenever the tenant cache expires (minutes), so any change on the instance (a new state, a retired SLA, a plugin added or removed, an access rule tightened) is picked up on the next load. When a freshly resolved value differs from the stored one, the difference is recorded and shown as a change notice on Connection health. That replaces the weekly job and its drift alert; there is no scheduler and nobody has to run anything.

**Tile visibility.** Tiles are still built once for every client (D-005), but a tile that has nothing to show is hidden from the dashboard rather than displayed as "not available" or "no data yet". Two cases hide by default: the table or field is absent on the instance, and the table exists but holds no records for the definition (the Tier B case, for example orphan CIs and reopened incidents on abhrademo4). The Tiles settings page lists every definition with its current state and an on/off switch, so an admin can turn a tile on when the client starts recording that data, or turn off a tile the client does not want. Turning a tile on that still has nothing to show renders it with its reason, as today. Hidden tiles are still listed on Connection health so nobody mistakes an absent tile for an absent problem.

**Admin override, not approval.** Connection health shows every automatic choice with the evidence behind it and lets an admin change it. This is a correction path used rarely, not a gate on the first dashboard. Overrides are stored in the profile and survive re-resolution; a change notice is raised if the evidence later contradicts an override.

**Why.** The confirm step asked an admin to decide from labels what the instance's records already show. The scan duplicated the failure handling the engine has to do at run time anyway. The weekly job was a coarse way to detect change that the cache expiry already detects finely. Removing all three leaves credentials and identity as the only onboarding inputs, which is the promise made to clients: connect once and read.

**Consequences.** The mockup's scan, confirm and skip screens become dead code and are retired with the old page. Tenant profile gains: resolved placeholders with evidence, overrides, change notices, tile visibility. The definitions engine gains: lazy placeholder resolution, the unresolved-share test for states, the structural SLA match with usage tiebreak. The chatbot's per-tenant grounding (D-005, D-007) reads the same profile.

**Revisit when.** A client's instance has a state that the unresolved-share test cannot classify and the default causes a wrong open count that the recipe did not make obvious; or a client asks for a formal sign-off step on definitions for contractual reasons, in which case Connection health gains an "approved by" stamp without becoming a gate.

---

## D-009 · Settings live behind the gear in the top bar, as a page in the same frame

**Date:** 2026-09-24 · **Status:** Active, build deferred

**Decision.** The gear icon already in the top bar of the app is the single entry to settings. Settings open as a page at the `#settings` hash, inside the same frame as Dashboard and Resolve, so the top bar, the tenant switch and the assistant stay in place. There is no separate admin site and no settings inside individual tiles.

**Sections, in this order.**
1. **Connection.** Instance URL, credential status, last successful call. The automatic choices from D-008 with their evidence: the SLA definition picked and why; each custom state with the unresolved share that classified it. An override beside each choice. Change notices when a re-resolved value differs from the stored one.
2. **Tiles.** Every definition, grouped by page, with its current state (available, not available with reason, no data yet) and an on/off switch. Tiles hidden by default under D-008 show as off here and can be turned on when the client starts recording that data.
3. **Resolve.** The "Writes on" and "Model off" pills shown on the queue page become real switches here, with the audit log of writes beneath them.
4. **Appearance.** The theme toggle moves in from the top bar; the bar keeps a shortcut.

**Why.** The mockup already has the gear and a working theme button beside it, so the gear is where a user will look. D-008 removes onboarding screens and needs a home for the override and visibility controls it introduces; a page in the existing frame reuses the layout and the endpoints (validate, connection, profile) rather than adding a surface.

**Status of the build.** Not built. In the mockup the gear is a dead link. Sections 1 and 2 need one small server addition each: exposing the resolution evidence with the profile, and a per-tenant tile visibility map with a filter in the dashboard render. Sections 3 and 4 are re-homing controls that exist. Deferred until the dashboard tile set settles; building settings for tiles that are still moving would be rework.

**Revisit when.** The tile list stabilises after the Operational and Strategic split is agreed, or a client needs the override path before then.

---

## D-010 · SLA, MTTR and state definitions corrected after an audit against the instance

**Date:** 2026-10-02 · **Status:** Active

**Decision.** Nine dashboard figures were audited against abhrademo4 and corrected. Each correction is a change to the shared definitions table or to the series endpoint, so the dashboard and the chatbot change together.

1. **SLA Breaches (incidents)** is completed, type SLA, breached. Breached plus met now equals completed, and the Period control applies to every record. The old count (24,397) included 16,177 SLAs still running and 3,357 OLAs. A new tile, **SLA breaches still running**, carries the live figure.
2. **SLA by month** buckets on `end_time`, as the tiles do. By creation date June 2026 showed 17,957 met: the demo data's load date.
3. **SLAs at risk now** and **SLAs due within 72 h** require `stage=in_progress`, and the 72-hour tile has a lower bound of now. 143 of 148 "at risk" records were completed; 50 of 53 "due" records were already past their planned end. Those 50 are a new tier B tile, **SLAs past planned end, not breached**.
4. **MTTR P1, MTTR P2, Time-to-Restore** average only incidents with a recorded `calendar_duration`, and say so. Here that is 1,330 of 7,520 resolved P1s. The Create to Resolve metric has 26,457 complete rows but cannot be split by priority through the Stats API, so it is not used yet.
5. **Cancelled Tickets** reads `{{cancelled_states}}` from the scan. The scan classifies each custom state by its label: cancelled, closed or open. State 9 "Cancelled" was counted as both open and cancelled; the chatbot showed 5,417 open incidents where the standard three states give 5,413.
6. **Approvals pending** is scoped to change requests and request items. The unscoped count carried approvals with no source record and single approvals on a user, an article and an incident.
7. **Resolved by automation**, **Server warranty expired** and **Time to resolve** show the basis of the figure on the tile: the named-resolver count, the servers with a date, the incidents with a duration.

**Why.** A number that is right by its own definition and wrong by the page's other numbers is the quiet failure D-004 exists to prevent. The audit method (every tile and chart query run against the instance and cross-checked against its neighbours) is the one to repeat when a client instance is first connected.

**Revisit when.** The Stats API can split a metric by task priority (then MTTR moves to the Create to Resolve metric), or a client's SLA setup uses OLAs as commitments.

---

## D-011 · Built for any instance: nothing about abhrademo4 lives in the code

**Date:** 2026-10-02 · **Status:** Active

**Decision.** A second, unrelated demo instance (ven06951) was connected as a portability test. Everything that only worked because the instance was abhrademo4 was removed or made instance-derived. abhrademo4 remains the development and demo instance; it is evidence, never a constant.

1. **No number in prose.** Definition meanings and tile subtitles carry no figures. The basis of a figure is read live: an average carries the count of records it rests on (`n`, "over 1,330 records with calendar_duration"); a share carries its denominator through a `basis` definition ("76 of 96 servers with a warranty date"). Zero basis is "no data yet"; fewer than ten records is "thin data", shown with the reason. The chatbot's grounding check no longer counts a definition's description as evidence.
2. **Every incident state class comes from the scan,** which classifies each state by its label on the instance: new, in progress, on hold, resolved, closed, cancelled. Filters use `{{open_states}}`, `{{in_progress_states}}`, `{{on_hold_states}}`, `{{closed_states}}`, `{{cancelled_states}}`. No state number is assumed anywhere. The chatbot is told the classes and composes "open" as the open states, never `active=true`.
3. **Absent plugins are named as such.** HTTP 400 "Invalid table" from the instance means not installed; only a network failure is "unreachable".
4. **Automation accounts are discovered, not named.** The scan proposes users that resolve incidents and look like automation; the tile is "not configured" until one exists. The account name AURA Agent is gone from the code.
5. **Time zone is read from the instance** (`glide.sys.default.tz`) and kept as a tenant parameter; month charts and the chatbot's date rules use UTC calendar bounds and say so.
6. **Zero durations are not durations.** Averages over `calendar_duration` require a value greater than zero; the one-record, zero-second MTTR seen on ven06951 reads as "no data".
7. **Connection-time checks** (`/api/checks`) run the audit of D-010 as rules on any instance: breached plus met equals completed; open plus closed plus cancelled equals total; servers with and without a warranty date add up to servers; every average's coverage; every tile that is off, with its reason.

**Still assumed, to be removed when a client needs it.** The names of the standard choice values (emergency, successful, requested, Open/Reopen on alerts) are not yet validated against the instance's choice lists; the SLA matcher still looks for "Priority N" in SLA names and relies on Settings (D-009) for the human pick; Resolve's system vocabulary is a fixed list.

**Why.** On the second instance the chatbot repeated abhrademo4's figures from a definition's wording, the scan called missing plugins "unreachable", open incidents differed between tiles and composed queries, and two averages rested on one record each. None of these were visible on abhrademo4 alone. The product is the scan plus the rules; the instance is input.

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
| P-9 | Chatbot prompt once the model is live: hand the model the NowOps definition catalogue (id, name, meaning, about 60 rows) and have it pick a definition when the question means one, writing a raw query only for what no definition covers. Replaces the word-matching layer built while the gateway was unreachable (normalisation, plural folding, score threshold), which stays only as the zero-cost fast path. Keeps every structural guard: identity context for me/my/this ticket, table whitelist from the instance scan, shown query with a verify link, decline rather than guess. Then run the eval harness (`tools/eval.ts`) against a fixed question set so quality is measured, not found one screenshot at a time. Open: catalogue size in the prompt versus a two-step pick, and how ratios are presented to the model. | D-004, chatbot accuracy, cost per question |

---

## Sources

- NowOps Chatbot V2 design spec, rev 10 — `docs/superpowers/specs/2026-09-13-nowops-chatbot-design.md`
- NowOps KPI inventory — `docs/2026-09-13-nowops-kpi-inventory.md`
- NowOps KPI data pull — `docs/2026-09-14-nowops-kpi-data-pull.md`
- NowOps Standalone solution architecture, draft 0.1 — `docs/2026-09-16-nowops-standalone-solution-architecture.md` (sections 3–4 predate D-001 and D-003 and describe the multi-platform design; treat this log as authoritative where they differ)
