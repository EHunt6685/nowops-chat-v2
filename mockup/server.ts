// Throwaway prototype of the NowOps onboarding flow: sign in → connect → scan → confirm →
// validate → live dashboard. Steps 3-6 hit abhrademo4 for real.
// Run: node --env-file=.env --import tsx mockup/server.ts   then open http://localhost:3100
import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadConfig } from '../src/config.js'
import { makeSnClient } from '../src/servicenow/client.js'
import { makeStats } from '../src/servicenow/stats.js'
import { mask } from '../src/log.js'
import { DEFINITIONS, fieldsOf, type Definition } from './definitions.js'
import { makeSearch } from '../src/servicenow/search.js'
import { makeLlm } from '../src/llm/client.js'
import { makeApp as makeChatApp } from '../src/server.js'

const cfg = loadConfig()
const sn = makeSnClient(cfg)
const stats = makeStats(sn)
const app = express()
app.use(express.json())
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'public')))
// The real chatbot, same ServiceNow client, same guardrails. Its /api/chat and /api/health
// live alongside the mockup's routes so "Ask NowOps" can open a chat panel on any page.
app.use(makeChatApp({ cfg, sn: makeSearch(sn), stats, llm: makeLlm(cfg) }))

// One tenant, in memory: the "small database" from the decision log, as an object.
const state: { user?: string; profile?: any; params?: Record<string, string>; confirmed?: boolean } = {}
const get = <T,>(p: string) => sn.get<T>(p).catch(() => null)
type Rec = Record<string, string>
const STANDARD_STATES: Record<string, string> = { '1': 'New', '2': 'In Progress', '3': 'On Hold', '6': 'Resolved', '7': 'Closed', '8': 'Canceled' }

// Tables to scan are derived from the definitions — the only list there is.
const TABLES: Record<string, string[]> = {}
for (const d of DEFINITIONS) if (d.kind !== 'ratio') TABLES[d.table] = [...new Set([...(TABLES[d.table] ?? []), ...fieldsOf(d)])]

app.post('/api/signin', (req, res) => { state.user = String(req.body.user || 'sdm@ust.com'); res.json({ user: state.user, tenant: 'Acme (demo tenant)' }) })

app.get('/api/connection', (_req, res) => res.json({
  instance_url: cfg.sn.instanceUrl, client_id: mask(cfg.sn.clientId), credential: 'held in secrets store (prefilled from .env)',
}))

app.post('/api/scan', async (_req, res) => {
  const tables: Record<string, any> = {}
  for (const [table, fields] of Object.entries(TABLES)) {
    const r = await get<{ result: Rec[] }>(`/api/now/table/${table}?sysparm_fields=sys_id,${fields.join(',')}&sysparm_limit=1`)
    if (!r) { tables[table] = { present: false }; continue }
    const rec = r.result[0]
    const cnt = await get<{ result: { stats: { count: string } } }>(`/api/now/stats/${table}?sysparm_count=true`)
    tables[table] = { present: true, rows: cnt ? Number(cnt.result.stats.count) : null, missing_fields: rec ? fields.filter((f) => !(f in rec)) : [] }
  }
  // Incident states: the client's labels for the standard six, plus every custom state —
  // in use or merely defined — because a ticket can move into a defined state tomorrow.
  const ch = await get<{ result: Rec[] }>(`/api/now/table/sys_choice?sysparm_query=${encodeURIComponent('name=incident^element=state^inactive=false^language=en')}&sysparm_fields=value,label`)
  const choices = (ch?.result ?? []).sort((a, b) => Number(a.value) - Number(b.value))
  const seen = await get<{ result: { groupby_fields: { value: string }[]; stats: { count: string } }[] }>(`/api/now/stats/incident?sysparm_count=true&sysparm_group_by=state`)
  const inUse = Object.fromEntries((seen?.result ?? []).map((r) => [r.groupby_fields[0]!.value, Number(r.stats.count)]))
  const standard_states = Object.entries(STANDARD_STATES).map(([value, shipped]) => ({ value, shipped, label: choices.find((c) => c.value === value)?.label ?? '(not defined)', count: inUse[value] ?? 0 }))
  const customValues = new Set([...choices.map((c) => c.value), ...Object.keys(inUse)].filter((v) => !(v in STANDARD_STATES)))
  const custom_states = [...customValues].sort((a, b) => Number(a) - Number(b)).map((value) => ({
    value, label: choices.find((c) => c.value === value)?.label ?? '(in use but not in choice list)', count: inUse[value] ?? 0, default: 'open',
  }))
  // SLA definitions: candidates per priority. Exactly one match → shown read-only.
  const slas = await get<{ result: Rec[] }>(`/api/now/table/contract_sla?sysparm_query=${encodeURIComponent('collection=incident^type=SLA^active=true^target=resolution')}&sysparm_fields=sys_id,name,duration&sysparm_display_value=true&sysparm_limit=50`)
  const slaList = slas?.result ?? []
  const sla_matches = Object.fromEntries([1, 2, 3, 4].map((p) => {
    const candidates = slaList.filter((s) => new RegExp(`\\b(P${p}|Priority ${p})\\b`, 'i').test(s.name))
    return [`sla_p${p}_resolution`, { priority: p, candidates, selected: candidates.length === 1 ? candidates[0]!.sys_id : '', sure: candidates.length === 1 }]
  }))
  state.profile = { scanned_at: new Date().toISOString(), tables, standard_states, custom_states, sla_definitions: slaList, sla_matches }
  state.params = undefined; state.confirmed = undefined
  res.json(state.profile)
})

/** Build tenant parameters from the confirm step (or from the scan's defaults when skipped). */
function applyParams(slas: Record<string, string>, openExtra: string[], confirmed: boolean) {
  state.params = { ...slas, open_states: ['1', '2', '3', ...openExtra].join(',') }
  state.confirmed = confirmed
}
app.post('/api/confirm', (req, res) => { applyParams(req.body.slas, req.body.open_states ?? [], true); res.json({ ...state.params, confirmed: true }) })
app.post('/api/skip-confirm', (_req, res) => {
  const p = state.profile
  const slas = Object.fromEntries(Object.entries(p.sla_matches).map(([k, m]: [string, any]) => [k, m.selected]))
  applyParams(slas, p.custom_states.map((s: any) => s.value), false) // conservative default: custom states count as open
  res.json({ ...state.params, confirmed: false })
})

const resolved = (filter: string) => filter.replace(/\{\{(\w+)\}\}/g, (_, k) => state.params?.[k] || `{{${k}}}`)
const usesParam = (d: Definition) => d.kind !== 'ratio' && /\{\{/.test(d.filter)

function validate() {
  const rows = DEFINITIONS.map((d) => {
    if (d.kind === 'ratio') return { ...d, status: 'derived', reason: `${d.num} ÷ ${d.den}` }
    const t = state.profile?.tables[d.table]
    let status = 'available', reason = ''
    if (!t?.present) { status = 'unavailable'; reason = `table ${d.table} not present` }
    else {
      const miss = fieldsOf(d).filter((f) => t.missing_fields.includes(f))
      if (miss.length) { status = 'unavailable'; reason = `field ${miss.join(', ')} not on ${d.table}` }
      else if (/\{\{/.test(resolved(d.filter))) { status = 'unavailable'; reason = 'no matching SLA record on this instance' }
    }
    return { ...d, filter_resolved: resolved(d.filter), status, reason, assumed: usesParam(d) && state.confirmed === false }
  })
  // a ratio is available only if both parts are
  for (const r of rows) if (r.kind === 'ratio') {
    const parts = [r.num, r.den].map((id) => rows.find((x) => x.id === id))
    if (parts.some((p) => !p || p.status !== 'available')) { r.status = 'unavailable'; r.reason = 'a component is unavailable' }
    else { r.status = 'available'; (r as any).assumed = parts.some((p) => (p as any).assumed) }
  }
  return rows
}
app.get('/api/validate', (_req, res) => res.json(validate()))

/** Run `fn` over `items` with at most `n` in flight. ServiceNow handles a handful of parallel reads fine. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!) }))
}
/** Short-lived cache (D-003): live values drift by the minute and a dashboard tolerates that. */
const CACHE_MS = 3 * 60_000
const cache = new Map<string, { at: number; value: unknown }>()
const cached = async <T,>(key: string, make: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T
  const value = await make(); cache.set(key, { at: Date.now(), value }); return value
}

app.get('/api/dashboard', async (req, res) => {
  const group = String(req.query.group ?? '').trim()
  const rows: any[] = await cached(`dash:${group}:${JSON.stringify(state.params)}`, async () => {
  const rows: any[] = validate()
  await pool(rows.filter((d) => d.status === 'available' && d.kind !== 'ratio'), 6, async (d) => {
    const extra = group && d.table === 'incident' ? `^assignment_group.name=${group}` : ''
    try {
      const r = await stats.run({ table: d.table, filter: (d.filter_resolved + extra).replace(/^\^/, ''), aggregate: d.aggregate, field: d.field })
      Object.assign(d, { filter_resolved: r.filter, value: r.value, url: r.url })
      // Tier B: the table and field exist, but zero rows means "no data yet", not "zero".
      if (d.tier === 'B' && r.value === 0) { d.status = 'no data yet'; d.reason = 'table and field exist; nothing recorded on this instance' }
    } catch (e) { d.status = 'error'; d.reason = (e as Error).message }
  })
  return rows
  })
  for (const d of rows) if (d.kind === 'ratio' && d.status === 'available') {
    const n = rows.find((x) => x.id === d.num), m = rows.find((x) => x.id === d.den)
    d.value = m?.value ? `${(100 * Number(n.value) / Number(m.value)).toFixed(1)}%` : '—'
    d.filter_resolved = `${n?.filter_resolved || '(all)'}  ÷  ${m?.filter_resolved || '(all)'}`
    d.detail = `${Number(n?.value).toLocaleString('en-US')} ÷ ${Number(m?.value).toLocaleString('en-US')}`
  }
  res.json(rows)
})

// ---- Series for the QBR charts. Every series is a set of live aggregates; the filter
// behind each point is returned so the page can show it on hover.
const enc = encodeURIComponent
const count = async (table: string, q: string) => {
  const r = await get<{ result: { stats: { count: string } } }>(`/api/now/stats/${table}?sysparm_count=true&sysparm_query=${enc(q)}`)
  return r ? Number(r.result.stats.count) : null
}
/** ServiceNow durations arrive as "354 08:06:46" or "08:06:46"; charts want hours. */
const hours = (s: string | null | undefined) => {
  if (!s) return null
  const m = /^(?:(\d+) )?(\d+):(\d+):(\d+)$/.exec(s.trim()); if (!m) return null
  return Number(m[1] ?? 0) * 24 + Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600
}
const monthQ = (f: string, i: number) => `${f}BETWEENjavascript:gs.monthsAgoStart(${i})@javascript:gs.monthsAgoEnd(${i})`
const monthLabel = (i: number) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); return d.toLocaleString('en', { month: 'short' }) }

app.get('/api/series', async (_req, res) => {
  const open = state.params?.open_states ?? '1,2,3'
  const out = await cached(`series:${open}`, async () => {
    const slaBase = 'stage=completed^sla.type=SLA^task.sys_class_name=incident'
    const out: any = { months: [], attainment: [], mttr: [], aging: [] }
    const jobs: (() => Promise<void>)[] = []
    for (let i = 5; i >= 0; i--) {
      const m: any = { label: monthLabel(i), opened_q: monthQ('opened_at', i), resolved_q: monthQ('resolved_at', i) }
      out.months.push(m)
      jobs.push(async () => { m.opened = await count('incident', m.opened_q) }, async () => { m.resolved = await count('incident', m.resolved_q) },
        async () => { m.met = await count('task_sla', `${monthQ('sys_created_on', i)}^${slaBase}^has_breached=false`) },
        async () => { m.breached = await count('task_sla', `${monthQ('sys_created_on', i)}^${slaBase}^has_breached=true`) })
    }
    for (const p of [1, 2, 3, 4]) {
      const q = `${slaBase}^task.priority=${p}`, a: any = { priority: `P${p}`, q }; out.attainment.push(a)
      jobs.push(async () => { a.met = await count('task_sla', `${q}^has_breached=false`); a.all = await count('task_sla', q); a.pct = a.met !== null && a.all ? 100 * a.met / a.all : null })
      const mq = `stateIN6,7^priority=${p}`, mt: any = { priority: `P${p}`, q: mq }; out.mttr.push(mt)
      jobs.push(async () => { const r = await stats.run({ table: 'incident', filter: mq, aggregate: 'avg', field: 'calendar_duration' }).catch(() => null); mt.hours = hours(r ? String(r.value) : null); mt.raw = r?.value ?? null; mt.n = await count('incident', mq) })
    }
    const buckets: [string, string][] = [['0–7 d', 'opened_at>=javascript:gs.daysAgoStart(7)'], ['7–30 d', 'opened_at<javascript:gs.daysAgoStart(7)^opened_at>=javascript:gs.daysAgoStart(30)'], ['30–90 d', 'opened_at<javascript:gs.daysAgoStart(30)^opened_at>=javascript:gs.daysAgoStart(90)'], ['90+ d', 'opened_at<javascript:gs.daysAgoStart(90)']]
    for (const [label, bq] of buckets) {
      const row: any = { bucket: label, q: `stateIN${open}^${bq}` }; out.aging.push(row)
      for (const p of [1, 2, 3, 4]) jobs.push(async () => { row[`P${p}`] = await count('incident', `stateIN${open}^priority=${p}^${bq}`) })
    }
    await pool(jobs, 6, (j) => j())
    return out
  })
  res.json(out)
})

// Generic breakdown: one GROUP BY over a live table, display values, top N with the rest folded.
app.get('/api/breakdown', async (req, res) => {
  const table = String(req.query.table ?? ''), by = String(req.query.by ?? ''), top = Number(req.query.top ?? 8)
  const q = resolved(String(req.query.q ?? ''))
  if (!/^[a-z0-9_]+$/.test(table) || !/^[a-z0-9_.]+(,[a-z0-9_.]+)?$/.test(by)) return res.status(400).json({ error: 'bad table or field' })
  const out = await cached(`bd:${table}:${by}:${q}:${top}`, async () => {
    const r = await get<{ result: { groupby_fields: { value: string; display_value?: string }[]; stats: { count: string } }[] }>(
      `/api/now/stats/${table}?sysparm_count=true&sysparm_display_value=true&sysparm_group_by=${by}&sysparm_query=${enc(q)}`)
    const rows = (r?.result ?? []).map((x) => ({
      k: x.groupby_fields.map((g) => g.display_value || g.value || '(empty)').join(' × '), v: Number(x.stats.count), raw: x.groupby_fields[0]!.value,
      keys: x.groupby_fields.map((g) => g.display_value || g.value || '(empty)'),
    })).sort((a, b) => b.v - a.v)
    const head = rows.slice(0, top), rest = rows.slice(top)
    if (rest.length) head.push({ k: `Other (${rest.length})`, v: rest.reduce((a, b) => a + b.v, 0), raw: '' })
    return { table, by, q, rows: head }
  })
  res.json(out)
})

// ---- Estate lens (Application 360): services, one application's picture, a generic read-only list.
const ID = /^[a-f0-9]{32}$/
app.get('/api/services', async (_req, res) => {
  res.json(await cached('services', async () => {
    const r = await get<{ result: Rec[] }>(`/api/now/table/cmdb_ci_service?sysparm_fields=sys_id,name,busines_criticality&sysparm_limit=100&sysparm_orderby=name`)
    return (r?.result ?? []).map((s) => ({ id: s.sys_id, name: s.name, criticality: s.busines_criticality }))
  }))
})

/** Everything about one service: ticket counts scoped to it, and two levels of CMDB dependencies. */
app.get('/api/app', async (req, res) => {
  const id = String(req.query.service ?? '')
  if (!ID.test(id)) return res.status(400).json({ error: 'bad service id' })
  res.json(await cached(`app:${id}:${state.params?.open_states}`, async () => {
    const open = state.params?.open_states ?? '1,2,3'
    const q: Record<string, string> = {
      incidents_all: `business_service=${id}`, incidents_open: `business_service=${id}^stateIN${open}`, incidents_p1p2_open: `business_service=${id}^stateIN${open}^priorityIN1,2`,
      changes: `cmdb_ci=${id}`, problems: `business_service=${id}`, sla_breached: `task.business_service=${id}^has_breached=true`,
    }
    const t: Record<string, string> = { incidents_all: 'incident', incidents_open: 'incident', incidents_p1p2_open: 'incident', changes: 'change_request', problems: 'problem', sla_breached: 'task_sla' }
    const counts: Record<string, { value: number | null; table: string; filter: string; url: string }> = {}
    await pool(Object.keys(q), 6, async (k) => { counts[k] = { value: await count(t[k]!, q[k]!), table: t[k]!, filter: q[k]!, url: `${cfg.sn.instanceUrl}/${t[k]}_list.do?sysparm_query=${enc(q[k]!)}` } })
    return { counts }
  }))
})

/** Read-only list for table-shaped tiles (the rights/cost table). Fields and table are shape-checked. */
app.get('/api/list', async (req, res) => {
  const table = String(req.query.table ?? ''), fields = String(req.query.fields ?? ''), order = String(req.query.order ?? ''), limit = Math.min(Number(req.query.limit ?? 10), 50)
  if (!/^[a-z0-9_]+$/.test(table) || !/^[a-z0-9_.,]+$/.test(fields) || !/^-?[a-z0-9_.]*$/.test(order)) return res.status(400).json({ error: 'bad table, fields or order' })
  const ord = order ? (order.startsWith('-') ? `&sysparm_orderby=${order.slice(1)}DESC` : `&sysparm_orderby=${order}`) : ''
  res.json(await cached(`list:${table}:${fields}:${order}:${limit}`, async () => {
    const r = await get<{ result: Rec[] }>(`/api/now/table/${table}?sysparm_fields=${fields}&sysparm_display_value=true&sysparm_limit=${limit}${ord}${order.startsWith('-') ? `&sysparm_query=ORDERBYDESC${order.slice(1)}` : ''}`)
    return { table, fields: fields.split(','), rows: r?.result ?? [] }
  }))
})

app.listen(3100, () => console.log('mockup at http://localhost:3100'))
