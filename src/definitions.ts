// The NowOps definitions table: one row per dashboard tile, shared by the dashboard and the chatbot so
// the two can never disagree on what "open" or "breached" means (D-004). {{open_states}} and
// {{sla_pN_resolution}} are tenant parameters filled from the scan and confirm steps. Tier B rows carry
// the decision in `meaning`.
import type { MetricRequest } from './servicenow/stats.js'

export type Definition =
  | { kind?: 'query'; id: string; name: string; meaning: string; table: string; filter: string; aggregate: 'count' | 'avg' | 'min'; field?: string; dashboard: 'QBR' | 'App360'; group: string; tier?: 'B' }
  | { kind: 'ratio'; id: string; name: string; meaning: string; num: string; den: string; dashboard: 'QBR' | 'App360'; group: string; tier?: 'B' }

export const DEFINITIONS: Definition[] = [
  // ---- QBR core: tickets
  { id: 'total_incidents', name: 'Total Tickets', meaning: 'All incidents ever raised', table: 'incident', filter: '', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'open_incidents', name: 'Open Tickets', meaning: 'Incidents in a state the client counts as open', table: 'incident', filter: 'stateIN{{open_states}}', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'open_p1', name: 'Open P1 Incidents', meaning: 'Open incidents with priority 1', table: 'incident', filter: 'stateIN{{open_states}}^priority=1', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'active_major', name: 'Active Major Incidents (P1/P2)', meaning: 'Open incidents with priority 1 or 2', table: 'incident', filter: 'stateIN{{open_states}}^priorityIN1,2', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'closed_incidents', name: 'Closed Tickets', meaning: 'Resolved or closed incidents', table: 'incident', filter: 'stateIN6,7', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'on_hold', name: 'On-Hold Tickets', meaning: 'Incidents on hold', table: 'incident', filter: 'state=3', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'cancelled', name: 'Cancelled Tickets', meaning: 'Cancelled incidents (standard state 8 and any custom cancelled state)', table: 'incident', filter: 'stateIN8,9', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'backlog', name: 'Backlog (worked)', meaning: 'In progress, assigned, priority 2-4 — NowOps definition (D-006); no AI-processed clause', table: 'incident', filter: 'state=2^assigned_toISNOTEMPTY^priorityIN2,3,4', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'aged_90', name: 'Open > 90 days', meaning: 'Open incidents opened more than 90 days ago', table: 'incident', filter: 'stateIN{{open_states}}^opened_at<javascript:gs.daysAgoStart(90)', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'oldest_open_p1', name: 'Oldest open P1', meaning: 'Opened date of the oldest open P1', table: 'incident', filter: 'stateIN{{open_states}}^priority=1', aggregate: 'min', field: 'opened_at', dashboard: 'QBR', group: 'core' },
  { id: 'reassigned', name: 'Reassigned incidents', meaning: 'Incidents reassigned at least once', table: 'incident', filter: 'reassignment_count>0', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { kind: 'ratio', id: 'reassignment_rate', name: 'Reassignment rate', meaning: 'Reassigned incidents ÷ all incidents', num: 'reassigned', den: 'total_incidents', dashboard: 'QBR', group: 'core' },
  // ---- QBR core: MTTR and durations
  { id: 'mttr_p1', name: 'MTTR P1', meaning: 'Average calendar time to resolve P1 incidents, all resolved (one window for every priority)', table: 'incident', filter: 'stateIN6,7^priority=1', aggregate: 'avg', field: 'calendar_duration', dashboard: 'QBR', group: 'core' },
  { id: 'mttr_p2', name: 'MTTR P2', meaning: 'Average calendar time to resolve P2 incidents', table: 'incident', filter: 'stateIN6,7^priority=2', aggregate: 'avg', field: 'calendar_duration', dashboard: 'QBR', group: 'core' },
  { id: 'ttr_major', name: 'Time-to-Restore (major)', meaning: 'Average calendar time to resolve P1/P2 incidents', table: 'incident', filter: 'stateIN6,7^priorityIN1,2', aggregate: 'avg', field: 'calendar_duration', dashboard: 'QBR', group: 'core' },
  { id: 'mtta', name: 'Mean time to assign (MTTA)', meaning: 'Average time an incident spent before/while being assigned — ServiceNow metric "Assigned to Duration"', table: 'metric_instance', filter: 'definition.name=Assigned to Duration^calculation_complete=true', aggregate: 'avg', field: 'duration', dashboard: 'QBR', group: 'metrics' },
  { id: 'time_in_state', name: 'Avg time in a state', meaning: 'Average time incidents spend in any one state — ServiceNow metric "Incident State Duration"', table: 'metric_instance', filter: 'definition.name=Incident State Duration^calculation_complete=true', aggregate: 'avg', field: 'duration', dashboard: 'QBR', group: 'metrics' },
  // ---- QBR core: SLA
  { id: 'sla_breached', name: 'SLA Breaches (incidents)', meaning: 'Incident SLAs that have breached', table: 'task_sla', filter: 'has_breached=true^task.sys_class_name=incident', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'sla_completed', name: 'SLAs completed (incidents)', meaning: 'Completed incident resolution SLAs (denominator)', table: 'task_sla', filter: 'stage=completed^sla.type=SLA^task.sys_class_name=incident', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'sla_met', name: 'SLAs met (incidents)', meaning: 'Completed incident resolution SLAs not breached', table: 'task_sla', filter: 'stage=completed^sla.type=SLA^task.sys_class_name=incident^has_breached=false', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { kind: 'ratio', id: 'sla_attainment', name: 'SLA Attainment %', meaning: 'Met ÷ completed, all incident SLAs. From task_sla, never from incident.made_sla (disagrees by 20 points here)', num: 'sla_met', den: 'sla_completed', dashboard: 'QBR', group: 'core' },
  { id: 'sla_p1_met', name: 'P1 resolution SLAs met', meaning: 'Completed P1 resolution SLAs not breached', table: 'task_sla', filter: 'sla={{sla_p1_resolution}}^stage=completed^has_breached=false', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'sla_p1_all', name: 'P1 resolution SLAs completed', meaning: 'All completed P1 resolution SLAs', table: 'task_sla', filter: 'sla={{sla_p1_resolution}}^stage=completed', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { kind: 'ratio', id: 'sla_p1_attainment', name: 'P1 SLA Attainment %', meaning: 'P1 met ÷ P1 completed, using the matched P1 resolution SLA record', num: 'sla_p1_met', den: 'sla_p1_all', dashboard: 'QBR', group: 'core' },
  { id: 'approaching_breach', name: 'SLAs at risk now (>80%)', meaning: 'Active, unbreached SLAs past 80% of their time', table: 'task_sla', filter: 'active=true^has_breached=false^business_percentage>80', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  { id: 'due_72h', name: 'SLAs due within 72 h', meaning: 'Active, unbreached SLAs whose planned end is in the next 72 hours (deterministic, not predicted)', table: 'task_sla', filter: 'active=true^has_breached=false^planned_end_time<javascript:gs.hoursAgoStart(-72)', aggregate: 'count', dashboard: 'QBR', group: 'core' },
  // ---- QBR: change and approvals
  { id: 'changes_closed', name: 'Changes with a close code', meaning: 'Changes that recorded an outcome (denominator)', table: 'change_request', filter: 'close_codeISNOTEMPTY', aggregate: 'count', dashboard: 'QBR', group: 'change' },
  { id: 'changes_successful', name: 'Successful changes', meaning: 'Changes closed as successful', table: 'change_request', filter: 'close_code=successful', aggregate: 'count', dashboard: 'QBR', group: 'change' },
  { kind: 'ratio', id: 'change_success_rate', name: 'Change Success Rate', meaning: 'Successful ÷ changes with a close code. Thin here: 16 of 158 changes have a close code', num: 'changes_successful', den: 'changes_closed', dashboard: 'QBR', group: 'change' },
  { id: 'changes_all', name: 'All changes', meaning: 'All change requests', table: 'change_request', filter: '', aggregate: 'count', dashboard: 'QBR', group: 'change' },
  { id: 'changes_emergency', name: 'Emergency changes', meaning: 'Changes of type emergency', table: 'change_request', filter: 'type=emergency', aggregate: 'count', dashboard: 'QBR', group: 'change' },
  { kind: 'ratio', id: 'emergency_change_pct', name: 'Emergency Change %', meaning: 'Emergency ÷ all changes', num: 'changes_emergency', den: 'changes_all', dashboard: 'QBR', group: 'change' },
  { id: 'approval_time', name: 'Change approval cycle time', meaning: 'Average duration of the ServiceNow metric "Change Approval"', table: 'metric_instance', filter: 'definition.name=Change Approval^calculation_complete=true', aggregate: 'avg', field: 'duration', dashboard: 'QBR', group: 'metrics' },
  { id: 'approvals_pending', name: 'Approvals pending', meaning: 'Approval requests still in Requested state', table: 'sysapproval_approver', filter: 'state=requested', aggregate: 'count', dashboard: 'QBR', group: 'change' },
  // ---- App360 core
  { id: 'open_changes', name: 'Open Changes', meaning: 'Active change requests', table: 'change_request', filter: 'active=true', aggregate: 'count', dashboard: 'App360', group: 'core' },
  { id: 'open_problems', name: 'Open Problems', meaning: 'Active problems', table: 'problem', filter: 'active=true', aggregate: 'count', dashboard: 'App360', group: 'core' },
  { id: 'servers', name: 'Servers', meaning: 'Server CIs of any class', table: 'cmdb_ci_server', filter: '', aggregate: 'count', dashboard: 'App360', group: 'cmdb' },
  { id: 'databases', name: 'Databases', meaning: 'Database CIs (cmdb_ci_database, not cmdb_ci_db_instance which is empty here)', table: 'cmdb_ci_database', filter: '', aggregate: 'count', dashboard: 'App360', group: 'cmdb' },
  { id: 'warranty_expired', name: 'Server warranty expired', meaning: 'Servers whose warranty date is in the past', table: 'cmdb_ci_server', filter: 'warranty_expiration<javascript:gs.beginningOfToday()', aggregate: 'count', dashboard: 'App360', group: 'cmdb' },
  { id: 'entitlements_in_use', name: 'Entitlements in use', meaning: 'Software entitlements with status In use', table: 'alm_license', filter: 'install_status=1', aggregate: 'count', dashboard: 'App360', group: 'sam' },
  { id: 'perpetual_licences', name: 'Perpetual licences', meaning: 'Entitlements with a perpetual licence type', table: 'alm_license', filter: 'license_type=perpetual', aggregate: 'count', dashboard: 'App360', group: 'sam' },
  { id: 'security_open', name: 'Open Security Incidents', meaning: 'Active security incidents', table: 'sn_si_incident', filter: 'active=true', aggregate: 'count', dashboard: 'App360', group: 'security' },
  { id: 'vulnerable_items', name: 'Vulnerable Items', meaning: 'Active vulnerable items', table: 'sn_vul_vulnerable_item', filter: 'active=true', aggregate: 'count', dashboard: 'App360', group: 'security' },
  { id: 'alerts_active', name: 'Active alerts', meaning: 'Event Management alerts in state Open or Reopen (em_alert has no active flag)', table: 'em_alert', filter: 'stateINOpen,Reopen', aggregate: 'count', dashboard: 'App360', group: 'alerts' },
  // ---- Estate (Application 360): inventory counted directly, with the relationship-based house numbers beside them
  { id: 'applications', name: 'Applications', meaning: 'Application CIs (cmdb_ci_appl). The current tile counts CI relationships whose child is an application (3), not applications', table: 'cmdb_ci_appl', filter: '', aggregate: 'count', dashboard: 'App360', group: 'cmdb' },
  { id: 'business_apps', name: 'Business applications (APM)', meaning: 'Business application records in Application Portfolio Management', table: 'cmdb_ci_business_app', filter: '', aggregate: 'count', dashboard: 'App360', group: 'cmdb' },
  { id: 'ci_relationships', name: 'CI relationships', meaning: 'All CMDB relationships — the edges of the dependency maps', table: 'cmdb_rel_ci', filter: '', aggregate: 'count', dashboard: 'App360', group: 'cmdb' },
  { id: 'servers_related', name: 'Servers (house: related)', meaning: 'House definition: relationships whose child is a Linux, Windows or web server. Counts relationships, not servers — shown for comparison', table: 'cmdb_rel_ci', filter: 'child.sys_class_name=cmdb_ci_linux_server^ORchild.sys_class_name=cmdb_ci_win_server^ORchild.sys_class_name=cmdb_ci_web_server', aggregate: 'count', dashboard: 'App360', group: 'cmdb' },
  { id: 'cis_updated_30d', name: 'CIs updated in last 30 days', meaning: 'Configuration items whose record changed in the last 30 days', table: 'cmdb_ci', filter: 'sys_updated_on>=javascript:gs.daysAgoStart(30)', aggregate: 'count', dashboard: 'App360', group: 'cmdb' },
  { id: 'orphan_cis', name: 'Orphan CIs', meaning: 'CMDB Health results for the orphan metric. Zero rows means the CMDB Health job has not run, not that there are no orphans', table: 'cmdb_health_result', filter: 'metric=c6272b5137130200f212cc028e41f168^active=true', aggregate: 'count', dashboard: 'App360', group: 'cmdb', tier: 'B' },
  { id: 'warranty_90d', name: 'Warranty expiring within 90 days', meaning: 'Servers whose warranty ends in the next 90 days', table: 'cmdb_ci_server', filter: 'warranty_expiration>=javascript:gs.beginningOfToday()^warranty_expiration<javascript:gs.daysAgoStart(-90)', aggregate: 'count', dashboard: 'App360', group: 'cmdb' },
  { id: 'servers_no_warranty', name: 'Servers with no warranty date', meaning: 'Servers where warranty_expiration is empty — cannot be tracked', table: 'cmdb_ci_server', filter: 'warranty_expirationISEMPTY', aggregate: 'count', dashboard: 'App360', group: 'cmdb' },
  { id: 'entitlements_total', name: 'Software entitlements', meaning: 'All software entitlement records', table: 'alm_license', filter: '', aggregate: 'count', dashboard: 'App360', group: 'sam' },
  { id: 'entitlements_in_stock', name: 'Entitlements in stock', meaning: 'Software entitlements with status In stock', table: 'alm_license', filter: 'install_status=6', aggregate: 'count', dashboard: 'App360', group: 'sam' },
  // ---- QBR: requests. Request items extend task, and unlike incident their `active` flag turns
  // off on close, so active=true is the open definition; no state placeholder.
  { id: 'open_ritm', name: 'Open request items', meaning: 'Request items still active (not closed complete, incomplete or skipped)', table: 'sc_req_item', filter: 'active=true', aggregate: 'count', dashboard: 'QBR', group: 'request' },
  { id: 'ritm_awaiting_approval', name: 'Request items awaiting approval', meaning: 'Active request items whose approval is still requested', table: 'sc_req_item', filter: 'active=true^approval=requested', aggregate: 'count', dashboard: 'QBR', group: 'request' },
  { id: 'ritm_past_due', name: 'Request items past due', meaning: 'Active request items whose due date is before today', table: 'sc_req_item', filter: 'active=true^due_date<javascript:gs.beginningOfToday()', aggregate: 'count', dashboard: 'QBR', group: 'request' },
  { id: 'ritm_closed', name: 'Request items closed', meaning: 'Request items closed complete or incomplete (denominator)', table: 'sc_req_item', filter: 'stateIN3,4', aggregate: 'count', dashboard: 'QBR', group: 'request' },
  { id: 'ritm_closed_incomplete', name: 'Request items closed incomplete', meaning: 'Request items closed without being fulfilled', table: 'sc_req_item', filter: 'state=4', aggregate: 'count', dashboard: 'QBR', group: 'request' },
  { kind: 'ratio', id: 'ritm_incomplete_pct', name: 'Closed incomplete share', meaning: 'Closed incomplete ÷ all closed request items', num: 'ritm_closed_incomplete', den: 'ritm_closed', dashboard: 'QBR', group: 'request' },
  { id: 'ritm_fulfilment_time', name: 'Fulfilment time', meaning: 'Average calendar time from opened to closed complete on request items. Needs calendar_duration populated on close; empty on this instance', table: 'sc_req_item', filter: 'state=3', aggregate: 'avg', field: 'calendar_duration', dashboard: 'QBR', group: 'request', tier: 'B' },
  { id: 'approvals_pending_changes', name: 'Change approvals pending', meaning: 'Approval requests in Requested state on change requests', table: 'sysapproval_approver', filter: 'state=requested^source_table=change_request', aggregate: 'count', dashboard: 'QBR', group: 'change' },
  { id: 'approvals_pending_requests', name: 'Request approvals pending', meaning: 'Approval requests in Requested state on request items', table: 'sysapproval_approver', filter: 'state=requested^source_table=sc_req_item', aggregate: 'count', dashboard: 'QBR', group: 'request' },
  // Request SLAs exist as definitions so they switch on for clients that run them; none here.
  { id: 'ritm_sla_breached', name: 'SLA breaches (requests)', meaning: 'Request item SLAs that have breached', table: 'task_sla', filter: 'has_breached=true^task.sys_class_name=sc_req_item', aggregate: 'count', dashboard: 'QBR', group: 'request', tier: 'B' },
  { id: 'ritm_sla_completed', name: 'SLAs completed (requests)', meaning: 'Completed request item SLAs (denominator)', table: 'task_sla', filter: 'stage=completed^task.sys_class_name=sc_req_item', aggregate: 'count', dashboard: 'QBR', group: 'request', tier: 'B' },
  { id: 'ritm_sla_met', name: 'SLAs met (requests)', meaning: 'Completed request item SLAs not breached', table: 'task_sla', filter: 'stage=completed^task.sys_class_name=sc_req_item^has_breached=false', aggregate: 'count', dashboard: 'QBR', group: 'request', tier: 'B' },
  { kind: 'ratio', id: 'ritm_sla_attainment', name: 'Request SLA attainment %', meaning: 'Met ÷ completed, request item SLAs', num: 'ritm_sla_met', den: 'ritm_sla_completed', dashboard: 'QBR', group: 'request', tier: 'B' },
  // ---- Tier B: table and field exist; data may be absent on a given instance
  { id: 'apps_at_risk', name: 'Applications at risk', meaning: 'Open P1/P2 incidents linked to a business service. Decision: "application" = business_service on the incident. Needs clients to link incidents to services (0.5% here)', table: 'incident', filter: 'stateIN{{open_states}}^priorityIN1,2^business_serviceISNOTEMPTY', aggregate: 'count', dashboard: 'App360', group: 'core', tier: 'B' },
  { id: 'reopened', name: 'Reopened incidents', meaning: 'Incidents reopened at least once. Needs the reopen business rule active on the client', table: 'incident', filter: 'reopen_count>0', aggregate: 'count', dashboard: 'QBR', group: 'core', tier: 'B' },
  { id: 'critical_vulns', name: 'Critical vulnerability exposure', meaning: 'Active vulnerable items rated Critical or High. All items are rated None here', table: 'sn_vul_vulnerable_item', filter: 'active=true^risk_ratingIN1,2', aggregate: 'count', dashboard: 'App360', group: 'security', tier: 'B' },
  { id: 'csat_responses', name: 'Survey responses', meaning: 'Completed assessment instances (CSAT). Needs surveys to be running', table: 'asmt_assessment_instance', filter: 'state=complete', aggregate: 'count', dashboard: 'QBR', group: 'satisfaction', tier: 'B' },
  { id: 'kb_uses', name: 'Knowledge article uses', meaning: 'Knowledge use records (views). Thin here', table: 'kb_use', filter: '', aggregate: 'count', dashboard: 'QBR', group: 'knowledge', tier: 'B' },
]

/** Field names a query definition refers to (first segment of dotted fields), for validation. */
export function fieldsOf(d: Definition): string[] {
  if (d.kind === 'ratio') return []
  const names = new Set<string>()
  for (const clause of d.filter.split('^')) {
    const m = /^(?:NQ|OR)?([a-z0-9_.]+)/.exec(clause)
    if (m) names.add(m[1]!.split('.')[0]!)
  }
  if (d.field) names.add(d.field)
  return [...names]
}

// ---- What the chatbot needs from the table.

/** One row of the catalogue the model reads. Meaning is included only where names alone are ambiguous. */
export interface CatalogueEntry { id: string; name: string; meaning?: string; available: boolean }

/** A definition resolved for one tenant: the same request the dashboard tile runs. */
export type KpiMatch =
  | { id: string; name: string; meaning: string; request: MetricRequest; ratio?: { num: MetricRequest; den: MetricRequest }; tier?: 'B'; unavailable?: undefined }
  | { id: string; name: string; meaning: string; unavailable: string; request?: undefined; ratio?: undefined; tier?: 'B' }

/**
 * Tier B rows exist on the instance but may hold no data: zero rows, or an average duration of zero
 * because the field is never populated. Both mean "nothing recorded yet", not a figure of zero.
 * The dashboard tile shows "no data yet" for these; the chatbot must not read the zero out loud.
 */
export function isNoDataYet(m: KpiMatch, value: number | string): boolean {
  return m.tier === 'B' && (value === 0 || String(value) === '00:00:00')
}

/** What the instance scan learned about each table. Null means no scan has run: tables are assumed present. */
export type TableProfile = Record<string, { present: boolean; missing_fields?: string[]; reason?: string }>

export interface TenantSource {
  /** Values for {{open_states}} and {{sla_pN_resolution}}; a missing key leaves that definition unavailable. */
  params?: Record<string, string>
  tables?: TableProfile | null
  /** False when the defaults were accepted without review; rows using a parameter are then marked assumed. */
  confirmed?: boolean
}

export type ValidatedRow = Definition & { status: 'available' | 'unavailable' | 'derived'; reason: string; filter_resolved?: string; assumed?: boolean }

export interface Kpis {
  /** Every definition with its availability for this tenant, in table order. What the dashboard renders. */
  rows(): ValidatedRow[]
  /** Ids and names for the model's DEFINITIONS block. Unavailable rows stay listed, marked, so the model names them rather than composing a substitute. */
  catalogue(): CatalogueEntry[]
  /** The tile's own query for an id the model chose. Null for an id that is not a definition. */
  byId(id: string): KpiMatch | null
  /** Word-overlap match, kept for diagnostics and the page's tile search. Not used for routing. */
  match(question: string): KpiMatch | null
  /** True when an available definition counts on this table: a composed metric there may be a prompt failure. */
  coversTable(table: string): boolean
  /** Fill tenant parameters into any filter string. */
  resolve(filter: string): string
}

/** Tables where several definitions share vocabulary, so the model needs the meaning to tell them apart. */
const AMBIGUOUS_TABLES = new Set(['task_sla', 'metric_instance', 'cmdb_rel_ci', 'sysapproval_approver'])

// Word-level normalisation shared with the page copy: synonyms to one canonical word, then plurals folded.
const CANON: [RegExp, string][] = [[/^(incidents?|tickets?|tkts?)$/, 'tickets'], [/^(p1|critical)$/, 'p1'], [/^(breach(ed|es|ing)?|violat(ed|ions?|es)?|missed)$/, 'breaches'], [/^changes?$/, 'changes'], [/^problems?$/, 'problems'], [/^slas?$/, 'sla'], [/^approvals?$/, 'approval'], [/^(pct|share|percent|percentage|proportion)$/, 'pct'], [/^(mean|average)$/, 'avg'], [/^servers?$/, 'servers'], [/^(kb|knowledge)$/, 'knowledge'], [/^licen[cs]es?$/, 'licence']]
const normalise = (s: string) => ` ${s.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/%/g, ' pct ').replace(/priority ?([1-5])/g, 'p$1').replace(/[^a-z0-9> ]/g, ' ').split(/\s+/).filter(Boolean).map((w) => { for (const [re, to] of CANON) if (re.test(w)) return to; return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w }).join(' ')} `
const NAME_STOP = new Set(['now', 'with', 'a', 'the', 'of', 'and', 'or', 'to', 'in', '>', 'house', 'related'])
const GENERIC = new Set(['tickets', 'open', 'changes', 'sla', 'problems', 'active', 'total', 'all', 'count', 'time', 'avg', 'pct', 'rate', 'item', 'use', 'day', 'with'])
/** How well a question matches a definition name: share of name words present; 0 below half, or on a lone generic word. */
export function scoreName(question: string, name: string): number {
  const q = normalise(question)
  const words = normalise(name).trim().split(' ').filter((w) => w && !NAME_STOP.has(w))
  if (!words.length) return 0
  const hit = words.filter((w) => q.includes(` ${w} `))
  if (hit.length / words.length < 0.5) return 0
  if (hit.length === 1 && words.length > 1 && GENERIC.has(hit[0]!)) return 0
  return hit.length / words.length + hit.length * 0.01
}

/** Shape of a definition id as the model may write it. Anything else is not looked up. */
export const DEFINITION_ID_RE = /^[a-z][a-z0-9_]*$/

export function makeDefinitions(source: () => TenantSource): Kpis {
  const resolve = (filter: string, params?: Record<string, string>) => filter.replace(/\{\{(\w+)\}\}/g, (_, k) => params?.[k] || `{{${k}}}`)
  const usesParam = (d: Definition) => d.kind !== 'ratio' && /\{\{/.test(d.filter)

  function rows(): ValidatedRow[] {
    const { params, tables, confirmed } = source()
    const out: ValidatedRow[] = DEFINITIONS.map((d) => {
      if (d.kind === 'ratio') return { ...d, status: 'derived', reason: `${d.num} ÷ ${d.den}` }
      let status: ValidatedRow['status'] = 'available', reason = ''
      // No scan yet: nothing is known against the table, so nothing is rejected on that ground.
      const t = tables ? tables[d.table] : { present: true, missing_fields: [] as string[] }
      if (!t?.present) { status = 'unavailable'; reason = t?.reason ? `table ${d.table} ${t.reason}` : `table ${d.table} not present` }
      else {
        const miss = fieldsOf(d).filter((f) => (t.missing_fields ?? []).includes(f))
        if (miss.length) { status = 'unavailable'; reason = `field ${miss.join(', ')} not on ${d.table}` }
        else if (/\{\{/.test(resolve(d.filter, params))) { status = 'unavailable'; reason = params ? 'no matching SLA record on this instance' : 'tenant parameters not set; run the instance scan in NowOps' }
      }
      return { ...d, filter_resolved: resolve(d.filter, params), status, reason, assumed: usesParam(d) && confirmed === false }
    })
    // a ratio is available only if both parts are
    for (const r of out) if (r.kind === 'ratio') {
      const parts = [r.num, r.den].map((id) => out.find((x) => x.id === id))
      if (parts.some((p) => !p || p.status !== 'available')) { r.status = 'unavailable'; r.reason = 'a component is unavailable' }
      else { r.status = 'available'; r.assumed = parts.some((p) => p!.assumed) }
    }
    return out
  }

  const toMatch = (d: ValidatedRow, all: ValidatedRow[]): KpiMatch | null => {
    const tier = d.tier ? { tier: d.tier } : {}
    if (d.status !== 'available') return { id: d.id, name: d.name, meaning: d.meaning, unavailable: d.reason || 'not available on this instance', ...tier }
    const label = d.name.toLowerCase().replace(/\s*\(.*?\)/g, '')
    const req = (x: ValidatedRow | undefined): MetricRequest | null => !x || x.kind === 'ratio' ? null : { table: x.table, filter: x.filter_resolved ?? x.filter, aggregate: x.aggregate, ...(x.field ? { field: x.field } : {}), label }
    if (d.kind === 'ratio') {
      const n = req(all.find((x) => x.id === d.num)), m = req(all.find((x) => x.id === d.den))
      if (!n || !m) return null
      return { id: d.id, name: d.name, meaning: d.meaning, request: n, ratio: { num: n, den: m }, ...tier }
    }
    return { id: d.id, name: d.name, meaning: d.meaning, request: req(d)!, ...tier }
  }

  return {
    rows,
    catalogue() {
      return rows().map((d) => ({
        id: d.id, name: d.name, available: d.status === 'available',
        ...((d.kind !== 'ratio' && AMBIGUOUS_TABLES.has(d.table)) || d.tier === 'B' ? { meaning: d.meaning } : {}),
      }))
    },
    byId(id) {
      const all = rows()
      const d = all.find((x) => x.id === id)
      return d ? toMatch(d, all) : null
    },
    match(question) {
      const all = rows()
      let best: { d: ValidatedRow; s: number } | null = null
      for (const d of all) { const s = scoreName(question, d.name); if (s && (!best || s > best.s)) best = { d, s } }
      return best ? toMatch(best.d, all) : null
    },
    coversTable(table) {
      return rows().some((d) => d.kind !== 'ratio' && d.table === table && d.status === 'available')
    },
    resolve(filter) { return resolve(filter, source().params) },
  }
}
