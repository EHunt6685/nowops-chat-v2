# NowOps KPI inventory and data availability

**Measured:** 2026-09-13 · **Instance:** `abhrademo4.service-now.com` · **Method:** REST API (OAuth), read-only counts

What the existing NowOps dashboards track, and which of it is reachable through
the API. Written as the starting input for a NowOps app spec: the dashboards
prove the data is queryable in principle, this records what is actually there.

Every number below was measured against the live API, not assumed. Dashboard
figures quoted from screenshots are snapshots and are treated as such: they are
used to expose differences in *definition*, never as values to match. See §3.

---

## 1. Dashboard inventory

Three dashboards, surveyed from 19 screenshots.

### 1.1 Application 360 — technical and CIO view

| Tab | Widgets |
|---|---|
| **Operational Metrics** | Open Incidents · Open P1 Incidents · Unassigned Requests · Total Requests · Open Changes · Alerts count · Open Problems · Open Incidents by Priority · IncidentCount by Age & Priority · Priority-wise Incident Assigned (by group) · Open Changes grouped · Service Request Count · Problems by State |
| **IT Configuration View** | Application count · Servers · Databases count · BI Portal Service dependency map · Administrations (SAP Enterprise Services) dependency map |
| **Unified Software View** | Software Entitlement by State · Perpetual / Upgrade / Subscription license counts · Entitlements with active maintenance · Active vs Purchase Rights (incl. cost) |
| **Security View** | Security Incidents · Vulnerable Items · Security Incident Map (geo) · Security Incidents open >30 days by group × state · Open Security Incidents by Age · Security Incident by Priority · Vulnerable Items by Risk · Services with Security Incidents by Criticality |
| **Incident SLA Performance** | SLA Breach Count (P1 & P2) · SLA Breach Count P5 · Monthly SLA Violation Trends · SLA Breach Status |
| **CMDB Health & Integrity** | Count of Orphaned CIs · CIs updated in last 30 days · Discovered Cloud Resources · Portfolio Overview · Configuration Item by Location |
| **Application Portfolio Mgmt** | Application lifecycle stage · TCO per Application |
| **CIO-Level Strategic** | Server Warranty Expiration · "Server Utilization — Memory" · "Server Utilization — CPU" |

### 1.2 SDM QBR Dashboard — the service-delivery-manager view

Five dashboard-level filters on every tab: Task type, State, Application
Category, Incident Priority, Incidents-created.

| Tab | Widgets |
|---|---|
| **Engagement Metrics — Volume** | Total / Closed / Open / On-Hold / Cancelled Tickets · Ticket Volume (Incident vs Service Request) · by State · by Priority · by Cause Code · by Support Group · by Location · by Application |
| **Engagement Metrics — SLA Adherence** | Total Tickets · Closed Tickets within SLA · Closed · Cancelled · On-Hold · SLA Adherence % (Resolution) overall and per priority P1–P4, with trends |
| **Engagement Metrics — MTTR** | Mean Time To Resolve, P1 / P2 / P3 / P4, monthly |
| **Engagement Metrics — Backlog and Aging** | Opening vs Closure Rate · BMI trend (Backlog Management Index) · Ticket Aging Trend · Aging categorisation by priority × state · Ticket Age by Priority · Tickets Approaching SLA Breach P1 / P2 |

### 1.3 Backlog Beacon

Backlog Incidents Count · SLA grouped by active · Incident Backlog table with
AI-generated **Next Best Action** · Incident Backlog by assignee.

The Next Best Action column is backed by UST custom fields on `incident`:
`u_next_best_action`, `u_relevant_knowledge_articles`, `u_past_incidents`
(scope `x_ustgl_backlog_be`).

---

## 2. Reachability

### Green — reachable, data is solid

Ticket volume and every breakdown (state, priority, support group, location,
cause code, application category); open / closed / cancelled counts; aging
buckets; backlog; opening vs closure; BMI; SLA breach counts and trends; SLA
adherence; security incident counts by age, priority and group; CMDB counts;
orphaned CIs; CI by location; software entitlements and license costs;
application lifecycle and TCO; server warranty; problems; changes; requests.

SLA is the strongest area. `task_sla` carries `planned_end_time` (breach time),
`has_breached`, `percentage`, `time_left`, `stage`, plus `business_*` variants
for business-hours calculations — everything an "approaching breach" KPI needs.

### Amber — reachable, but the data is thin

| KPI | Measurement |
|---|---|
| Incident → CI | **183 of 36,030** incidents have a CI (0.5%) |
| Incident → business service | 4,809 of 36,030 (13%) |
| Incident → assignment group | 27,690 of 36,030 (77%) — usable |
| Vulnerable items by risk | 91 items, `risk_score = 0` on every sampled row; `sn_vul_entry` (CVE catalogue) is **empty** |
| Alerts | `em_alert` 88 rows, 2 active |
| Events | `em_event` 105 rows |
| Dependency / service maps | 259 relationships across 3,452 CIs; `cmdb_ci_service_discovered` has **1 record** |
| Application count | 3 |
| MTTR | computable, but 19% of resolved incidents have zero duration (see §5) |

The 0.5% CI linkage explains why Application 360 → Operational Metrics shows
*Open Incidents 0* and *No data available*: those widgets are scoped to an
application, and almost nothing is linked to one.

### Red — not present in this instance

Uptime · latency · synthetic checks · SLO breaches · CI health telemetry.

Every installed table matching `metric` / `synthetic` / `availability` /
`latency` was checked. The hits are platform internals — discovery probe
timings, Virtual Agent click metrics, license metrics, transaction logs.
`cmdb_health_metric` is CMDB *data quality*, not CI health.

**"Server Utilization — Memory / CPU" on the CIO tab is mislabeled.** It plots
the static CMDB `ram` field. A sample returned 128, 2048, 2048, 8192, 8192 —
exactly the chart's legend values — with every row stamped
`2026-08-18 13:15:05`. That is a bulk load of hardware capacity, not
utilization telemetry. Nothing is being measured over time.

Observability data must come from the client's monitoring stack (Dynatrace,
Datadog, AppDynamics). It does not enter ServiceNow without ITOM Health or an
equivalent integration.

---

## 3. Hidden definitions

**The live API is the source of truth. The screenshots are not.**

The dashboard figures below were captured at one moment; the instance moves
continuously. Chasing exact agreement between a screenshot and a live query is
meaningless, and no KPI should ever be validated that way. NowOps and the
chatbot both read live.

The comparison is recorded for one narrow purpose: some gaps are far too large
to be elapsed time, and those reveal that a tile's label does not define its
query.

| KPI | Screenshot | Live API | Reading |
|---|---|---|---|
| Total Tickets | 36,023 | 36,030 | drift — 7 tickets |
| Open Tickets | 5,390 | 5,513 | drift |
| Closed Tickets | 30,016 | 29,911 | drift |
| Cancelled Tickets | 616 | 616 | — |
| Security Incidents | 246 | 246 | — |
| Orphaned CIs | 3.45K | 3,452 | — |
| Alerts count | 4 | 2 | drift (tiny population) |
| Open Problems | 28 | 48 | **definition** |
| Open Changes | 84 | 106 | **definition** |
| Vulnerable Items | 70 | 91 | **definition** |
| Backlog Incidents | 1,292 | 5,377 | **definition** |

Backlog is the instructive one. A 4× gap is not two days of ticket flow. The
stored definition turns out to be:

```
active=true^u_past_incidentsISNOTEMPTY^stateIN2
^assigned_toISNOTEMPTY^priorityNOT IN1,5
```

It requires UST's custom `u_past_incidents` field to be populated, requires an
assignee, and excludes P1 and P5. That filter is not inferable from the tile's
label.

### The consequence

**Access is not the constraint. Definition is.**

Every table was reachable; no query returned a permission error. What is not
reachable by guessing is the *meaning* of a tile. "Open" in one widget is not
"open" in another, and the QBR tabs expose five more filters on top.

So the target for any KPI the chatbot answers is a **live** number computed
from the **same definition** NowOps uses — never a value matched against a
screenshot. Values go stale; definitions do not. Section 8 of the chatbot spec
follows from this: read the stored definition rather than reconstruct it.

### 3.1 The definitions are stored and readable

`sys_report` holds **963 saved reports**, each carrying `table`, `aggregate`,
`field` and the literal `filter`. Every KPI definition behind the dashboards can
be read rather than guessed:

```
Backlog Incidents Count
  incident / COUNT / active=true^u_past_incidentsISNOTEMPTY^stateIN2
                     ^assigned_toISNOTEMPTY^priorityNOT IN1,5

SLA Adherence% Trend (Resolution) - P1
  task_sla / COUNT / sla=35420982d732220035ae23c7ce610393^stage=completed
                     ^sla.type=SLA^has_breached=false^task.sys_class_name=incident

Ticket Volume by Priority
  incident / COUNT / active=true^stateIN1,2,3
```

Executing a stored filter against `/api/now/stats/<table>` yields a live number
computed the way NowOps computes it.

**Properties of the 963 that matter for automation:**

```
GROUPBY (series, not a scalar)   383
javascript: date functions        340   (fine - evaluated server-side)
DYNAMIC (per-user) filters         25   (must be excluded)
no filter at all                  108
```

The 25 `DYNAMIC` reports resolve against the *calling* user. "Security Incidents
Assigned to me" executed by a service account returns the service account's
number, confidently and wrongly. Exclude them.

**Near-duplicate titles carry different filters:**

```
SLA Adherence% Trend (Resolution) - P4   ...^sys_created_on>=2022-01-01
SLA Adherence% Trend (Resolution)-P4     ...^task.sys_class_name=incident
```

Same apparent name, different answers — the same uniqueness problem that forced
sys_id keying for KB articles (D10). Reports must be keyed by sys_id too.

**Some stored definitions are wrong.** `Tickets Approaching SLA Breach - P1` is
`task / MAX / active=true^opened_at<gs.beginningOfLast6Months()^priority=1` — it
never touches `task_sla`, so it measures stale tickets, not imminent breaches.
The four MTTR reports use four different time windows (P1 last 2 quarters, P2
this year, P3/P4 last 2 years), so those charts are not comparable with one
another.

Anything executing stored definitions faithfully will reproduce these faults
faithfully. Surfacing the filter alongside the number is what lets a reader
notice.

---

## 4. SLA position

```
task_sla completed, not breached : 25,448
task_sla completed, breached     :  8,054
task_sla in progress             : 16,395
```

Naive adherence = 25,448 / 33,502 = **76%**. The dashboard gauge reads **87%**,
so its denominator differs (likely incident-SLA only, or a date window). Either
figure is defensible; they answer different questions. Pin the definition before
publishing a number.

---

## 5. MTTR is usable

Sample of 111 resolved incidents, `resolved_at - opened_at`:

```
negative duration :  0
zero duration     : 21   (19% - opened and resolved in the same second)
positive duration : 90   mean 4.9 hours
```

`resolved_at` is sound. `closed_at` is not — at least one incident carries a
`closed_at` eleven months before its `opened_at`.

The QBR dashboard's **negative** MTTR values (−3,575, −2,917, −2,060) are
therefore a widget defect, not a data defect. The underlying data yields a sane
mean. The 19% zero-duration population will bias any average downward and should
be excluded or investigated.

---

## 6. Known-broken widgets

Worth knowing before anyone treats these as a reference implementation:

- **QBR → SLA Adherence:** *Closed Tickets within SLA* reads **0** beside a
  gauge reading **87%**. Contradictory within a single tab.
- **QBR → MTTR:** negative values across P1, P2 and P4.
- **App360 → Operational Metrics:** *Open Incidents 0* / *Open P1 0* while the
  instance holds 5,513 open and 14 open P1. Consequence of the 0.5% CI linkage.
- **App360 → CIO:** "Server Utilization" is static capacity (§2).
- **App360 → Security:** map reports *"Some of the data you selected cannot be
  visualized on the map due to mapping errors."*

---

## 7. Gaps that need a decision before NowOps

1. **No acknowledgement timestamp.** `task` provides `opened_at`, `closed_at`,
   `work_start`, `work_end`, `due_date`; `incident` adds `resolved_at` and
   `reopened_time`. There is no ack field anywhere on `incident` or `task`. An
   open → **ack** → resolve → close chain needs ack derived from state history
   or added as a field.
2. **CMDB linkage.** A service-mapped NowOps is not achievable at 0.5% incident
   → CI linkage. This is a data-remediation project, not a build task.
3. **Vulnerability severity.** Records exist, severity does not.
4. **Observability.** Must be sourced externally; scope it as an integration.
5. **KPI definitions.** Each published number needs an owner and a written
   filter, or NowOps will disagree with the dashboard it replaces.

---

## 8. Reproducing this

Counts use the aggregate endpoint:

```
GET /api/now/stats/<table>?sysparm_count=true&sysparm_query=<encoded query>
  -> result.stats.count
```

Queries used for the figures above:

| Figure | Table | `sysparm_query` |
|---|---|---|
| Total incidents | `incident` | *(none)* |
| Open incidents | `incident` | `active=true` |
| Open P1 | `incident` | `active=true^priority=1` |
| SLA breached | `task_sla` | `has_breached=true` |
| SLA met (completed) | `task_sla` | `stage=completed^has_breached=false` |
| Incidents with a CI | `incident` | `cmdb_ciISNOTEMPTY` |
| Security incidents | `sn_si_incident` | `active=true` |
| Published KB articles | `kb_knowledge` | `workflow_state=published` |

Table availability was probed with the same endpoint; a missing or unlicensed
table returns an HTTP error rather than a count. Field availability came from
`sys_dictionary` — note that querying `name=incident` returns only fields
defined **on** `incident`, not those inherited from `task`, which is why
`opened_at` and `closed_at` appear absent unless `name=task` is queried too.

### Corpus sizes at time of measurement

```
incident                     36,030      task_sla                50,197
  active                      5,513        breached              23,429
  priority 1 (active)            14        active                17,275
sn_si_incident                1,023      cmdb_ci                  3,452
sc_req_item                     831      cmdb_rel_ci                259
change_request                  158      cmdb_ci_service             44
problem                         149      cmdb_ci_service_discovered    1
alm_asset                     3,457      sn_vul_vulnerable_item      91
alm_hardware                  1,412      sn_vul_entry                 0
kb_knowledge (published)        732      em_event / em_alert     105 / 88
```

---

## 9. Relationship to the chatbot

The chatbot specified in
[`specs/2026-09-13-nowops-chatbot-design.md`](superpowers/specs/2026-09-13-nowops-chatbot-design.md)
answers **only** from published knowledge articles. None of the KPIs here are
reachable through it, by design.

Answering them requires a second retrieval mode — intent routing, a constrained
query layer where the model selects from validated query shapes rather than
emitting raw `sysparm_query`, numeric answer formatting, deep-links to the
filtered list for verification, and an eval measuring numeric exactness rather
than recall@k. Section 3 is the argument for the constraint: a wrong count reads
exactly as confidently as a right one.
