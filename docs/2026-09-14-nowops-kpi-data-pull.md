# NowOps KPI data pull — abhrademo4

**Pulled:** 2026-09-14 10:27 UTC · **Method:** read-only `/api/now/stats/` aggregates over OAuth · **Source of definitions:** `sys_report` where a stored tile definition exists ("house"), otherwise a plain composed query ("composed").

## Findings that matter

- **Every green KPI in the inventory is reachable and computed below**, house definition and composed query side by side. No query returned a permission error.
- **"Open" is ambiguous on this instance.** `active=true` (5,513) includes 111 Resolved incidents and a few Closed/Cancelled rows whose active flag was never cleared. The App360 tiles use `stateIN1,2`; the composed queries use `active=true`. Neither is wrong; they must be labelled.
- **ServiceNow silently drops a filter clause whose field does not exist** and returns the whole table with HTTP 200. The three licence-type tiles (Perpetual / Upgrade / Subscription = 202 each) are this failure: `product_type` is not a column here. The chatbot now validates field names before counting for exactly this reason.
- **Broken stored definitions, reproduced not corrected:** Application/Servers/Databases counts count *relationships* not CIs (3 vs 22 applications, 79 vs 625 servers); "Closed Tickets within SLA" adds a close-notes text match and reads 0 (composed: 25,248); "Tickets Approaching SLA Breach" counts stale tasks and never reads task_sla; "TCO per Application" counts apps with zero cost; the four MTTR reports use four windows; the Backlog Beacon definition names a field (`u_past_incidents`) that does not exist here, so it returns 1,292 unfiltered where the real UST field gives 239.
- **Not present on the instance:** uptime, latency, synthetic checks, CI health telemetry, discovered cloud resources (0), CVE catalogue (`sn_vul_entry` = 0), vulnerability severity (every `sn_vul_vulnerable_item` has risk 0 / None), application install type and category (all empty), incident cause code (`cause` empty; house uses `close_code`), CMDB Health orphan results (0 rows — the health job has not run). "Server Utilization" is static RAM/CPU capacity.
- **The data is demo data loaded in bursts.** June and September 2026 carry most of the volume (33k SLAs created in June; 8,356 incidents opened in September). Monthly trends describe the load pattern, not operations.

Values drift continuously; treat them as a snapshot. Where the house definition and the composed query disagree, both are shown — the difference is the definition, not an error. Broken stored definitions are called out rather than corrected.

## 1. Application 360 — Operational Metrics

| Tile | Table | Filter | Live value | Note |
|---|---|---|---:|---|
| Open Incidents (composed) | `incident` | `active=true` | **5,513** |  |
| Open Incidents (house, App360) | `incident` | `sys_created_onONLast 6 months@javascript:gs.beginningOfLast6Months()@javascript:gs.endOfLast6Months()^stateIN1,2` | **5,236** | house tile counts only New/In Progress created in last 6 months |
| Open P1 Incidents (composed) | `incident` | `active=true^priority=1` | **14** |  |
| Open P1 Incidents (house) | `incident` | `priority=1^resolved_atISEMPTY^active=true` | **7** | 7 of the 14 active P1s carry a resolved_at — on this instance Resolved (state 6) incidents stay active=true, so "open" is ambiguous |
| Unassigned Requests (composed) | `sc_req_item` | `active=true^assigned_toISEMPTY` | **107** |  |
| Unassigned Requests (house) | `sc_req_item` | `sys_created_onONLast 6 months@javascript:gs.beginningOfLast6Months()@javascript:gs.endOfLast6Months()^assignment_groupISEMPTY` | **268** | house = no assignment *group*, last 6 months |
| Total Requests — sc_request | `sc_request` | `(none)` | **765** |  |
| Total Requests — sc_req_item | `sc_req_item` | `(none)` | **831** |  |
| Open Changes (composed) | `change_request` | `active=true` | **106** |  |
| Alerts count — em_alert (platform) | `em_alert` | `(none)` | **88** |  |
| Alerts count — em_alert active | `em_alert` | `active=true` | **88** |  |
| Alerts count (house) — x_ustgl_app360_event_alerts | `x_ustgl_app360_event_alerts` | `sys_created_onONLast 6 months@javascript:gs.beginningOfLast6Months()@javascript:gs.endOfLast6Months()` | **4** | UST custom table |
> ⚠ u_event_alerts · `(none)` → ServiceNow request failed (HTTP 400). {"error":{"message":"Invalid table u_event_alerts","detail":null},"status":"failure"}
| Alerts count (house alt) — u_event_alerts | `u_event_alerts` | `(none)` | **error** |  |
| Open Problems (composed) | `problem` | `active=true` | **48** |  |

**Open Incidents by Priority** — `incident` · `active=true` · COUNT GROUPBY `priority`

| priority | value |
|---|---:|
| 4 - Low | 5,375 |
| 2 - High | 90 |
| 3 - Moderate | 34 |
| 1 - Critical | 14 |

**Incident Count by Age & Priority (open incidents)** — `incident` · `active=true` · age buckets on `opened_at` × `priority`

| Age | 1 - Critical | 2 - High | 3 - Moderate | 4 - Low | Total |
|---|---:|---:|---:|---:|---:|
| 0-7 days | 3 | 24 | 11 | 1,166 | 1,204 |
| 7-30 days | 5 | 2 | 1 | 30 | 38 |
| 30-90 days | 0 | 49 | 10 | 2,267 | 2,326 |
| 90+ days | 6 | 15 | 12 | 1,912 | 1,945 |

**Priority-wise Incident Assigned (assignment group × priority, open incidents)** — `incident` · `active=true` · COUNT GROUPBY `assignment_group,priority` (top 20)

| assignment_group × priority | value |
|---|---:|
| (empty) × 4 - Low | 1,162 |
| Hardware × 4 - Low | 901 |
| Network × 4 - Low | 844 |
| Application Development × 4 - Low | 835 |
| Service Desk × 4 - Low | 812 |
| Database × 4 - Low | 808 |
| (empty) × 2 - High | 24 |
| Service Desk × 2 - High | 16 |
| Hardware × 2 - High | 13 |
| L2 - Shared Application Support × 4 - Low | 13 |
| Application Development × 2 - High | 12 |
| Database × 2 - High | 12 |
| Network × 2 - High | 12 |
| (empty) × 3 - Moderate | 11 |
| Database × 3 - Moderate | 6 |
| Application Development × 3 - Moderate | 5 |
| Hardware × 3 - Moderate | 5 |
| Network × 1 - Critical | 5 |
| Network × 3 - Moderate | 5 |
| Service Desk × 1 - Critical | 4 |

**Service Request Count by State — sc_request (house: last 6 months)** — `sc_request` · `sys_created_onONLast 6 months@javascript:gs.beginningOfLast6Months()@javascript:gs.endOfLast6Months()` · COUNT GROUPBY `state`

| state | value |
|---|---:|
| Closed Complete | 621 |
| Open | 113 |
| Closed Incomplete | 31 |

**Service Request Count by State — sc_request (all time)** — `sc_request` · `(none)` · COUNT GROUPBY `state`

| state | value |
|---|---:|
| Closed Complete | 621 |
| Open | 113 |
| Closed Incomplete | 31 |

**Open Changes by Priority** — `change_request` · `active=true` · COUNT GROUPBY `priority`

| priority | value |
|---|---:|
| 4 - Low | 40 |
| 3 - Moderate | 36 |
| 2 - High | 27 |
| 1 - Critical | 3 |

**Problems by State** — `problem` · `(none)` · COUNT GROUPBY `state`

| state | value |
|---|---:|
| Closed | 99 |
| Open | 19 |
| Resolved | 8 |
| New | 7 |
| Assess | 7 |
| Root Cause Analysis | 3 |
| Pending Info | 3 |
| Fix in Progress | 2 |
| Pending Change | 1 |

## 2. IT Configuration View

| Tile | Table | Filter | Live value | Note |
|---|---|---|---:|---|
| Application count (composed) — cmdb_ci_appl | `cmdb_ci_appl` | `(none)` | **22** |  |
| Application count (house) — relationships whose child is an application | `cmdb_rel_ci` | `child.sys_class_name=cmdb_ci_appl` | **3** | counts relationships, not applications |
| Business applications (APM) — cmdb_ci_business_app | `cmdb_ci_business_app` | `(none)` | **50** |  |
| Servers (composed) — cmdb_ci_server and subclasses | `cmdb_ci_server` | `(none)` | **625** |  |
| Servers (house) — relationships whose child is linux/win/web server | `cmdb_rel_ci` | `child.sys_class_name=cmdb_ci_linux_server^ORchild.sys_class_name=cmdb_ci_win_server^ORchild.sys_class_name=cmdb_ci_web_server` | **79** | counts relationships, not servers |
| Databases (composed) — cmdb_ci_database and subclasses | `cmdb_ci_database` | `(none)` | **17** |  |
| Databases (house) — relationships whose child is a database | `cmdb_rel_ci` | `child.sys_class_name=cmdb_ci_database` | **12** | counts relationships, not databases |
| All CI relationships | `cmdb_rel_ci` | `(none)` | **259** |  |

**Servers by class** — `cmdb_ci_server` · `(none)` · COUNT GROUPBY `sys_class_name`

| sys_class_name | value |
|---|---:|
| Server | 592 |
| Windows Server | 11 |
| Linux Server | 10 |
| UNIX Server | 10 |
| AIX Server | 2 |

**CI dependency maps** — named services and their relationship counts

| Service | Class | sys_id | as parent | as child |
|---|---|---|---:|---:|
| _(no service matching "BI Portal")_ | | | | |
| PeopleSoft Enterprise Services | cmdb_ci_service | 2fc86c650a0a0bb4003698b5331640df | 8 | 0 |
| PeopleSoft CRM | cmdb_ci_service | 2fca585e0a0a0bb400a949f8bb843712 | 5 | 1 |
| PeopleSoft Supply Chain Management | cmdb_ci_service | 2fcbe4120a0a0bb400195dc310cd2fb0 | 5 | 1 |
| PeopleSoft Asset Lifecycle Management | cmdb_ci_service | 2fcc36510a0a0bb4006d2cb951ac2a82 | 5 | 1 |
| PeopleSoft Financials | cmdb_ci_service | 2fccf1580a0a0bb400877808a2961ac6 | 5 | 1 |
| PeopleSoft HRMS | cmdb_ci_service | 2fcd6b5d0a0a0bb400ac2f4a7651e8d3 | 5 | 1 |
| PeopleSoft Portals | cmdb_ci_service | 2fce42d80a0a0bb4004af34d7e3984c8 | 5 | 1 |
| PeopleSoft Governance | cmdb_ci_service | 2fd0eab90a0a0bb40061cf732d32967c | 5 | 1 |
| PeopleSoft Reporting | cmdb_ci_service | 2fd114e10a0a0bb400f07732a4131e72 | 5 | 1 |
| SAP Enterprise Services | cmdb_ci_service | 26da329f0a0a0bb400f69d8159bc753d | 8 | 0 |
| _(no service matching "Administrations")_ | | | | |

## 3. Unified Software View

| Tile | Table | Filter | Live value | Note |
|---|---|---|---:|---|
| Software entitlements — alm_license (all) | `alm_license` | `(none)` | **202** |  |
| Perpetual License (house) | `alm_license` | `product_type=full` | **202** | **bogus** — product_type does not exist on alm_license here; ServiceNow silently dropped the clause and counted the whole table |
| Upgrade License (house) | `alm_license` | `product_type=upgrade` | **202** | same — whole table |
| Subscription License (house) | `alm_license` | `product_type=subscription` | **202** | same — whole table |
| Entitlements with active maintenance (house) | `alm_license` | `install_status=1` | **142** | house filter is install_status=1 (In stock) — not a maintenance field |

**Software Entitlement by State (install_status)** — `alm_license` · `(none)` · COUNT GROUPBY `install_status`

| install_status | value |
|---|---:|
| In use | 142 |
| In stock | 60 |

**Software Entitlement by State × License metric** — `alm_license` · `(none)` · COUNT GROUPBY `install_status,license_metric`

| install_status × license_metric | value |
|---|---:|
| In use × (empty) | 142 |
| In stock × (empty) | 60 |

**Entitlements by acquisition method (purchase / rental / lease …)** — `alm_license` · `(none)` · COUNT GROUPBY `acquisition_method`

| acquisition_method | value |
|---|---:|
| Purchase | 73 |
| Lease | 60 |
| Rental | 37 |
| Device as a Service | 21 |
| Loan | 10 |
| (empty) | 1 |

> `product_type` is not a column on `alm_license` on this instance, so the three licence-type tiles cannot be computed as defined. The nearest real field is `acquisition_method` above.

**Active v/s Purchase Rights** — sums over all entitlements

| Measure | Field | Value |
|---|---|---:|
| Purchased rights | `rights` | 1194359 |
> ⚠ alm_license · `(none)` → ServiceNow request failed (HTTP 400). {"error":{"message":"Aggregate Query Failed","detail":"Verify request query and ACLs"},"status":"failure"}
> ⚠ alm_license · `(none)` → ServiceNow request failed (HTTP 400). {"error":{"message":"Aggregate Query Failed","detail":"Verify request query and ACLs"},"status":"failure"}
| Total cost | `cost` | 32758066.2600 |

## 4. Security View

| Tile | Table | Filter | Live value | Note |
|---|---|---|---:|---|
| Security Incidents — all | `sn_si_incident` | `(none)` | **1,023** |  |
| Security Incidents — open (house) | `sn_si_incident` | `active=true` | **246** |  |
| Vulnerable Items — sn_vul_vulnerable_item | `sn_vul_vulnerable_item` | `(none)` | **91** |  |
| Vulnerable Items — active | `sn_vul_vulnerable_item` | `active=true` | **91** |  |
| Vulnerable Items (house) — sn_vul_app_vulnerable_item | `sn_vul_app_vulnerable_item` | `(none)` | **70** | application vulnerable items — a different table |
| Vulnerability entries (CVE catalogue) — sn_vul_entry | `sn_vul_entry` | `(none)` | **0** |  |
| Security incidents with a location (map) | `sn_si_incident` | `locationISNOTEMPTY` | **221** |  |

**Security Incidents Open > 30 days by Assignment Group × State** — `sn_si_incident` · `active=true^opened_at<javascript:gs.daysAgoStart(30)` · COUNT GROUPBY `assignment_group,state` (top 20)

| assignment_group × state | value |
|---|---:|
| SIRT × Analysis | 63 |
| SIRT × Contain | 4 |
| Application Security × Analysis | 3 |
| Application Security × Eradicate | 3 |
| SecOps APAC × Analysis | 3 |
| Directory Infrastructure Security × Recover | 2 |
| Forensics × Contain | 2 |
| SecOps APAC × Eradicate | 2 |
| SecOps EMEA × Analysis | 2 |
| SecOps EMEA × Contain | 2 |
| SecOps EMEA × Eradicate | 2 |
| SIRT × Eradicate | 2 |
| Unix Security × Analysis | 2 |
| Unix Security × Contain | 2 |
| Vulnerability Response × Eradicate | 2 |
| Vulnerability Response × Recover | 2 |
| Windows Security × Eradicate | 2 |
| Application Security × Recover | 1 |
| Directory Infrastructure Security × Analysis | 1 |
| Directory Infrastructure Security × Contain | 1 |

**Open Security Incidents by Age × Priority** — `sn_si_incident` · `active=true` · age buckets on `opened_at` × `priority`

| Age | 1 - Critical | 2 - High | 3 - Moderate | 4 - Low | Total |
|---|---:|---:|---:|---:|---:|
| 0-7 days | 0 | 0 | 0 | 0 | 0 |
| 7-30 days | 20 | 17 | 22 | 65 | 124 |
| 30-90 days | 0 | 0 | 0 | 0 | 0 |
| 90+ days | 37 | 4 | 6 | 75 | 122 |

**Security Incident by Priority (all)** — `sn_si_incident` · `(none)` · COUNT GROUPBY `priority`

| priority | value |
|---|---:|
| 1 - Critical | 500 |
| 4 - Low | 243 |
| 2 - High | 174 |
| 3 - Moderate | 106 |

**Security Incident by Priority (open)** — `sn_si_incident` · `active=true` · COUNT GROUPBY `priority`

| priority | value |
|---|---:|
| 4 - Low | 140 |
| 1 - Critical | 57 |
| 3 - Moderate | 28 |
| 2 - High | 21 |

**Security Incident Map — by location** — `sn_si_incident` · `locationISNOTEMPTY` · COUNT GROUPBY `location` (top 15)

| location | value |
|---|---:|
| Via Nomentana 56, Rome | 54 |
| 4193 University Avenue, San Diego,CA | 43 |
| 147 Quigley Boulevard, New Castle,DE | 30 |
| 450 Lexington Avenue, New York,NY | 24 |
| 322 West 52nd Street, New York,NY | 19 |
| Bockenheimer Landstraße 123, Frankfurt | 17 |
| 5052 Clairemont Drive, San Diego,CA | 10 |
| 9201 University City Boulevard, Charlotte,NC | 9 |
| 150 Kennedy Road, Hong Kong | 3 |
| 4492 Camino De La Plaza, San Ysidro,CA | 3 |
| San Diego | 3 |
| 2-10-1 Yurakucho, Chiyoda-ku, Tokyo | 2 |
| 13308 Midland Road, Poway,CA | 1 |
| 243 South Escondido Boulevard, Escondido,CA | 1 |
| 3121 High Point Road, Greensboro,NC | 1 |

**Vulnerable Items by Risk — risk_rating** — `sn_vul_vulnerable_item` · `(none)` · COUNT GROUPBY `risk_rating`

| risk_rating | value |
|---|---:|
| 5 - None | 91 |

**Vulnerable Items by Risk — risk_score** — `sn_vul_vulnerable_item` · `(none)` · COUNT GROUPBY `risk_score`

| risk_score | value |
|---|---:|
| 0 | 91 |

**Vulnerable Items by Risk (house table) — sn_vul_app_vulnerable_item.risk_rating** — `sn_vul_app_vulnerable_item` · `(none)` · COUNT GROUPBY `risk_rating`

| risk_rating | value |
|---|---:|
| 5 - None | 63 |
| 4 - Low | 4 |
| 3 - Medium | 2 |
| 2 - High | 1 |

**Services with Security Incidents by Criticality (house, task_cmdb_ci_service)** — `task_cmdb_ci_service` · `task.sys_class_name=sn_si_incident^cmdb_ci_service.sys_class_name=cmdb_ci_service` · COUNT GROUPBY `cmdb_ci_service.busines_criticality`

| cmdb_ci_service.busines_criticality | value |
|---|---:|
| (empty) | 521 |

**Services with open Security Incidents — by service** — `task_cmdb_ci_service` · `task.sys_class_name=sn_si_incident^task.active=true` · COUNT GROUPBY `cmdb_ci_service`

_no rows_

**Security incidents by business_criticality (field on sn_si_incident)** — `sn_si_incident` · `active=true` · COUNT GROUPBY `business_criticality`

| business_criticality | value |
|---|---:|
| 3 - Non-critical | 124 |
| 2 - High | 89 |
| 1 - Critical | 33 |

## 5. Incident SLA Performance

| Tile | Table | Filter | Live value | Note |
|---|---|---|---:|---|
| SLA Breach Count P1 & P2 (composed) | `task_sla` | `has_breached=true^task.sys_class_name=incident^task.priorityIN1,2` | **9,182** |  |
| SLA Breach Count P1 & P2 (house, incident_sla view) | `incident_sla` | `inc_priorityIN1,2^taskslatable_has_breached=true` | **9,182** | house report filters only inc_priorityIN1,2 — no breach clause; breach clause added here |
| SLA Breach Count P5 (composed) | `task_sla` | `has_breached=true^task.sys_class_name=incident^task.priority=5` | **33** |  |
| SLA Breach Count P5 (house) | `incident_sla` | `inc_priority=5^taskslatable_has_breached=true` | **33** |  |
| All breached SLAs | `task_sla` | `has_breached=true` | **23,429** |  |
| Breached SLAs on incidents | `task_sla` | `has_breached=true^task.sys_class_name=incident` | **23,258** |  |

**Monthly SLA Violation Trend (breached SLAs created per month)** — last 6 calendar months, by `task_sla.sys_created_on`, `task_sla.sys_created_on`, `task_sla.sys_created_on`

| Month | breached (all) | breached (incident) | all SLAs created |
|---|---:|---:|---:|
| 2026-04 | 397 | 397 | 397 |
| 2026-05 | 500 | 500 | 500 |
| 2026-06 | 14,994 | 14,910 | 32,998 |
| 2026-07 | 80 | 80 | 188 |
| 2026-08 | 5,832 | 5,823 | 6,011 |
| 2026-09 | 32 | 32 | 8,415 |

**Monthly SLA Violation by Support Group (breached, last 6 months)** — `task_sla` · `has_breached=true^sys_created_on>=javascript:gs.monthsAgoStart(5)` · COUNT GROUPBY `task.assignment_group`

| task.assignment_group | value |
|---|---:|
| Network | 5,499 |
| Hardware | 4,938 |
| Application Development | 4,330 |
| Database | 3,719 |
| Service Desk | 3,235 |
| SIRT | 93 |
| L2 - Shared Application Support | 16 |
| (empty) | 3 |
| Application Support | 2 |

**SLA Breach Status — stage × has_breached (all task_sla)** — `task_sla` · `(none)` · COUNT GROUPBY `stage,has_breached`

| stage × has_breached | value |
|---|---:|
| false × Completed | 25,448 |
| true × In progress | 15,209 |
| true × Completed | 8,054 |
| false × In progress | 1,186 |
| true × Cancelled | 156 |
| false × Paused | 100 |
| false × Cancelled | 33 |
| true × Paused | 8 |
| true × Breached | 2 |
| false × Achieved | 1 |

**SLA Breach Status — in-progress incident SLAs by breach (house, last 30 days)** — `task_sla` · `stage=in_progress^task.sys_class_name=incident^sla.type=SLA^sys_created_onONLast 30 days@javascript:gs.beginningOfLast30Days()@javascript:gs.endOfLast30Days()` · COUNT GROUPBY `has_breached`

| has_breached | value |
|---|---:|
| true | 4,409 |
| false | 1,106 |

## 6. CMDB Health & Integrity

| Tile | Table | Filter | Live value | Note |
|---|---|---|---:|---|
| All CIs | `cmdb_ci` | `(none)` | **3,452** |  |
| Orphan CIs (house) — cmdb_health_result rows for the orphan metric | `cmdb_health_result` | `metric=c6272b5137130200f212cc028e41f168^active=true` | **0** | CMDB Health job output |
| CIs updated in last 30 days | `cmdb_ci` | `sys_updated_onONLast 30 days@javascript:gs.beginningOfLast30Days()@javascript:gs.endOfLast30Days()` | **520** |  |
| Discovered cloud resources (composed) — cloud classes + VM instances | `cmdb_ci` | `sys_class_nameSTARTSWITHcmdb_ci_cloud^ORsys_class_name=cmdb_ci_vm_instance^ORsys_class_nameSTARTSWITHcmdb_ci_aws^ORsys_class_nameSTARTSWITHcmdb_ci_azure` | **0** |  |
| CIs with a location | `cmdb_ci` | `locationISNOTEMPTY` | **905** |  |

**Orphan CIs by class (house)** — `cmdb_health_result` · `metric=c6272b5137130200f212cc028e41f168^active=true` · COUNT GROUPBY `class_name`

_no rows_

**CIs updated in last 30 days by class** — `cmdb_ci` · `sys_updated_onONLast 30 days@javascript:gs.beginningOfLast30Days()@javascript:gs.endOfLast30Days()` · COUNT GROUPBY `sys_class_name`

| sys_class_name | value |
|---|---:|
| Server | 500 |
| Computer | 6 |
| Manual Endpoint | 6 |
| ServiceNow Application Component | 5 |
| Configuration Item | 1 |
| ServiceNow Application | 1 |
| Mapped Application Service | 1 |

**CIs by discovery source** — `cmdb_ci` · `(none)` · COUNT GROUPBY `discovery_source`

| discovery_source | value |
|---|---:|
| (empty) | 3,381 |
| Other Automated | 50 |
| SNAssetManagement | 9 |
| EventManagement | 6 |
| ServiceWatch | 6 |

**Discovered cloud resources by class** — `cmdb_ci` · `sys_class_nameSTARTSWITHcmdb_ci_cloud^ORsys_class_name=cmdb_ci_vm_instance^ORsys_class_nameSTARTSWITHcmdb_ci_aws^ORsys_class_nameSTARTSWITHcmdb_ci_azure` · COUNT GROUPBY `sys_class_name`

_no rows_

**Portfolio Overview — CIs by class** — `cmdb_ci` · `(none)` · COUNT GROUPBY `sys_class_name` (top 20)

| sys_class_name | value |
|---|---:|
| Software | 1,767 |
| Computer | 823 |
| Server | 592 |
| Business Application | 50 |
| Service | 42 |
| Printer | 28 |
| Database | 17 |
| Windows Cluster Node | 14 |
| Windows Server | 11 |
| Linux Server | 10 |
| UNIX Server | 10 |
| Web Server | 9 |
| Configuration Item | 6 |
| Manual Endpoint | 6 |
| UPS | 6 |
| ServiceNow Application Component | 5 |
| Email Server | 5 |
| Network Gear | 5 |
| Rack | 5 |
| Data Center Zone | 5 |

**Configuration Item by Location** — `cmdb_ci` · `locationISNOTEMPTY` · COUNT GROUPBY `location` (top 15)

| location | value |
|---|---:|
| 3 Whitehall Court, London | 79 |
| 27, Boulevard Vitton, Paris | 78 |
| 615 North Bush Street, Santa Ana,CA | 50 |
| Bockenheimer Landstraße 123, Frankfurt | 49 |
| Paradise Road, Richmond, London | 42 |
| 2-10-1 Yurakucho, Chiyoda-ku, Tokyo | 38 |
| Via Nomentana 56, Rome | 36 |
| 815 E Street, San Diego,CA | 33 |
| 30 Katharinenstr, Hamburg | 32 |
| 8306 Mills Drive, Miami,FL | 30 |
| Bockenheimer Landstraße 223, Frankfurt | 28 |
| Karmelitska 2, Lesser Town, Prague | 26 |
| 2500 West Daming Road, Shanghai | 25 |
| 2-12-1 Ookayama, Meguro-ku, Tokyo | 24 |
| 815 E Street, San Diego,CA | 24 |

## 7. Application Portfolio Management

**Application lifecycle stage (house)** — `cmdb_ci_business_app` · `active=true^life_cycle_stageISNOTEMPTY` · COUNT GROUPBY `life_cycle_stage`

| life_cycle_stage | value |
|---|---:|
| Design | 6 |
| End of Life | 2 |
| Deploy | 1 |
| End of Operation | 1 |
| Ideation | 1 |
| Inventory | 1 |
| Operational | 1 |

**Application lifecycle stage × status** — `cmdb_ci_business_app` · `active=true` · COUNT GROUPBY `life_cycle_stage,life_cycle_stage_status`

| life_cycle_stage × life_cycle_stage_status | value |
|---|---:|
| (empty) × (empty) | 37 |
| Design × Build | 3 |
| Design × Chartered | 2 |
| Deploy × Test | 1 |
| Design × Design | 1 |
| End of Life × Recalled | 1 |
| End of Life × Retired | 1 |
| End of Operation × Pending Return | 1 |
| Ideation × Under Evaluation | 1 |
| Inventory × Available | 1 |
| Operational × In Repair | 1 |

**Applications by install type (EUC / COTS / SaaS / Homegrown)** — `cmdb_ci_business_app` · `(none)` · COUNT GROUPBY `install_type`

| install_type | value |
|---|---:|
| (empty) | 50 |

**TCO per install type — SUM(cost)** — `cmdb_ci_business_app` · `(none)` · SUM(cost) GROUPBY `install_type`

| install_type | value |
|---|---:|
| (empty) | 42,191 |

**TCO — applications by cost bucket** — `cmdb_ci_business_app` · `(none)` · COUNT GROUPBY `cost`

| cost | value |
|---|---:|
| 765 | 33 |
| 1,056 | 16 |
| 50 | 1 |

> House "TCO PerApplication" report is `COUNT(cost_center)` with filter `cost=0` — it counts applications with **no** cost, which is not a TCO.

## 8. CIO-Level Strategic Insights

| Tile | Table | Filter | Live value | Note |
|---|---|---|---:|---|
| Servers with a warranty date | `cmdb_ci_server` | `warranty_expirationISNOTEMPTY` | **96** |  |
| Warranty expired | `cmdb_ci_server` | `warranty_expiration<javascript:gs.beginningOfToday()` | **75** |  |
| Warranty expiring in 0–90 days | `cmdb_ci_server` | `warranty_expiration>=javascript:gs.beginningOfToday()^warranty_expiration<javascript:gs.daysAgoStart(-90)` | **21** |  |
| Warranty expiring in 90–365 days | `cmdb_ci_server` | `warranty_expiration>=javascript:gs.daysAgoStart(-90)^warranty_expiration<javascript:gs.daysAgoStart(-365)` | **0** |  |
| Warranty expiring after 365 days | `cmdb_ci_server` | `warranty_expiration>=javascript:gs.daysAgoStart(-365)` | **0** |  |
| Servers with no warranty date | `cmdb_ci_server` | `warranty_expirationISEMPTY` | **529** |  |

**Server "Utilization – Memory" (house: COUNT by static `ram` MB — capacity, not utilization)** — `cmdb_ci_server` · `ramISNOTEMPTY` · COUNT GROUPBY `ram`

| ram | value |
|---|---:|
| 2,048 | 78 |
| 8,192 | 68 |
| 128 | 66 |
| 10,000 | 65 |
| 1,024 | 64 |
| 4,000 | 59 |
| 4,096 | 53 |
| -1 | 11 |

**Server "Utilization – CPU" (house: COUNT by static `cpu_count` — capacity, not utilization)** — `cmdb_ci_server` · `cpu_countISNOTEMPTY` · COUNT GROUPBY `cpu_count`

| cpu_count | value |
|---|---:|
| 1 | 68 |
| 12 | 40 |
| 4 | 39 |
| 8 | 39 |
| 6 | 38 |
| 24 | 38 |
| 16 | 37 |
| 2 | 36 |
| 32 | 30 |

> No utilization telemetry exists on the instance. Both tiles plot CMDB capacity fields (see KPI inventory §2).

## 9. SDM QBR — Engagement Metrics: Volume

| Tile | Table | Filter | Live value | Note |
|---|---|---|---:|---|
| Total Tickets (house: all incidents) | `incident` | `(none)` | **36,030** |  |
| Closed Tickets (house: Resolved + Closed) | `incident` | `stateIN6,7` | **30,022** |  |
| Open Tickets (active) | `incident` | `active=true` | **5,513** |  |
| On-Hold Tickets (house) | `incident` | `state=3` | **1** |  |
| Cancelled Tickets (house) | `incident` | `state=8` | **616** |  |
| All task records (incidents + requests + changes + problems + …) | `task` | `(none)` | **43,571** |  |

**Ticket Volume — Incident vs Service Request, monthly (created)** — last 6 calendar months, by `incident.opened_at`, `sc_request.opened_at`, `sc_req_item.opened_at`

| Month | incidents | requests (sc_request) | request items (sc_req_item) |
|---|---:|---:|---:|
| 2026-04 | 5,970 | 0 | 0 |
| 2026-05 | 3,865 | 0 | 0 |
| 2026-06 | 4,931 | 227 | 240 |
| 2026-07 | 177 | 231 | 227 |
| 2026-08 | 71 | 81 | 131 |
| 2026-09 | 8,356 | 225 | 228 |

**Ticket Volume by State** — `incident` · `(none)` · COUNT GROUPBY `state`

| state | value |
|---|---:|
| Closed | 29,911 |
| In Progress | 5,377 |
| Canceled | 616 |
| Resolved | 111 |
| New | 10 |
| Cancelled | 3 |
| On Hold | 1 |
| (15) | 1 |

**Ticket Volume by Priority (all)** — `incident` · `(none)` · COUNT GROUPBY `priority`

| priority | value |
|---|---:|
| 4 - Low | 13,513 |
| 2 - High | 10,412 |
| 1 - Critical | 8,146 |
| 3 - Moderate | 3,125 |
| 5 - Planning | 834 |

**Ticket Volume by Priority (house: active, state New/In Progress/On Hold)** — `incident` · `active=true^stateIN1,2,3` · COUNT GROUPBY `priority`

| priority | value |
|---|---:|
| 4 - Low | 5,301 |
| 2 - High | 57 |
| 3 - Moderate | 23 |
| 1 - Critical | 6 |

**Ticket Volume by Cause Code (house uses close_code)** — `incident` · `(none)` · COUNT GROUPBY `close_code` (top 12)

| close_code | value |
|---|---:|
| Solved (Permanently) | 33,617 |
| (empty) | 1,826 |
| Resolved By AURA | 280 |
| Solved Remotely (Permanently) | 78 |
| Solved Remotely | 71 |
| Code Fixed | 46 |
| Bug Fixed via Hotfix/Patch | 18 |
| Resolved | 16 |
| Cleared Cache/Temporary Files | 12 |
| No Action Taken | 12 |
| Closed/Resolved by Caller | 11 |
| Configuration Drift Fixed | 5 |

**Ticket Volume by Cause (field `cause`)** — `incident` · `causeISNOTEMPTY` · COUNT GROUPBY `cause`

_no rows_

**Ticket Volume by Support Group** — `incident` · `(none)` · COUNT GROUPBY `assignment_group`

| assignment_group | value |
|---|---:|
| (empty) | 8,340 |
| Hardware | 6,301 |
| Network | 6,162 |
| Application Development | 5,073 |
| Service Desk | 5,069 |
| Database | 5,067 |
| L2 - Shared Application Support | 17 |
| Application Support | 1 |

**Ticket Volume by Location** — `incident` · `locationISNOTEMPTY` · COUNT GROUPBY `location` (top 15)

| location | value |
|---|---:|
| San Diego | 1,089 |
| South Carolina | 1,086 |
| Minnesota | 1,079 |
| South Africa | 1,074 |
| Mexico | 1,070 |
| Sydney | 1,067 |
| Switzerland | 1,054 |
| India | 1,052 |
| Paris | 1,050 |
| Rome | 1,043 |
| Frankfurt | 1,037 |
| Japan | 1,035 |
| Stafford | 1,020 |
| Tokyo | 1,016 |
| (empty) | 123 |

**Ticket Volume by Application (UST field x_ustgl_ust_app_su_applicationa)** — `incident` · `(none)` · COUNT GROUPBY `x_ustgl_ust_app_su_applicationa`

| x_ustgl_ust_app_su_applicationa | value |
|---|---:|
| (empty) | 36,030 |

**Ticket Volume by Business Service (referenced services do not resolve to a display name — dangling references)** — `incident` · `business_serviceISNOTEMPTY` · COUNT GROUPBY `business_service.name`

| business_service.name | value |
|---|---:|
| (empty) | 4,800 |
| SAP Application Configuration | 6 |
| SAP Enterprise Services | 2 |
| Email | 1 |

## 10. SDM QBR — SLA Adherence

| Tile | Table | Filter | Live value | Note |
|---|---|---|---:|---|
| Closed Tickets within SLA (composed: completed incident resolution SLAs, not breached) | `task_sla` | `stage=completed^has_breached=false^sla.type=SLA^task.sys_class_name=incident` | **25,248** |  |
| Closed Tickets within SLA (house) | `task_sla` | `has_breached=false^task.sys_class_name=incident^sla.type=SLA^stage=completed^task.close_notes=Resolved. No further action required` | **0** | house adds a close_notes text match — this is why the dashboard tile reads 0 |
| Completed incident SLAs (denominator) | `task_sla` | `stage=completed^sla.type=SLA^task.sys_class_name=incident` | **32,537** |  |

**SLA Adherence % (Resolution)** — completed incident SLAs, `has_breached=false` ÷ all completed, per SLA definition (house keys each gauge on an SLA sys_id)

| Gauge | SLA filter | Met | Completed | Adherence |
|---|---|---:|---:|---:|
| ALL | `sla.type=SLA` | 25,248 | 32,537 | 77.6% |
| P1 | `sla=35420982d732220035ae23c7ce610393` | 4,785 | 6,905 | 69.3% |
| P2 | `sla=af420982d732220035ae23c7ce6103f3` | 6,669 | 9,468 | 70.4% |
| P3 | `sla=d1524982d732220035ae23c7ce61035d` | 2,195 | 3,086 | 71.1% |
| P4 | `sla=b12a37e0d7322200f2d224837e6103ea` | 11,556 | 13,011 | 88.8% |

**SLA Adherence % by incident priority** (composed: `task.priority` instead of SLA sys_id)

| Priority | Met | Completed | Adherence |
|---|---:|---:|---:|
| P1 | 4,787 | 6,907 | 69.3% |
| P2 | 6,670 | 9,468 | 70.4% |
| P3 | 2,195 | 3,084 | 71.2% |
| P4 | 11,419 | 12,871 | 88.7% |
| P5 | 177 | 207 | 85.5% |

**SLA Adherence monthly trend (completed incident SLAs by created month)** — last 6 calendar months, by `task_sla.sys_created_on`, `task_sla.sys_created_on`

| Month | met | breached |
|---|---:|---:|
| 2026-04 | 0 | 189 |
| 2026-05 | 0 | 216 |
| 2026-06 | 17,957 | 6,130 |
| 2026-07 | 108 | 0 |
| 2026-08 | 43 | 99 |
| 2026-09 | 7,140 | 2 |

## 11. SDM QBR — MTTR

**Mean Time To Resolve** — `AVG(calendar_duration)` on resolved/closed incidents (`stateIN6,7`), per priority. House reports use four different time windows (P1 last 2 quarters, P2 this year, P3/P4 last 2 years), shown alongside.

| Priority | Composed (all resolved) | n | House window | House value | n |
|---|---:|---:|---|---:|---:|
| P1 | 354 08:06:46 | 7,521 | `opened_atONLast 2 quarters` | 18:53:15 | 216 |
| P2 | 1 04:07:28 | 10,355 | `opened_atONThis year` | 01:59:11 | 6,994 |
| P3 | 5 21:32:57 | 3,102 | `opened_atBETWEENjavascript:gs.beginningOfLast2Years()` | 01:12:55 | 3,100 |
| P4 | 1 23:31:53 | 8,211 | `opened_atBETWEENjavascript:gs.beginningOfLast2Years()` | 18:30:10 | 8,208 |

**MTTR inputs — resolved incidents per month** — last 6 calendar months, by `incident.resolved_at`

| Month | resolved |
|---|---:|
| 2026-04 | 4,218 |
| 2026-05 | 2,838 |
| 2026-06 | 794 |
| 2026-07 | 104 |
| 2026-08 | 211 |
| 2026-09 | 7,238 |

Zero-duration resolutions (opened and resolved in the same second, bias MTTR downward): **0** of 30,022 resolved.

## 12. SDM QBR — Backlog and Aging

**Opening vs Closure Rate (incidents opened vs resolved per month)** — last 6 calendar months, by `incident.opened_at`, `incident.resolved_at`

| Month | opened | resolved |
|---|---:|---:|
| 2026-04 | 5,970 | 5,153 |
| 2026-05 | 3,865 | 3,555 |
| 2026-06 | 4,931 | 799 |
| 2026-07 | 177 | 104 |
| 2026-08 | 71 | 213 |
| 2026-09 | 8,356 | 7,238 |

**BMI (Backlog Management Index)** = resolved ÷ opened × 100 per month; >100 means the backlog shrank that month. Derive from the table above.

**Ticket Aging Trend (house: In Progress + On Hold by state)** — `incident` · `stateIN2,3` · COUNT GROUPBY `state`

| state | value |
|---|---:|
| In Progress | 5,377 |
| On Hold | 1 |

**Aging Categorization by Priority (open incidents)** — `incident` · `active=true` · age buckets on `opened_at` × `priority`

| Age | 1 - Critical | 2 - High | 3 - Moderate | 4 - Low | Total |
|---|---:|---:|---:|---:|---:|
| 0-7 days | 3 | 24 | 11 | 1,166 | 1,204 |
| 7-30 days | 5 | 2 | 1 | 30 | 38 |
| 30-90 days | 0 | 49 | 10 | 2,267 | 2,326 |
| 90+ days | 6 | 15 | 12 | 1,912 | 1,945 |

**Aging Categorization by State (open incidents)** — `incident` · `active=true` · age buckets on `opened_at` × `state`

| Age | (15) | Cancelled | Closed | In Progress | New | Resolved | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0-7 days | 0 | 0 | 0 | 1,095 | 10 | 99 | 1,204 |
| 7-30 days | 0 | 0 | 0 | 36 | 0 | 2 | 38 |
| 30-90 days | 0 | 0 | 0 | 2,326 | 0 | 0 | 2,326 |
| 90+ days | 1 | 3 | 11 | 1,920 | 0 | 10 | 1,945 |

**Ticket Age by Priority — house field u_priority_aging (In Progress/On Hold, opened since 2024)** — `incident` · `u_priority_aging!=empty^opened_at>=javascript:gs.dateGenerate('2024-01-01','00:00:00')^stateIN2,3` · COUNT GROUPBY `u_priority_aging`

| u_priority_aging | value |
|---|---:|
| 4 - Low | 30-90 | 2,267 |
| 4 - Low | 90+ | 1,897 |
| 4 - Low | 0-7 | 1,107 |
| 2 - High | 30-90 | 29 |
| 2 - High | 7-30 | 20 |
| 4 - Low | 7-30 | 18 |
| 3 - Moderate | 30-90 | 9 |
| 3 - Moderate | 90+ | 8 |
| 2 - High | 90+ | 5 |
| 1 - Critical | 7-30 | 3 |
| 1 - Critical | 90+ | 2 |
| 2 - High | 0-7 | 2 |
| 3 - Moderate | 0-7 | 2 |

**Oldest open incident per priority** — `MIN(opened_at)` on active incidents

| Priority | Oldest opened_at | Open count |
|---|---|---:|
| P1 | 2015-08-12 23:41:00 | 14 |
| P2 | 2024-11-13 11:43:58 | 90 |
| P3 | 2016-12-12 15:19:57 | 34 |
| P4 | 2015-11-02 22:05:36 | 5,375 |
| P5 |  | 0 |

| Tile | Table | Filter | Live value | Note |
|---|---|---|---:|---|
| Tickets Approaching SLA Breach – P1 (composed: active SLA, not breached, >80%) | `task_sla` | `active=true^has_breached=false^percentage>80^task.priority=1` | **0** |  |
| Tickets Approaching SLA Breach – P2 (composed) | `task_sla` | `active=true^has_breached=false^percentage>80^task.priority=2` | **59** |  |
| Tickets Approaching SLA Breach – any priority (composed) | `task_sla` | `active=true^has_breached=false^percentage>80` | **150** |  |
| Tickets Approaching SLA Breach – P1 (house) | `task` | `active=true^opened_at<javascript:gs.beginningOfLast6Months()^priority=1` | **12** | house = active P1 tasks older than 6 months; never touches task_sla |
| Tickets Approaching SLA Breach – P2 (house) | `task` | `active=true^opened_at<javascript:gs.beginningOfLast6Months()^priority=2` | **25** | same defect |

## 13. Backlog Beacon

| Tile | Table | Filter | Live value | Note |
|---|---|---|---:|---|
| Backlog Incidents Count (house) | `incident` | `active=true^u_past_incidentsISNOTEMPTY^stateIN2^assigned_toISNOTEMPTY^priorityNOT IN1,5` | **1,292** | requires UST past-incidents field, an assignee, In Progress, P2–P4 |
| Backlog Incidents Count (house, corrected field name) | `incident` | `active=true^x_ustgl_backlog_be_u_past_incidentsISNOTEMPTY^stateIN2^assigned_toISNOTEMPTY^priorityNOT IN1,5` | **239** | the field on this instance is x_ustgl_backlog_be_u_past_incidents; u_past_incidents does not exist here |
| Backlog (composed: open, In Progress) | `incident` | `active=true^state=2` | **5,377** |  |
| Incidents with an AI Next Best Action | `incident` | `x_ustgl_backlog_be_u_next_best_actionISNOTEMPTY` | **5,353** |  |
| Open incidents with an AI Next Best Action | `incident` | `active=true^x_ustgl_backlog_be_u_next_best_actionISNOTEMPTY` | **4,357** |  |
| Incidents with relevant knowledge articles suggested | `incident` | `x_ustgl_backlog_be_u_relevant_knowledge_articlesISNOTEMPTY` | **3,237** |  |

**SLA — active true/false split (task_sla)** — `task_sla` · `(none)` · COUNT GROUPBY `active`

| active | value |
|---|---:|
| false | 32,922 |
| true | 17,275 |

**SLA — active × breached (task_sla)** — `task_sla` · `(none)` · COUNT GROUPBY `active,has_breached`

| active × has_breached | value |
|---|---:|
| false × false | 24,854 |
| true × true | 15,361 |
| false × true | 8,068 |
| true × false | 1,914 |

**Incident Backlog Assigned To (open incidents, per assignee)** — `incident` · `active=true^assigned_toISNOTEMPTY` · COUNT GROUPBY `assigned_to`

| assigned_to | value |
|---|---:|
| AURA Agent | 1,207 |
| David Dan | 33 |
| Bow Ruggeri | 21 |
| Beth Anglin | 18 |
| Fred Luddy | 13 |
| David Loo | 11 |
| ITIL User | 11 |
| Don Goodliffe | 8 |
| Aileen Mottern | 2 |
| (empty) | 1 |
| Bertram Quertermous | 1 |
| Guillermo Frohlich | 1 |
| Incident Manager | 1 |
| Manifah Masood | 1 |

**Incident Backlog Assigned To (house backlog definition, corrected field)** — `incident` · `active=true^x_ustgl_backlog_be_u_past_incidentsISNOTEMPTY^stateIN2^assigned_toISNOTEMPTY^priorityNOT IN1,5` · COUNT GROUPBY `assigned_to`

| assigned_to | value |
|---|---:|
| AURA Agent | 129 |
| David Dan | 32 |
| Bow Ruggeri | 20 |
| Beth Anglin | 18 |
| Fred Luddy | 11 |
| David Loo | 9 |
| ITIL User | 9 |
| Don Goodliffe | 6 |
| Aileen Mottern | 2 |
| (empty) | 1 |
| Bertram Quertermous | 1 |
| Incident Manager | 1 |

## 14. Dashboard-level filters (SDM QBR)

The five filters on every QBR tab and the field each maps to. Every one is a plain field filter, so any tile above can be re-run with the clause appended.

| Filter | Field | Distinct values (live) |
|---|---|---|
| Task type | `sys_class_name (on task)` | Incident (36,030), Follow On Task (2,573), Security Incident (1,023), Requested Item (831), Request (765), Task (666), Upgrade History Task (551), Group approval (272), Catalog Task (258), Security Incident Response Task (227), Change Request (158), Problem (149) |
| State | `incident.state` | Closed (29,911), In Progress (5,377), Canceled (616), Resolved (111), New (10), Cancelled (3), On Hold (1), (15) (1) |
| Application Category | `incident.x_ustgl_ust_app_su_applicationa` | (empty) (36,030) |
| Incident Priority | `incident.priority` | 4 - Low (13,513), 2 - High (10,412), 1 - Critical (8,146), 3 - Moderate (3,125), 5 - Planning (834) |
| Incidents-created | `incident.sys_created_on` | date range — see the monthly tables |

