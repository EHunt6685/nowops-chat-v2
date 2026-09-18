// Throwaway prototype: the NowOps definitions table. {{open_states}} and {{sla_pN_resolution}}
// are tenant parameters filled from the confirm step. Tier B rows carry the decision in `meaning`.
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
