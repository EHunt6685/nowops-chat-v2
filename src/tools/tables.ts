// What the tools may read, and how a reference narrows a table. One place, so adding a kind of
// reference (a company, a category) is one row here and no new code path.

/**
 * Tables a count, aggregate or list may touch. The scan's own list, when there is one, is added
 * at runtime; this is the floor. sys_user is here for lookups only: list_records refuses it.
 */
export const BASE_TABLES = new Set([
  'incident', 'task', 'task_sla', 'change_request', 'change_task', 'problem', 'problem_task', 'sc_request', 'sc_req_item', 'sc_task',
  'sysapproval_approver', 'metric_instance', 'kb_knowledge', 'kb_use', 'asmt_assessment_instance',
  'cmdb_ci', 'cmdb_ci_server', 'cmdb_ci_appl', 'cmdb_ci_business_app', 'cmdb_ci_service', 'cmdb_ci_database', 'cmdb_ci_computer', 'cmdb_rel_ci', 'cmdb_health_result',
  'alm_asset', 'alm_license', 'alm_hardware', 'sn_si_incident', 'sn_vul_vulnerable_item', 'em_alert', 'em_event',
  'sys_user_group', 'cmn_location', 'cmn_department', 'core_company', 'contract_sla',
])

/** Never read by any tool, whatever the scan says. */
export const DENIED_TABLES = new Set(['sys_user_has_role', 'sys_user_role', 'oauth_credential', 'sys_properties', 'sys_db_object_password', 'sys_user_preference', 'sys_auth_profile', 'oauth_entity'])

/** Fields never returned in a list, on any table. */
export const DENIED_FIELDS = new Set(['password', 'user_password', 'password_needs_reset', 'ssn', 'national_id', 'credit_card', 'phone', 'mobile_phone', 'home_phone', 'email', 'date_of_birth'])

export function tableAllowed(table: string, scanned: Set<string> | null): boolean {
  if (DENIED_TABLES.has(table)) return false
  return BASE_TABLES.has(table) || (scanned?.has(table) ?? false)
}

/**
 * A kind of thing a user names in a question, the table it lives in, the fields its name may match,
 * and the field to show beside a candidate so the model can tell two apart.
 */
export interface ReferenceKind {
  table: string
  /** Fields tried for an exact match, then for a contains match, in order. */
  nameFields: string[]
  /** Shown with each candidate. */
  detail: string[]
  /** Candidates that share this field's value form one set the model may apply together ("South Africa" is three locations in one country). */
  setBy?: string
  /** Only active records, where the table has the flag. */
  activeOnly?: boolean
}

export const REFERENCE_KINDS: Record<string, ReferenceKind> = {
  group: { table: 'sys_user_group', nameFields: ['name'], detail: ['description', 'type'], activeOnly: true },
  location: { table: 'cmn_location', nameFields: ['name', 'city', 'country', 'state'], detail: ['city', 'country'], setBy: 'country' },
  service: { table: 'cmdb_ci_service', nameFields: ['name'], detail: ['busines_criticality', 'operational_status'] },
  ci: { table: 'cmdb_ci', nameFields: ['name'], detail: ['sys_class_name', 'operational_status'] },
  user: { table: 'sys_user', nameFields: ['name', 'user_name'], detail: ['title', 'department'], activeOnly: true },
  company: { table: 'core_company', nameFields: ['name'], detail: ['country'] },
  department: { table: 'cmn_department', nameFields: ['name'], detail: ['company'] },
}

/**
 * How each table reaches a reference: the field whose value is the record's sys_id. task_sla and
 * metric_instance hang off their task, so they dot-walk. A kind missing for a table cannot narrow it.
 */
const TASK_FIELDS: Record<string, string> = { group: 'assignment_group', location: 'location', service: 'business_service', ci: 'cmdb_ci', user: 'assigned_to', company: 'company', department: 'caller_id.department', caller: 'caller_id' }
const VIA_TASK = Object.fromEntries(Object.entries(TASK_FIELDS).map(([k, f]) => [k, `task.${f}`]))
export const NARROW_PATHS: Record<string, Record<string, string>> = {
  incident: { ...TASK_FIELDS, caller: 'caller_id' },
  task: TASK_FIELDS,
  problem: { ...TASK_FIELDS, department: 'opened_by.department' },
  change_request: { ...TASK_FIELDS, department: 'requested_by.department' },
  sc_req_item: { ...TASK_FIELDS, user: 'request.requested_for', department: 'request.requested_for.department' },
  sc_request: { ...TASK_FIELDS, user: 'requested_for', department: 'requested_for.department' },
  task_sla: VIA_TASK,
  metric_instance: { group: 'id.assignment_group', location: 'id.location', service: 'id.business_service', ci: 'id.cmdb_ci', user: 'id.assigned_to', company: 'id.company' },
  sysapproval_approver: { user: 'approver', group: 'group' },
  sn_si_incident: { group: 'assignment_group', location: 'location', user: 'assigned_to', company: 'company', ci: 'cmdb_ci' },
  sn_vul_vulnerable_item: { group: 'assignment_group', ci: 'cmdb_ci' },
  em_alert: { group: 'assignment_group', ci: 'cmdb_ci' },
  cmdb_ci: { location: 'location', company: 'company', department: 'department', user: 'assigned_to', group: 'support_group' },
  cmdb_ci_server: { location: 'location', company: 'company', department: 'department', user: 'assigned_to', group: 'support_group' },
  cmdb_ci_appl: { location: 'location', company: 'company', department: 'department', user: 'assigned_to', group: 'support_group' },
  cmdb_ci_computer: { location: 'location', company: 'company', department: 'department', user: 'assigned_to', group: 'support_group' },
  alm_asset: { location: 'location', company: 'company', department: 'department', user: 'assigned_to' },
  alm_hardware: { location: 'location', company: 'company', department: 'department', user: 'assigned_to' },
  alm_license: { company: 'company', department: 'department' },
}

export function narrowField(table: string, kind: string): string | null {
  return NARROW_PATHS[table]?.[kind] ?? null
}

/** The user-facing phrase for a narrowing, written from what was applied, never from what the model said. */
export function narrowPhrase(kind: string, names: string[]): string {
  const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
  switch (kind) {
    case 'group': return `for the ${list} group${names.length > 1 ? 's' : ''}`
    case 'location': return `at ${list}`
    case 'service': return `for the ${list} service${names.length > 1 ? 's' : ''}`
    case 'ci': return `on ${list}`
    case 'user': return `assigned to ${list}`
    case 'caller': return `raised by ${list}`
    case 'company': return `for ${list}`
    case 'department': return `in the ${list} department${names.length > 1 ? 's' : ''}`
    default: return `for ${list}`
  }
}
