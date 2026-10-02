// count, aggregate and list_records: the three ways a number or a list leaves the instance.
// Every number comes from the Stats API. A list carries a separate true total, never the length
// of the page, so the model cannot infer "there are 10" from ten rows.
import { makeStats } from '../servicenow/stats.js'
import { rows, dv, vv, statsCount, statsGroup, listUrl } from './fetch.js'
import { tableAllowed, DENIED_FIELDS } from './tables.js'
import { lintQuery, queryFields, TABLE_RE, FIELD_RE, SYS_ID_RE } from './query.js'
import { ToolError, str, num, type ToolDef, type ToolContext } from './types.js'
import { fieldExists } from './schema.js'

const FILTER_DESC = 'ServiceNow encoded query: clauses joined by ^, e.g. active=true^priority=1^opened_at>javascript:gs.daysAgoStart(7). Empty for the whole table. Choice fields take stored values (state=2), reference fields take sys_ids returned by resolve_reference (assignment_group=<sys_id> or assignment_groupIN<id>,<id>). Dot-walk through references: task.assignment_group on task_sla.'

/** Checks the model's table and filter; returns the issues as one error the model can act on. */
async function check(ctx: ToolContext, table: string, filter: string): Promise<void> {
  if (!TABLE_RE.test(table)) throw new ToolError(`"${table}" is not a table name`)
  if (!tableAllowed(table, ctx.scanned)) throw new ToolError(`table ${table} is not available to the chatbot on this instance`)
  const issues = lintQuery(filter)
  if (issues.length) throw new ToolError(`the filter cannot run: ${issues.map((i) => i.issue + (i.fix ? ` (${i.fix})` : '')).join('; ')}`)
  // A sys_id in a filter must have come from a lookup this turn. Anything else is a guess.
  for (const m of filter.matchAll(/[0-9a-f]{32}/g)) {
    if (!ctx.turn.resolved.has(m[0])) throw new ToolError(`sys_id ${m[0]} was not returned by resolve_reference in this turn; look the name up first`)
  }
  for (const f of queryFields(filter)) {
    if (!FIELD_RE.test(f)) throw new ToolError(`"${f}" is not a field name`)
    if (!(await fieldExists(ctx.sn, table, f))) throw new ToolError(`field "${f}" does not exist on ${table}; call describe_table ${table} to see its fields`)
  }
}

export const count: ToolDef = {
  name: 'count',
  description:
    'Count records in a table matching a filter. Use when no dashboard definition answers the question exactly (see run_definition first). ' +
    'Returns the total and a link that opens the same list in ServiceNow. ' + FILTER_DESC,
  input_schema: {
    type: 'object',
    properties: {
      table: { type: 'string', description: 'Table, e.g. incident, task_sla, change_request, problem, sc_req_item' },
      filter: { type: 'string', description: 'Encoded query; empty string for all records' },
      label: { type: 'string', description: '2-6 word noun phrase that reads after the number, e.g. "open P3 incidents on hold"' },
    },
    required: ['table', 'filter'],
  },
  async run(args, ctx) {
    const table = str(args.table, 80), filter = str(args.filter, 2048), label = str(args.label, 80)
    await check(ctx, table, filter)
    const r = await makeStats(ctx.sn).run({ table, filter, aggregate: 'count', label })
    return { data: { table, filter: filter || '(all records)', count: r.value, label }, url: r.url }
  },
}

export const aggregate: ToolDef = {
  name: 'aggregate',
  description:
    'Break a count down by one field (by priority, by assignment group, by category, by location, by month) or rank groups (top 5 groups by breaches), ' +
    'optionally with an average, sum, min or max of a numeric or duration field per group. One server-side query. ' +
    'Returns the total across ALL groups first, then the top groups; never infer the total from the groups shown. ' + FILTER_DESC,
  input_schema: {
    type: 'object',
    properties: {
      table: { type: 'string' },
      filter: { type: 'string', description: 'Encoded query; empty for all records' },
      group_by: { type: 'string', description: 'Field to group by, e.g. priority, assignment_group, category, location, task.assignment_group' },
      aggregate: { type: 'string', enum: ['avg', 'sum', 'min', 'max'], description: 'Optional extra aggregate per group' },
      field: { type: 'string', description: 'Field for the extra aggregate, e.g. calendar_duration, business_duration' },
      top: { type: 'number', description: 'How many groups to return, largest first (default 10, max 25)' },
    },
    required: ['table', 'filter', 'group_by'],
  },
  async run(args, ctx) {
    const table = str(args.table, 80), filter = str(args.filter, 2048), groupBy = str(args.group_by, 120), top = num(args.top, 10, 25)
    const fn = str(args.aggregate, 10) as 'avg' | 'sum' | 'min' | 'max' | '', field = str(args.field, 120)
    await check(ctx, table, filter)
    if (!FIELD_RE.test(groupBy)) throw new ToolError(`"${groupBy}" is not a field name`)
    if (!(await fieldExists(ctx.sn, table, groupBy))) throw new ToolError(`field "${groupBy}" does not exist on ${table}; call describe_table ${table}`)
    if (fn && !['avg', 'sum', 'min', 'max'].includes(fn)) throw new ToolError('aggregate must be avg, sum, min or max')
    if (fn && !field) throw new ToolError(`aggregate ${fn} needs a field`)
    if (field && (!FIELD_RE.test(field) || !(await fieldExists(ctx.sn, table, field)))) throw new ToolError(`field "${field}" does not exist on ${table}`)
    const groups = await statsGroup(ctx.sn, table, filter, groupBy, fn && field ? { fn, field } : undefined)
    groups.sort((a, b) => b.count - a.count)
    const total = groups.reduce((s, g) => s + g.count, 0)
    const shown = groups.slice(0, top).map((g) => ({ [groupBy]: g.label, count: g.count, ...(g.agg !== undefined ? { [`${fn}_${field}`]: g.agg } : {}) }))
    return {
      data: { table, filter: filter || '(all records)', group_by: groupBy, total, groups_in_total: groups.length, groups_shown: shown.length, groups: shown },
      url: listUrl(ctx.sn.instanceUrl, table, filter),
    }
  },
}

/** Fields shown by default per table family, when the model names none. */
function defaultFields(table: string): string {
  if (table.startsWith('cmdb_ci')) return 'name,sys_class_name,operational_status,location,assigned_to'
  if (table === 'task_sla') return 'task.number,task.short_description,sla,stage,has_breached,business_percentage,planned_end_time,task.assignment_group'
  if (table === 'sysapproval_approver') return 'sysapproval,approver,state,sys_created_on'
  if (table === 'kb_knowledge') return 'number,short_description,workflow_state,sys_updated_on'
  if (table.startsWith('alm_')) return 'display_name,model,install_status,assigned_to,location'
  if (table === 'sys_user_group' || table === 'cmn_location' || table === 'core_company' || table === 'cmdb_rel_ci') return 'name'
  return 'number,short_description,state,priority,assignment_group,assigned_to,opened_at'
}

export const listRecords: ToolDef = {
  name: 'list_records',
  description:
    'Show the records that match a filter ("what are", "which ones", "show me", "list"). Returns the TRUE total from a separate count plus up to `limit` rows (max 25); ' +
    'the number of rows returned is never the total. Each row has its sys_id and a link. Not for counting: use count or aggregate for a number. ' + FILTER_DESC,
  input_schema: {
    type: 'object',
    properties: {
      table: { type: 'string' },
      filter: { type: 'string' },
      fields: { type: 'string', description: 'Comma-separated fields to show; sensible defaults per table when omitted' },
      order_by: { type: 'string', description: 'Field to sort by; prefix - for descending, e.g. -opened_at' },
      limit: { type: 'number', description: 'Rows to return, default 10, max 25' },
    },
    required: ['table', 'filter'],
  },
  async run(args, ctx) {
    const table = str(args.table, 80), filter = str(args.filter, 2048), limit = num(args.limit, 10, 25)
    const order = str(args.order_by, 120)
    if (table === 'sys_user') throw new ToolError('listing people is not available; resolve_reference can look one person up by name')
    await check(ctx, table, filter)
    const wanted = (str(args.fields, 400) || defaultFields(table)).split(',').map((f) => f.trim()).filter(Boolean)
    for (const f of wanted) {
      if (!FIELD_RE.test(f)) throw new ToolError(`"${f}" is not a field name`)
      if (DENIED_FIELDS.has(f.split('.').pop()!)) throw new ToolError(`field ${f} is not shown`)
      if (!(await fieldExists(ctx.sn, table, f))) throw new ToolError(`field "${f}" does not exist on ${table}`)
    }
    let q = filter
    if (order) {
      const desc = order.startsWith('-'), f = desc ? order.slice(1) : order
      if (!FIELD_RE.test(f) || !(await fieldExists(ctx.sn, table, f))) throw new ToolError(`cannot order by "${f}"`)
      q = [q, `ORDERBY${desc ? 'DESC' : ''}${f}`].filter(Boolean).join('^')
    }
    const [total, list] = await Promise.all([statsCount(ctx.sn, table, filter), rows(ctx.sn, table, q, ['sys_id', ...wanted].join(','), limit)])
    const records = list.map((r) => {
      const o: Record<string, string> = { sys_id: vv(r, 'sys_id') }
      for (const f of wanted) { const v = dv(r, f); if (v) o[f] = v.slice(0, 160) }
      if (SYS_ID_RE.test(o.sys_id!)) o.link = `${ctx.sn.instanceUrl}/${table}.do?sys_id=${o.sys_id}`
      return o
    })
    return {
      data: { table, filter: filter || '(all records)', total, returned: records.length, truncated: records.length < total, records },
      url: listUrl(ctx.sn.instanceUrl, table, filter),
    }
  },
}
