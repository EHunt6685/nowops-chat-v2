// describe_table and list_choices: the real schema, read from the dictionary and cached for the
// process. A filter written from these cannot name a field that does not exist or a choice label
// where a value belongs. Inherited fields come from walking the table hierarchy, so incident shows
// the task fields too.
import type { SnClient } from '../servicenow/client.js'
import { rows, dv, vv, type Row } from './fetch.js'
import { tableAllowed, DENIED_FIELDS } from './tables.js'
import { ToolError, str, type ToolDef } from './types.js'
import { TABLE_RE, FIELD_RE } from './query.js'

export interface FieldInfo { field: string; label: string; type: string; reference?: string; from?: string }

const schemaCache = new Map<string, { chain: string[]; fields: FieldInfo[] }>()
const choiceCache = new Map<string, { label: string; value: string }[]>()

/** The table and its parents, child first: incident, task. */
export async function tableChain(sn: SnClient, table: string): Promise<string[]> {
  const chain: string[] = []
  let cur: string | null = table
  while (cur && chain.length < 6) {
    chain.push(cur)
    const r: Row | undefined = (await rows(sn, 'sys_db_object', `name=${cur}`, 'name,super_class', 1))[0]
    if (!r) break
    const parent: string = vv(r, 'super_class') ? dv(r, 'super_class') : ''
    // super_class displays as the parent's label on some instances; resolve the name through the sys_id when so.
    if (vv(r, 'super_class') && !TABLE_RE.test(parent)) {
      const p: Row | undefined = (await rows(sn, 'sys_db_object', `sys_id=${vv(r, 'super_class')}`, 'name', 1))[0]
      cur = p ? dv(p, 'name') : null
    } else cur = parent || null
  }
  return chain
}

export async function describe(sn: SnClient, table: string): Promise<{ chain: string[]; fields: FieldInfo[] }> {
  const hit = schemaCache.get(table)
  if (hit) return hit
  const chain = await tableChain(sn, table)
  const dict = await rows(sn, 'sys_dictionary', `nameIN${chain.join(',')}^elementISNOTEMPTY^internal_type!=collection^active=true`, 'name,element,column_label,internal_type,reference', 600, 'all')
  const seen = new Set<string>()
  const fields: FieldInfo[] = []
  // Child table first so an overridden field keeps the child's label.
  for (const t of chain) for (const r of dict) {
    if (dv(r, 'name') !== t && vv(r, 'name') !== t) continue
    const f = vv(r, 'element')
    if (!f || seen.has(f) || DENIED_FIELDS.has(f)) continue
    seen.add(f)
    const ref = vv(r, 'reference')
    fields.push({ field: f, label: dv(r, 'column_label'), type: vv(r, 'internal_type') || dv(r, 'internal_type'), ...(ref ? { reference: ref } : {}), ...(t !== table ? { from: t } : {}) })
  }
  fields.sort((a, b) => a.field.localeCompare(b.field))
  const out = { chain, fields }
  schemaCache.set(table, out)
  return out
}

export async function choices(sn: SnClient, table: string, field: string): Promise<{ label: string; value: string }[]> {
  const key = `${table}.${field}`
  const hit = choiceCache.get(key)
  if (hit) return hit
  // Choices live on the table that defines the field; incident.state is on incident, incident.priority on task.
  const chain = await tableChain(sn, table)
  let out: { label: string; value: string }[] = []
  for (const t of chain) {
    const r = await rows(sn, 'sys_choice', `name=${t}^element=${field}^inactive=false^language=en^ORlanguageISEMPTY^ORDERBYsequence`, 'label,value', 60, 'false')
    out = r.map((x) => ({ label: String(x.label ?? ''), value: String(x.value ?? '') })).filter((c) => c.value !== '')
    if (out.length) break
  }
  choiceCache.set(key, out)
  return out
}

export const describeTable: ToolDef = {
  name: 'describe_table',
  description:
    'Fields of a table, including the ones it inherits (incident inherits from task), with label, type and the referenced table. ' +
    'Use it before writing a filter when you are not certain a field exists or what it is called. Choice values are not included: call list_choices for one field. Cached, cheap after the first call.',
  input_schema: { type: 'object', properties: { table: { type: 'string', description: 'Table name, e.g. incident' } }, required: ['table'] },
  async run(args, ctx) {
    const table = str(args.table, 80)
    if (!TABLE_RE.test(table)) throw new ToolError(`"${table}" is not a table name`)
    if (!tableAllowed(table, ctx.scanned)) throw new ToolError(`table ${table} is not available to the chatbot`)
    const d = await describe(ctx.sn, table)
    if (!d.fields.length) throw new ToolError(`no dictionary entries for ${table}; the table may not exist here`)
    return { data: { table, inherits_from: d.chain.slice(1), field_count: d.fields.length, fields: d.fields.map((f) => `${f.field} (${f.type}${f.reference ? ` → ${f.reference}` : ''}) "${f.label}"`) } }
  },
}

export const listChoices: ToolDef = {
  name: 'list_choices',
  description: 'The stored values and labels of one choice field, e.g. incident.state or incident.category. Filters compare the stored value (state=2), never the label.',
  input_schema: { type: 'object', properties: { table: { type: 'string' }, field: { type: 'string' } }, required: ['table', 'field'] },
  async run(args, ctx) {
    const table = str(args.table, 80), field = str(args.field, 80)
    if (!TABLE_RE.test(table) || !FIELD_RE.test(field) || field.includes('.')) throw new ToolError('table and field must be plain names')
    if (!tableAllowed(table, ctx.scanned)) throw new ToolError(`table ${table} is not available to the chatbot`)
    const c = await choices(ctx.sn, table, field)
    if (!c.length) return { data: { table, field, choices: [], note: `${field} on ${table} has no choice list; it may be a reference or free text. Use resolve_reference for names.` } }
    return { data: { table, field, choices: c.map((x) => `${x.value} = ${x.label}`) } }
  },
}

/** For tests and for the probe in count: a field the dictionary knows. */
export async function fieldExists(sn: SnClient, table: string, field: string): Promise<boolean> {
  const first = field.split('.')[0]!
  const d = await describe(sn, table)
  return d.fields.some((f) => f.field === first)
}
