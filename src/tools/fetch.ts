// Thin helpers over the Table and Stats APIs for the tools. Display values and sys_ids come back
// together so the model reads names and the server keeps ids.
import type { SnClient } from '../servicenow/client.js'
import { enc } from './types.js'

export type Row = Record<string, unknown>

/** With sysparm_display_value=all every field is { display_value, value }; this reads one side. */
export const dv = (r: Row, f: string): string => { const v = r[f]; return v && typeof v === 'object' ? String((v as { display_value?: unknown }).display_value ?? '') : v == null ? '' : String(v) }
export const vv = (r: Row, f: string): string => { const v = r[f]; return v && typeof v === 'object' ? String((v as { value?: unknown }).value ?? '') : v == null ? '' : String(v) }

export async function rows(sn: SnClient, table: string, query: string, fields: string, limit: number, display: 'all' | 'true' | 'false' = 'all'): Promise<Row[]> {
  const p = new URLSearchParams({ sysparm_fields: fields, sysparm_limit: String(limit), sysparm_display_value: display, sysparm_exclude_reference_link: 'true' })
  if (query) p.set('sysparm_query', query)
  return (await sn.get<{ result?: Row[] }>(`/api/now/table/${table}?${p}`)).result ?? []
}

interface StatsRow { groupby_fields?: { field: string; value: string; display_value?: string }[]; stats: { count?: string } & Record<string, unknown> }

/** A true total from the Stats API. Never the length of a page. */
export async function statsCount(sn: SnClient, table: string, query: string): Promise<number> {
  const p = new URLSearchParams({ sysparm_count: 'true' })
  if (query) p.set('sysparm_query', query)
  const body = await sn.get<{ result?: StatsRow }>(`/api/now/stats/${table}?${p}`)
  const n = Number(body.result?.stats?.count)
  if (!Number.isFinite(n)) throw new Error('ServiceNow returned no count')
  return n
}

/** One grouped Stats call: count per group, plus one optional aggregate of a field. Labels are display values. */
export async function statsGroup(sn: SnClient, table: string, query: string, groupBy: string, agg?: { fn: 'avg' | 'sum' | 'min' | 'max'; field: string }): Promise<{ value: string; label: string; count: number; agg?: string }[]> {
  const p = new URLSearchParams({ sysparm_count: 'true', sysparm_group_by: groupBy, sysparm_display_value: 'true' })
  if (agg) p.set(`sysparm_${agg.fn}_fields`, agg.field)
  if (query) p.set('sysparm_query', query)
  const body = await sn.get<{ result?: StatsRow[] }>(`/api/now/stats/${table}?${p}`)
  return (body.result ?? []).map((r) => {
    const g = r.groupby_fields?.[0]
    const a = agg ? (r.stats[agg.fn] as Record<string, string> | undefined)?.[agg.field] : undefined
    return { value: g?.value ?? '', label: g?.display_value || g?.value || '(empty)', count: Number(r.stats.count ?? 0), ...(a !== undefined ? { agg: a } : {}) }
  })
}

export const listUrl = (instanceUrl: string, table: string, query: string) => `${instanceUrl}/${table}_list.do?sysparm_query=${enc(query)}`
export const recordUrl = (instanceUrl: string, table: string, sysId: string) => `${instanceUrl}/${table}.do?sys_id=${sysId}`
