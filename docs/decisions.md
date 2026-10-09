# NowOps Standalone — Decision Log

Product and architecture decisions for the NowOps standalone application that are in force now. One entry per decision. An entry that is superseded is rewritten or removed; a pending question that is answered becomes an entry and leaves the table. Earlier wording is in git history. Updated only when the owner asks.

Each entry: what was decided, why, what follows from it, and what would make us revisit it.

---

## D-001 · ServiceNow is the only platform for now; Jira is deferred

**Date:** 2026-09-16 · **Status:** Active, with the exception in D-017

**Decision.** The standalone NowOps product is built against ServiceNow only. Jira (and any other platform) stays in the pipeline for a much later phase and is not designed for now.

**Why.** Every piece of complexity discussed in the platform-agnostic designs existed only to make two platforms look alike: a canonical ticket schema, a sync database, a connector interface, a core-versus-pack dashboard split, a neutral query language. With one platform none of it is needed. ServiceNow's aggregate endpoint answers every dashboard tile live; the KPI data pull (2026-09-14) computed all of them in minutes.

**Consequences.** No sync database, no canonical schema, no connector abstraction, no packs. ServiceNow code stays plain ServiceNow code. UST holds no copy of client ticket records; what NowOps does store is listed in D-017.

**Kept cheap for later.** Three habits, costing nothing now:
1. every line that knows ServiceNow lives in the `servicenow/` folder or the definitions table;
2. the definitions table has a `platform` column even though every row says `servicenow`;
3. API response shapes stay platform-neutral (entity, filter, aggregate, value, link).

When a second platform is actually signed, build it deliberately similar in shape, then extract the seam from two working implementations. Do not build the seam from one implementation and a guess.

**Revisit when.** A second platform is contractually real, or a measured dashboard chart is too slow to serve live (then snapshot that chart, not everything).

---

## D-003 · Live queries with a short cache; no sync database

**Date:** 2026-09-16 · **Status:** Active

**Decision.** Dashboard tiles and chatbot metrics run live against the client instance through the ServiceNow stats API, with results cached for a few minutes. Trends are computed live by date bucket (as the KPI data pull did), not from a synced store.

**Why.** ServiceNow aggregates server-side, so live is fast enough. A sync database was justified only by Jira's inability to aggregate (see D-001).

**Consequences.** The dashboard and the chatbot always show the same number for the same definition because both run the same query. Client instance downtime means the dashboard is unavailable for that tenant; this is accepted.

**Revisit when.** A specific chart is measured too slow. The fix is a nightly snapshot of that chart only, added when measured, not up front.

---

## D-004 · NowOps owns every KPI definition, stored as data

**Date:** 2026-09-16 · **Status:** Active

**Decision.** Each KPI has a definition owned by NowOps: identifier, display name, owner, plain-language meaning, encoded query, aggregate, field, permitted dashboard filters, `platform` column, version. Definitions live in a table, editable without deployment. Dashboards run them; the assistant runs the matching definition before composing its own query (D-015).

**Why.** The KPI inventory established that access is not the constraint, definition is. Stored `sys_report` definitions on abhrademo4 were inconsistent (three meanings of "open") and several were wrong:
- relationship counts labelled as CI counts;
- an SLA tile reading 0 because of a close-notes clause;
- "TCO" counting apps with zero cost;
- "Tickets Approaching SLA Breach" never reading `task_sla`.

NowOps cannot read definitions out of the client's reporting tables and be trusted.

**Consequences.** Every number is rendered with its definition (filter) and a deep link to the records counted. Where a client's house definition differs, both are visible; NowOps never silently substitutes.

**Open.** Whether clients may override standard definitions (P-3).

---

## D-005 · Tiles are built once for every client; what each instance has switches them on

**Date:** 2026-09-16 · **Status:** Active (rewritten 2026-10-08 to drop the parts replaced by D-008, D-011 and D-016)

**Decision.** A tenant is one client with one ServiceNow instance. The product does not build tiles per client.
- **Core tiles** (incident, problem, change, request, `task_sla`, `cmdb_ci` counts) are always defined; every ITSM instance has these tables.
- **Plugin tiles** (licences and entitlements, security incidents, vulnerable items) exist once in the product and apply only when the instance has the table.
- **Never a silent wrong number.** A tile whose definition references a missing table or field is unavailable with its reason, never an empty or full-table count. How such tiles are shown is in D-008.

Per-client facts (tables present, state classes, SLA match, time zone) are data in the tenant profile, read from the instance (D-011), never code.

**Why.** The product uses only fields that ship with ServiceNow ITSM (D-006). What still differs between instances:
- **licensed plugins:** Software Asset Management, Security Incident Response and Vulnerability Response are separately licensed, and a client without them has no `alm_license`, `sn_si_incident` or `sn_vul_vulnerable_item` table at all;
- **instance-specific record identifiers,** such as SLA definition sys_ids;
- **choice values,** where a client has added states (abhrademo4 has an incident in state 15).

Measured on abhrademo4: ServiceNow silently drops a filter clause whose field does not exist and returns the whole table with HTTP 200. The three licence tiles read 202, the full table, because `product_type` is not a column.

**Alternatives rejected.**
- Assume the standard schema and fix on report: the failures are silent.
- Hand-configure each client with a checklist: slow, drifts, does not scale.
- Mirror all instance metadata: heavy, mostly unused.
- Build tiles per client according to what they have: a fork per client.

**Fallback.** Where metadata tables cannot be read, the one-record field probe answers table and field existence without metadata access. The assistant keeps the same probe on every composed query.

**Open.** Whether clients want the plugin-dependent data at all is unknown; abhrademo4's Application 360 content is largely demo data (0.5% CI linkage, all vulnerable items at risk zero, sample licence data). The build order in D-014 therefore puts the QBR core first and plugin tiles only when a client with those products asks.

---

## D-006 · No dependency on UST scoped-app fields; Backlog definition corrected

**Date:** 2026-09-16 · **Status:** Active

**Decision.** The standalone product does not read `x_ustgl_*` fields (Backlog Beacon, App360 event alerts, App Support application category, AURA). Standard dashboards run on standard ServiceNow fields only. The NowOps backlog definition is: active, In Progress, has an assignee, priority 2–4. The stored Backlog Beacon clause requiring `past_incidents` to be populated is dropped.

**Why.** Measured on abhrademo4: only the Backlog Beacon dashboard depends on UST fields. The application-category field is empty on all 36,030 incidents. Aging fields (`u_priority_aging`) are derivable from `opened_at`. The `past_incidents` clause does not describe the ticket; it records whether UST's AI job has processed it, shrinking the count from 5,377 to 239 for a reason unrelated to operations. A product that owns its definitions should not mix an AI-processing artefact into a business KPI.

**Consequences.** Backlog Beacon in the standalone app reduces to standard-field tiles: corrected backlog count, SLA active split, backlog by assignee, plain backlog list. The Next Best Action and Relevant Knowledge Articles columns are a later feature computed by NowOps itself (same LLM, same guardrails, same citation rules), so it works for any client regardless of installed UST apps. Automation accounts such as "AURA Agent" (1,207 open assignments on abhrademo4) need a presentation decision in people-oriented tiles (P-5).

---

## D-008 · No confirm step and no scheduled rescan; tiles with nothing to show are hidden; admins correct, never approve

**Date:** 2026-09-23 · **Status:** Active (rewritten 2026-10-08: onboarding steps moved to D-016; how states and SLAs are resolved is D-010 and D-011)

**Decision.**
- **No confirm step.** Nobody approves the instance's definitions before the first dashboard. The definitions engine resolves what it needs from the instance's own data and keeps the result in the tenant profile.
- **Two settings pages** take the place of a confirm step:
  - **Connection health** shows what was resolved and why, with an override for each choice;
  - **Tiles** lists every definition with an on/off switch.

**No scheduled rescan.** Resolved values are re-derived when the tenant cache expires, so a change on the instance (a new state, a retired SLA, a plugin added or removed, an access rule tightened) is picked up on a later load. When a freshly resolved value differs from the stored one, the difference is recorded and shown as a change notice on Connection health. There is no scheduler and nobody has to run anything. Who the re-derivation runs as is open in D-016.

**Tile visibility.** Tiles are built once for every client (D-005), but a tile that has nothing to show is hidden from the dashboard rather than displayed as "not available" or "no data yet". Two cases hide by default:
- the table or field is absent on the instance;
- the table exists but holds no records for the definition (the Tier B case, for example orphan CIs and reopened incidents on abhrademo4).

The Tiles page lists every definition with its current state and an on/off switch. An admin can turn a tile on when the client starts recording that data, or turn off a tile the client does not want. A tile turned on that still has nothing to show renders with its reason. Hidden tiles are still listed on Connection health, so nobody mistakes an absent tile for an absent problem.

**Admin override, not approval.** Connection health shows every automatic choice with the evidence behind it and lets an admin change it. This is a correction path used rarely, not a gate on the first dashboard. Overrides are stored in the profile and survive re-resolution; a change notice is raised if the evidence later contradicts an override.

**Why.** A confirm step asks an admin to decide from labels what the instance's records already show. A weekly job is a coarse way to detect change that the cache expiry detects finely.

**Revisit when.** A client asks for a formal sign-off on definitions for contractual reasons. Connection health would then gain an "approved by" stamp without becoming a gate.

---

## D-009 · Settings live behind the gear in the top bar, as a page in the same frame

**Date:** 2026-09-24 · **Status:** Active, build deferred

**Decision.** The gear icon in the top bar is the single entry to settings. Settings open as a page at the `#settings` hash, inside the same frame as Dashboard and Resolve, so the top bar and the assistant stay in place. There is no separate admin site and no settings inside individual tiles. Settings are for admins (D-014).

**Sections, in this order.**
1. **Connection.** Instance URL, OAuth client status, last successful call. The automatic choices from D-008 with their evidence: the SLA definition picked and why, and each state with the class it was given (D-011). An override beside each choice. Change notices when a re-resolved value differs from the stored one.
2. **Tiles.** Every definition, grouped by page, with its current state (available, not available with reason, no data yet) and an on/off switch. Tiles hidden by default under D-008 show as off here.
3. **Resolve.** The "Model off" pill on the queue page becomes a real switch here: drafts by rules only. The writes dry-run switch is a deployment setting outside production (D-014), not a Settings control.
4. **Appearance.** Light or dark theme (`docs/design-system.md`). The top bar keeps a shortcut.

**Why.** The mockup already has the gear and a working theme button beside it, so the gear is where a user will look. A page in the existing frame reuses the layout and the endpoints (validate, connection, profile) rather than adding a surface.

**Status of the build.** Not built; in the mockup the gear is a dead link.
- Sections 1 and 2 each need one small server addition: the resolution evidence exposed with the profile, and a per-tenant tile visibility map with a filter in the dashboard render.
- Sections 3 and 4 move controls that already exist.

The build waits until the dashboard tile set settles; building settings for tiles that are still moving would be rework.

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
## D-012 · A chart under a tile runs the tile's query

**Date:** 2026-10-04 · **Status:** Active

**Decision.** A chart that breaks a tile down (by group, priority, location) names the tile by definition id (`def`) and takes the tile's query from the definitions table through `/api/breakdown?def=…`. The chart carries no filter of its own; its static filter text is only the snapshot's recipe. The server applies the period range to the definition's own date field, rejects ids that are not definitions, refuses ratios ("break down one of its parts"), and returns the resolved query so the page shows the same recipe as the tile. The bars therefore add up to the tile, and the chatbot's `run_definition` narrowed by the same group gives the same figure.

**Why.** Seen live 2026-10-04 on abhrademo4: "Breached SLAs by support group" showed Network at 5,529 while the chatbot answered 1,635 for the same group. Both were right for their own query. The chart counted every breached incident SLA of any type and any stage (completed resolution SLAs 1,635, still-running breaches 3,814, completed OLA and underpinning-contract SLAs 82); the tile and the chatbot count completed resolution SLAs only (D-010). D-010 aligned the tiles and D-004 made the chatbot run the tile's query, but charts kept inline filters in the page, so this one drifted unseen. Every other chart on the page was checked against its tile and agrees: open-incident charts share the open-states placeholder, the attainment and monthly SLA charts use the completed-resolution population, change and security charts use the open-change and open-security definitions' filter.

**Rule.** When a chart sits beside a tile, it names the tile. A new inline filter on a chart is a review question: which definition is this, and why is it not that one?

---
## D-013 · The page holds no figures: every number is read from the instance at load

**Date:** 2026-10-04 · **Status:** Active

**Decision.** The dashboard page describes what each card counts and never what it last said. The snapshot of abhrademo4 that lived in the page (every tile value, chart row, month series, note and subtitle with a figure in it; a full application map of 1,731 record ids; a gazetteer of the instance's locations; its custom state labels; the P1 SLA record id; a demo user) is gone. The server scans the instance when it starts and the page asks for a fresh scan on every load, so a restart or a reload always shows the instance as it is now. Until the scan answers, tiles show "…" and charts a "Reading the instance" placeholder; if the instance does not answer, the page says so and stays empty. Nothing falls back to a stored figure.

1. **Scan at startup, scan on load.** `scan()` runs when the server listens and whenever the page connects; the server's figure cache is cleared on every scan. Before the first scan completes a figure route answers 409 "instance not scanned yet", never a count built on a guessed state list. The `'1,2,3'` and `'6,7'` defaults are removed.
2. **Everything the page shows about the instance is read then:** host name, tenant label, state labels (merged into the recipe vocabulary from the scan), coordinates for the location charts (`/api/places`, from `cmn_location`), the list of business services for Application 360 (`/api/services`), and the application map per service (`/api/graph`).
3. **No record id in a definition.** The orphan-CI tile filters by the health metric's name (`metric.name=Orphan`), not by its sys_id; the P1 attainment recipe uses `{{sla_p1_resolution}}` from the scan.
4. **Charts with no data draw as placeholders,** not as charts of zeros, so an empty read cannot be mistaken for a measurement.

**Still fixed in the page, by design or pending.** Tile thresholds (watch / attention / scale) are product choices tuned on the demo instance and belong in Settings (D-009); the standard ServiceNow choice values (request item states 3 and 4, install status 1 and 6, risk ratings 1 and 2) are shipped values, still to be validated against the instance's choice lists (D-011, "Still assumed"); the demo sign-in account is the product's own, not the instance's.

**Why.** Seen 2026-10-04: with the server restarted and not yet scanned, the dashboard showed the September snapshot's figures as if current, and a chart's subtitle quoted a figure from another instance. The product is the scan plus the rules (D-011); a stored figure anywhere in the page is a second source of truth that drifts. Removing it also removes the "replay" mode: the page is served by its server or it reads nothing.

---

## D-014 · Release 1: dashboards, assistant and Resolve with writes, used by whoever the client's instance signs in

**Date:** 2026-10-08 · **Status:** Active

**Decision.** The first release contains the three dashboards (SDM QBR, Application 360, Backlog Beacon), the NowOps Assistant, and the Resolve fulfiller page **with writes**.

**Users.** The client's staff, and UST staff (SDMs, agents) who hold an account on the client's ServiceNow instance. Everyone signs in on the client's own subdomain through that instance (OAuth authorization code), and therefore through the client's SSO. There is no separate UST login and no view across clients in release 1. Workflow-automation agents and a self-service catalog stay out of scope.

**Every read and write runs as the signed-in user,** with that user's ServiceNow token. ServiceNow's ACLs decide what each person sees and may change. No shared service credential reads or writes for users.

**Writes in release 1** are the Resolve actions the mockup has today (`mockup/server.ts`, `/api/resolve/write`). Each is a fixed, whitelisted request body:

| Action | Applies to | What is written |
|---|---|---|
| Claim | Incident | `assigned_to` = the user, a work note; state New moves to In Progress |
| Reassign | Incident, request item | `assignment_group` and/or `assigned_to` (looked up by name, active only), a hand-over work note |
| Hold | Incident | State On Hold with a hold reason (Awaiting Caller, Change, Problem or Vendor), a work note |
| Resolve / close | Incident: resolved, with close code and close notes. Request item: closed complete or closed incomplete, with close notes | State, close code, close notes, work note |
| Work note | Incident, request item | `work_notes` |
| Comment | Incident, request item | `comments` (visible to the caller or requester) |
| Approve / reject | An approval in Requested state on the request item | `sysapproval_approver` state and a comment |
| Knowledge article draft | Incident | New `kb_knowledge` record in draft state |
| Problem | Incident | New `problem` record linked to the incident (`first_reported_by_task`) |
| Record fixes | Incident, request item | Only `cmdb_ci`, `assignment_group`, `assigned_to` (sys_ids) and `category` (short value), with a work note |

The mockup writes fixed state numbers for these actions. Before release they come from the scanned state classes instead, as D-011 requires.

**Every write needs confirm-before-commit.** The page shows the record, the table and the exact fields and values to be written, and nothing is sent until the user confirms. The dry-run switch (`RESOLVE_WRITES`) stays for non-production use. The assistant has no write tools (D-015).

**No NowOps audit table.** Writes go out under the user's own token, so ServiceNow's own history (`sys_audit`, the journal, `sys_updated_by`) records the real person. NowOps keeps operational logs only. The mockup's "via NowOps by <name>" work-note suffix existed because ServiceNow only saw the service credential; it goes.

**Roles.** A user holding the ServiceNow `admin` or `nowops_admin` role on the client instance is a NowOps admin (D-016); everyone else is a member.

**Build order within the release.**
1. Tenancy and sign-in.
2. The definitions table.
3. The QBR dashboard.
4. Application 360's plugin-dependent tiles, when a client with those products asks (D-005).

**Why.** The owner set the release-1 scope and users on 2026-10-08. Running as the user removes the shared-credential problems found in the mockup:
- identity supplied by the browser;
- every user seeing whatever the service account could see;
- writes attributed to the service account.

**Consequences.** The OAuth application on the client instance needs a scope that allows these reads and writes. Which scope that is, is still to be verified.

**Revisit when.** UST needs one view across clients (that needs a UST identity path), or a client will not issue per-user OAuth access.

---

## D-015 · The assistant answers with read-only tools

**Date:** 2026-10-08 · **Status:** Active (in the code since 2026-10-02)

**Decision.** The assistant runs a tool loop (`src/llm/agent.ts`, `src/tools/`). For one question the model may make up to six tool calls at temperature 0, then writes an answer. Every number in the answer must cite a tool result that contains it. One retry names any ungrounded numbers; after that the answer is refused.

The tools are:
- `run_definition`, `count`, `aggregate`, `list_records`;
- `resolve_reference`, `describe_table`, `list_choices`, `validate_query`;
- `search_knowledge`, `get_article`;
- `get_ticket`, `my_queue`;
- `ask_user`.

All of them read; none writes. The definitions catalogue is in the prompt, and the model runs a definition when one matches exactly (D-004).

**Why.** The earlier single-call design could answer only what the server had a form for: compound questions, lists, breakdowns, and named groups or locations fell through.

**Invariants.**
- The model supplies tool arguments, never a request.
- Server code checks every call before it runs: the table allowlist plus scanned tables, denied tables and fields, field existence, query shape, sys_ids only from this question's lookups, and at most 25 rows per list.
- Every number is shown with the query behind it and a verify link.
- Malformed output is declined, not repaired.
- Quality is measured with `tools/eval.ts` against fixed question sets.

**Consequences.**
- A question can cost up to seven model calls: six tool steps and one grounding retry.
- Ticket content reaches the model: list rows, and for `get_ticket` a ticket's description, close notes and its latest eight journal entries (see D-017).

**Revisit when.** The measured cost or latency per question is too high, or the evaluation shows the loop picking the wrong tool.

---

## D-016 · Onboarding by invite: UST registers the client, the client's ServiceNow admin connects it

**Date:** 2026-10-08 · **Status:** Active

**Decision.**
1. UST creates the tenant: its subdomain and the client's instance host.
2. UST adds that host to the egress allowlist before anything else, so a client cannot point NowOps at a different host without UST.
3. UST issues a single-use invite link valid for 7 days.
4. The client's ServiceNow admin creates an OAuth application on the instance with the NowOps callback URL.
5. The admin opens the invite and enters the instance URL, which must match the recorded host, and the OAuth client id and secret.
6. The admin signs in through the instance and must hold the ServiceNow `admin` or `nowops_admin` role to activate the tenant.
7. From then on, definitions resolve themselves as D-008 and D-011 describe, and other users sign in directly to the dashboard.

**Why.**
- Per-user sign-in (D-014) needs an OAuth application on each instance.
- Default-deny egress needs the host allowlisted before the first call.

The human steps are the minimum those two require: the client creates the OAuth application, and UST registers the host.

**Consequences.**
- Onboarding is not zero-touch: each client needs a UST step (tenant and allowlist) and a client step (OAuth application, invite).
- Nobody confirms definitions (D-008).

**Open.**
- How the UST person creates the tenant, and how they sign in to do it.
- Who the instance scan runs as. Architecture §7 flow 2 proposes an admin's token, because a member's ACLs may hide metadata.

**Revisit when.** Clients ask to onboard without a UST step, or the allowlist changes become the bottleneck.

---

## D-017 · Stored chat messages and Resolve drafts may quote ticket text

**Date:** 2026-10-08 · **Status:** Active (exception to D-001)

**Decision.** NowOps copies no ticket records: no sync, no ticket tables, no stored record lists. Two things it does store can contain ticket text:
- **chat messages:** the user's question and the assistant's answer, which may quote a ticket's description, notes or close notes;
- **Resolve drafts** in the model-output cache (P-8).

Both are tenant-scoped and kept for a limited, stated time.

What NowOps stores, in full: tenants and their connections, users, definitions, the tenant profile, chats, drafts, LLM usage, sessions, and operational logs. There is no audit table (D-014).

**Why.** The assistant reads ticket content to answer (D-015), and chat history is kept so follow-up questions work. A draft is built from the ticket it is about. Neither can be stored without the text it quotes.

**Consequences.**
- Retention for chats and drafts must be set and enforced.
- The data-handling rules (personal data, client agreements) apply to these two stores.

**Open.** Retention periods for chats and drafts.

---

## D-018 · One shared deployment on AWS ap-south-1

**Date:** 2026-10-08 · **Status:** Active (one deployment answered 2026-10-05; hosting 2026-10-08)

**Decision.** One NowOps deployment serves every client, on AWS in ap-south-1. Every tenant-scoped row carries the tenant id. Each client has its own subdomain, and the tenant is taken from the host name. Client staff reach it over the public internet behind AWS WAF.

**Why.** The owner chose a shared deployment over one per client, and AWS ap-south-1 as the hosting region. Users are client staff outside the UST network (D-014), so the app cannot sit behind Zscaler ZPA alone.

**Consequences.**
- A public surface is a deviation from the NowStudio internal-app protocol NowOps otherwise follows, and needs UST security sign-off.
- Tenant isolation is enforced in the application and the schema, not by separate deployments.

**Revisit when.** A client requires physical isolation, or UST security does not accept the public surface.

---

## Pending decisions

Open questions that shape the architecture. Each names what it affects. Answered items become entries above and leave this table.

| # | Question | Affects |
|---|---|---|
| P-3 | May clients override standard definitions? | D-004, support burden |
| P-4 | Expected client and user counts in year one | Cache, database and capacity design |
| P-5 | Whether automation accounts (such as AURA Agent) appear in people-oriented tiles | Backlog and assignment tiles |
| P-6 | Observability sources (Dynatrace, Datadog): uptime and latency exist in no ticketing platform | Scope of a later release |
| P-8 | Server-side cache for model output (suggested steps, brief, drafts), keyed by tenant, ticket and the ticket's `sys_updated_on`, regenerated only when the record changed. Open: the time backstop, and how the per-tenant daily budget falls back to rules. `docs/database.md` proposes a Postgres table | Resolve, D-003, D-017, LLM cost and latency |
| P-10 | LLM provider and token cap. A client may bring its own LLM in release 1 (answered 2026-10-08); then NowOps sets no token cap. With UST's gateway, a per-tenant daily token budget applies, with fallback to rules. Open: the interface a client endpoint must offer; its security and data terms (masking, region, retention); whether a per-user cap is needed on top of the per-tenant budget | Architecture §7 flow 7, §12; `docs/security.md` §8 |

---

## Related documents

- `docs/architecture.md`: how the system is built, with open questions and facts to verify.
- `docs/database.md`, `docs/security.md`, `docs/design-system.md`.
- The September research (KPI inventory, KPI data pull, chatbot design spec, solution architecture draft 0.1) is in git history.
