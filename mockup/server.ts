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
app.use(makeChatApp({ cfg, sn: makeSearch(sn), stats, llm: makeLlm(cfg), kpis: { match: matchKpi }, allowedTables: scannedTables }))

// One tenant, in memory: the "small database" from the decision log, as an object.
const state: { user?: string; profile?: any; params?: Record<string, string>; confirmed?: boolean } = {}
const get = <T,>(p: string) => sn.get<T>(p).catch(() => null)
type Rec = Record<string, string>
const STANDARD_STATES: Record<string, string> = { '1': 'New', '2': 'In Progress', '3': 'On Hold', '6': 'Resolved', '7': 'Closed', '8': 'Canceled' }

// Tables to scan are derived from the definitions — the only list there is.
const TABLES: Record<string, string[]> = {}
for (const d of DEFINITIONS) if (d.kind !== 'ratio') TABLES[d.table] = [...new Set([...(TABLES[d.table] ?? []), ...fieldsOf(d)])]

app.post('/api/signin', (req, res) => { state.user = String(req.body.user || 'sdm@ust.com'); res.json({ user: state.user, tenant: 'Acme (demo tenant)' }) })
// Who is signed in, for the app header. Null until /api/signin has run; the page falls back to its own default.
app.get('/api/me', (_req, res) => res.json({ user: state.user ?? null, tenant: 'Acme (demo tenant)' }))

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

// ---- The chatbot reads the definitions before it writes a query (D-004).
// A counting question that names a KPI runs that KPI's own resolved filter, so "open" means what the
// dashboard says it means. Matching is by words: every word of the definition's name must be in the
// question after the same normalisation ("incidents" and "tickets" are one word here). The longest
// matching name wins, so "open p1 tickets" beats "open tickets". Ratios and unavailable rows never match.
const normalise = (s: string) => ` ${s.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9%> ]/g, ' ').replace(/\b(incidents?|tickets?|tkts?)\b/g, 'tickets').replace(/\bpriority ?1\b|\bcritical\b/g, 'p1').replace(/\bpriority ?2\b/g, 'p2').replace(/\bbreach(ed|es|ing)?\b/g, 'breaches').replace(/\bchanges?\b/g, 'changes').replace(/\bproblems?\b/g, 'problems').replace(/\bslas?\b/g, 'sla').replace(/\s+/g, ' ')} `
const NAME_STOP = new Set(['now', 'with', 'a', 'the', 'of', 'and', 'or', '>', '%'])
function matchKpi(question: string) {
  const q = normalise(question)
  let best: { d: Definition; n: number } | null = null
  for (const d of validate()) {
    if (d.kind === 'ratio' || d.status !== 'available') continue
    const words = normalise(d.name).trim().split(' ').filter((w) => w && !NAME_STOP.has(w))
    if (!words.length || !words.every((w) => q.includes(` ${w} `))) continue
    if (!best || words.length > best.n) best = { d, n: words.length }
  }
  if (!best || best.d.kind === 'ratio') return null
  const d = best.d
  return { id: d.id, name: d.name, meaning: d.meaning, request: { table: d.table, filter: resolved(d.filter), aggregate: d.aggregate, ...(d.field ? { field: d.field } : {}), label: d.name.toLowerCase().replace(/\s*\(.*?\)/g, '') } }
}
/** Tables the instance scan found. Null before a scan: nothing to check against, so nothing is rejected. */
function scannedTables() { return state.profile ? new Set(Object.entries(state.profile.tables as Record<string, { present: boolean }>).filter(([, t]) => t.present).map(([k]) => k)) : null }

/** Run `fn` over `items` with at most `n` in flight. ServiceNow handles a handful of parallel reads fine. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!) }))
}
/** Short-lived cache (D-003): live values drift by the minute and a dashboard tolerates that. */
const CACHE_MS = 3 * 60_000
const cache = new Map<string, { at: number; value: unknown }>()
// Identical requests that arrive while one is still computing share that computation (the page
// prefetches a queue while the user may already be opening it).
const inflight = new Map<string, Promise<unknown>>()
const cached = async <T,>(key: string, make: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T
  const pending = inflight.get(key); if (pending) return pending as Promise<T>
  const p = make().then((value) => { cache.set(key, { at: Date.now(), value }); return value }).finally(() => inflight.delete(key))
  inflight.set(key, p); return p
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
  // Before the scan, {{open_states}} is still a placeholder; sending it would return nothing and look like "no rows".
  if (/\{\{/.test(q)) return res.status(409).json({ error: 'instance not scanned yet: run the onboarding scan, then reload' })
  // A failed or timed-out read is an error, never an empty result. Caching an empty answer for three
  // minutes made a slow group-by look like "no rows" on every reload.
  let r: { result: { groupby_fields: { value: string; display_value?: string }[]; stats: { count: string } }[] }
  try { r = await cached(`bd:${table}:${by}:${q}:${top}`, () => sn.get(`/api/now/stats/${table}?sysparm_count=true&sysparm_display_value=true&sysparm_group_by=${by}&sysparm_query=${enc(q)}`)) }
  catch (e) { return res.status(502).json({ error: `ServiceNow did not answer: ${(e as Error).message}` }) }
  {
    const rows = (r?.result ?? []).map((x) => ({
      k: x.groupby_fields.map((g) => g.display_value || g.value || '(empty)').join(' × '), v: Number(x.stats.count), raw: x.groupby_fields[0]!.value,
      keys: x.groupby_fields.map((g) => g.display_value || g.value || '(empty)'),
    })).sort((a, b) => b.v - a.v)
    const head = rows.slice(0, top), rest = rows.slice(top)
    if (rest.length) head.push({ k: `Other (${rest.length})`, v: rest.reduce((a, b) => a + b.v, 0), raw: '' })
    res.json({ table, by, q, rows: head })
  }
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

// =====================================================================================
// Resolve: the fulfiller's page. Everything below reads the instance live. The rules that
// rank a queue are data (id, meaning, query) so the page can show the reason behind every
// position, the way dashboard tiles show their recipe. The model is optional: when it is
// unreachable, or LLM_MODE=stub, drafts are assembled from the same records by rules and
// labelled as such. Writes are off unless RESOLVE_WRITES=true; otherwise they are dry runs.
// =====================================================================================
const llm = makeLlm(cfg)
const search = makeSearch(sn)
const WRITES = process.env.RESOLVE_WRITES === 'true'
const openStates = () => state.params?.open_states ?? '1,2,3'
type Dv = { value: string; display_value: string }
type Row = Record<string, Dv>
const dv = (r: Row | undefined, f: string) => r?.[f]?.display_value ?? ''
const vv = (r: Row | undefined, f: string) => r?.[f]?.value ?? ''
const rows = async (table: string, q: string, fields: string, limit = 100, order = ''): Promise<Row[]> => {
  const r = await get<{ result: Row[] }>(`/api/now/table/${table}?sysparm_query=${enc(q + (order ? `^${order}` : ''))}&sysparm_fields=${fields}&sysparm_display_value=all&sysparm_limit=${limit}`)
  return r?.result ?? []
}
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))
const daysSince = (s: string) => s ? Math.max(0, (Date.now() - new Date(s.replace(' ', 'T') + 'Z').getTime()) / 86_400_000) : 0
const INC_FIELDS = 'sys_id,number,short_description,description,priority,impact,urgency,state,assignment_group,assigned_to,caller_id,category,cmdb_ci,opened_at,sys_updated_on,sys_updated_by,reopen_count,close_code,close_notes,hold_reason'
/** Close notes that teach nothing. Measured on abhrademo4: bulk clean-ups and scripts. */
const JUNK_NOTE = /demo data|remediation for Memorial|closed via script|data cleanup|not available from (the )?provided information/i
const FIXED = /work(?:ing|s|ed) (?:fine|now|again|ok)|(?:issue|problem) (?:is |was |has been )?(?:resolved|fixed)|resolved the issue|is resolved|fixed the/i
const STOP = new Set('the a an and or of to in on for is are with this that my not can cannot unable issue error please help via when from'.split(' '))
const words = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
/** Distinct significant words the two titles share. Distinct, or "Account … Account Lock" counts twice. */
const overlap = (a: string, b: string) => { const A = new Set(words(a)); return new Set(words(b).filter((w) => A.has(w))).size }
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ')

/** The ranking rules. `q` is the ServiceNow filter a reader can run to check the claim. */
const RULES = [
  { id: 'priority', name: 'High priority', meaning: 'P1 and P2 come before everything else', q: 'priorityIN1,2' },
  { id: 'sla', name: 'SLA breached or at risk', meaning: 'An active SLA on the ticket has breached, or is past 80% of its time', q: 'task_sla: active=true^(has_breached=true^ORbusiness_percentage>80)' },
  { id: 'reply_owed', name: 'Caller replied, no answer yet', meaning: 'The latest journal entry is a caller comment newer than the last work note', q: 'sys_journal_field: element=comments newer than element=work_notes' },
  { id: 'fixed_open', name: 'Fixed in the notes, never closed', meaning: 'The last work note says it works, but the state is still open', q: 'work_notes matches /working fine|resolved|fixed/ and state in open states' },
  { id: 'recurring', name: 'Same title on other open tickets', meaning: 'Three or more open incidents share this exact short description', q: 'active=true^short_description=<title>' },
  { id: 'knowledge', name: 'A knowledge article matches', meaning: 'Text search on the title returns a published article whose title shares two or more significant words', q: 'kb_knowledge: workflow_state=published^123TEXTQUERY321=<title>' },
  { id: 'unassigned', name: 'Nobody owns it', meaning: 'In your group queue with no assignee', q: 'assigned_toISEMPTY' },
  { id: 'age', name: 'Waiting a long time', meaning: 'Days since opened, one point per week up to fifteen', q: 'opened_at' },
]

app.get('/api/resolve/rules', (_req, res) => res.json({ rules: RULES, writes: WRITES, llm: cfg.llmMode }))

/** People with open tickets, so a reviewer can look at the queue as one of them. */
app.get('/api/resolve/people', async (_req, res) => {
  res.json(await cached(`people:${openStates()}`, async () => {
    // display_value=all returns both the sys_id and the name per group; =true returns only the name.
    const r = await get<{ result: { groupby_fields: Dv[]; stats: { count: string } }[] }>(`/api/now/stats/incident?sysparm_count=true&sysparm_display_value=all&sysparm_group_by=assigned_to&sysparm_query=${enc(`stateIN${openStates()}^assigned_toISNOTEMPTY`)}`)
    return (r?.result ?? []).map((x) => ({ id: x.groupby_fields[0]!.value, name: x.groupby_fields[0]!.display_value, open: Number(x.stats.count) }))
      .filter((p) => ID.test(p.id) && p.name && !/agent|system|integration/i.test(p.name)).sort((a, b) => b.open - a.open).slice(0, 12)
  }))
})

async function userOf(id: string) {
  const [[u], gm] = await Promise.all([rows('sys_user', `sys_id=${id}`, 'sys_id,name,user_name,email', 1), rows('sys_user_grmember', `user=${id}`, 'group', 50)])
  return { id, name: dv(u, 'name'), user_name: vv(u, 'user_name'), groups: gm.map((g) => ({ id: vv(g, 'group'), name: dv(g, 'group') })) }
}

app.get('/api/resolve/queue', async (req, res) => {
  const as = String(req.query.as ?? '')
  if (!ID.test(as)) return res.status(400).json({ error: 'pick a person: ?as=<sys_user sys_id>' })
  res.json(await cached(`queue:${as}:${openStates()}`, async () => {
    const open = openStates()
    // The person's own tickets do not depend on their groups, so both reads start at once.
    const [me, mine] = await Promise.all([userOf(as), rows('incident', `stateIN${open}^assigned_to=${as}`, INC_FIELDS, 100, 'ORDERBYpriority^ORDERBYopened_at')])
    const gq = me.groups.length ? await rows('incident', `stateIN${open}^assignment_groupIN${me.groups.map((g) => g.id).join(',')}^assigned_toISEMPTY`, INC_FIELDS, 200, 'ORDERBYpriority^ORDERBYopened_at') : []
    // The dashboard counts unconfirmed custom states as open (D-005, the safe default for a
    // count). A work queue must not hand someone a ticket whose state label says it is finished.
    const all = [...mine, ...gq].filter((r) => !/cancel|closed|resolved/i.test(dv(r, 'state')))
    const ids = all.map((r) => vv(r, 'sys_id'))
    // SLA and journal state for every candidate, in chunks of 50 ids. Every chunk is fetched in
    // parallel; the chunks hold disjoint ids, so merge order does not matter, and within a chunk
    // the journal comes newest first so the first entry seen per ticket is the latest.
    const sla: Record<string, { breached: boolean; pct: number; breach_time: string; breach_raw: string }> = {}
    const journal: Record<string, { lastComment?: string; lastNote?: string; lastNoteText?: string }> = {}
    const chunks = chunk(ids, 50)
    const [slaRows, jRows] = await Promise.all([
      Promise.all(chunks.map((c) => rows('task_sla', `active=true^taskIN${c.join(',')}`, 'task,has_breached,business_percentage,breach_time', 200))),
      Promise.all(chunks.map((c) => rows('sys_journal_field', `element_idIN${c.join(',')}^elementINcomments,work_notes`, 'element_id,element,value,sys_created_on', 500, 'ORDERBYDESCsys_created_on'))),
    ])
    for (const s of slaRows.flat()) {
      const t = vv(s, 'task'), pct = Number(vv(s, 'business_percentage')) || 0, b = vv(s, 'has_breached') === 'true'
      const cur = sla[t]; if (!cur || b || pct > cur.pct) sla[t] = { breached: b || !!cur?.breached, pct: Math.max(pct, cur?.pct ?? 0), breach_time: dv(s, 'breach_time'), breach_raw: vv(s, 'breach_time') }
    }
    for (const j of jRows.flat()) {
      const t = vv(j, 'element_id'); journal[t] ??= {}
      if (vv(j, 'element') === 'comments' && !journal[t]!.lastComment) journal[t]!.lastComment = vv(j, 'sys_created_on')
      if (vv(j, 'element') === 'work_notes' && !journal[t]!.lastNote) { journal[t]!.lastNote = vv(j, 'sys_created_on'); journal[t]!.lastNoteText = vv(j, 'value') }
    }
    const titleCount: Record<string, number> = {}
    for (const r of all) { const t = norm(vv(r, 'short_description')); titleCount[t] = (titleCount[t] ?? 0) + 1 }
    const scored = all.map((r) => {
      const id = vv(r, 'sys_id'), pri = Number(vv(r, 'priority')), j = journal[id] ?? {}, s = sla[id], days = daysSince(vv(r, 'opened_at'))
      const reasons: { rule: string; text: string }[] = []; let score = 0
      if (pri <= 2) { score += pri === 1 ? 40 : 30; reasons.push({ rule: 'priority', text: `P${pri}` }) }
      if (s?.breached) { score += 50; reasons.push({ rule: 'sla', text: 'SLA breached' }) } else if (s && s.pct > 80) { score += 35; reasons.push({ rule: 'sla', text: `SLA at ${Math.round(s.pct)}%, breaches ${s.breach_time}` }) }
      const replyOwed = !!(j.lastComment && (!j.lastNote || j.lastComment > j.lastNote))
      if (replyOwed) { score += 30; reasons.push({ rule: 'reply_owed', text: `caller wrote on ${j.lastComment!.slice(0, 10)}, no work note since` }) }
      if (j.lastNoteText && FIXED.test(j.lastNoteText)) { score += 25; reasons.push({ rule: 'fixed_open', text: `last work note (${j.lastNote!.slice(0, 10)}) says it works, ticket still open` }) }
      const same = titleCount[norm(vv(r, 'short_description'))] ?? 0
      if (same >= 3) { score += 15; reasons.push({ rule: 'recurring', text: `same title on ${same} open tickets in your scope` }) }
      if (!vv(r, 'assigned_to')) { score += 10; reasons.push({ rule: 'unassigned', text: 'unassigned in your group queue' }) }
      const ageScore = Math.min(15, Math.floor(days / 7)); if (ageScore) { score += ageScore; reasons.push({ rule: 'age', text: `${Math.round(days)} days open` }) }
      // Flags the browse filters use. SLA "soon" = breached, or breaching within two hours.
      const soon = !!s && (s.breached || (!!s.breach_raw && new Date(s.breach_raw.replace(' ', 'T') + 'Z').getTime() - Date.now() < 2 * 3_600_000))
      return { sys_id: id, number: vv(r, 'number'), title: vv(r, 'short_description'), priority: dv(r, 'priority'), state: dv(r, 'state'), caller: dv(r, 'caller_id'), group: dv(r, 'assignment_group'), assigned_to: dv(r, 'assigned_to') || null, opened_at: vv(r, 'opened_at'), updated_at: vv(r, 'sys_updated_on'), updated_by: vv(r, 'sys_updated_by'), days: Math.round(days), score, reasons, kb: null as null | { number: string; title: string; url: string }, also: [] as string[],
        flags: { mine: vv(r, 'assigned_to') === as, group: !vv(r, 'assigned_to'), sla: soon, waiting: replyOwed, reopened: Number(vv(r, 'reopen_count')) > 0, changed: daysSince(vv(r, 'sys_updated_on')) < 4 / 24 } }
    }).sort((a, b) => b.score - a.score)
    // One row per distinct title: eight identical "account is inactive" tickets are one job, not eight.
    const top: typeof scored = [], seen: Record<string, (typeof scored)[number]> = {}
    for (const t of scored) { const k = norm(t.title); if (seen[k]) { seen[k]!.also.push(t.number); continue } seen[k] = t; if (top.length < 10) top.push(t) }
    // Knowledge match for the top ten only: one text search each.
    await pool(top, 10, async (t) => {
      const hits = await search.search(t.title).catch(() => [])
      const h = hits.find((a) => overlap(t.title, a.title) >= 2)
      if (h) { t.kb = { number: h.label ?? '', title: h.title, url: h.url }; t.score += 10; t.reasons.push({ rule: 'knowledge', text: `${h.label} "${first(h.title, 60)}" may answer it` }) }
    })
    top.sort((a, b) => b.score - a.score)
    // Browse lists: the same candidates, filtered, newest change first. Reasons are omitted; the list is the point.
    const lite = (t: (typeof scored)[number]) => { const { reasons, kb, also, flags, score, ...rest } = t; return rest }
    const browse: Record<string, ReturnType<typeof lite>[]> = {}
    for (const k of ['mine', 'group', 'sla', 'waiting', 'reopened', 'changed'] as const) browse[k] = scored.filter((t) => t.flags[k]).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(lite)
    return { me, counts: { mine: mine.length, group_unassigned: gq.length, group_capped: gq.length >= 200, distinct: Object.keys(seen).length, finished_label: mine.length + gq.length - all.length }, queue: top.map((t) => { const { flags, ...rest } = t; return rest }), browse }
  }))
})

/** Everything about one ticket, from the instance. Cached briefly; drafts read from this cache. */
type Fix = { fields: Record<string, string>; value: string; evidence: string }
type Check = { key: string; label: string; ok: boolean; current: string; fix?: Fix; ask?: string; alt?: { label: string; action: string } }
const majority = <T,>(xs: T[]): [T, number] | null => { const c = new Map<T, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); const top = [...c].sort((a, b) => b[1] - a[1])[0]; return top ? [top[0], top[1]] : null }
// A configuration item matters when the fault is about a thing, not an account or a request.
const CI_CATEGORY = /hardware|network|software|database|server|infrastructure/i
const CI_WORDS = /\b(laptop|desktop|pc|mac|printer|monitor|phone|wifi|wi-fi|vpn|network|server|database|outlook|teams|application|app|website|portal)\b/i
async function ticketChecks(r: Rec, journal: { kind: string; text: string }[], similar: { number: string; group: string; group_id: string; category: string; category_label: string }[], who: { name: string; kind: string; n: number }[]): Promise<Check[]> {
  const caller = vv(r, 'caller_id'), callerName = dv(r, 'caller_id'), first = callerName.split(' ')[0] || 'the caller'
  const out: Check[] = []
  out.push({ key: 'caller', label: 'Caller', ok: !!caller, current: callerName, ask: caller ? undefined : 'Find out who reported it' })
  const desc = vv(r, 'description').trim()
  out.push({ key: 'description', label: 'What happened', ok: desc.length >= 20, current: desc ? first_(desc, 60) : 'empty', ask: desc.length >= 20 ? undefined : `Ask ${first} what happens, since when, on which device` })
  // Configuration item, only where one is expected: the CI on the caller's recent tickets, else the hardware assigned to them.
  const ciExpected = !!vv(r, 'cmdb_ci') || CI_CATEGORY.test(dv(r, 'category') + ' ' + dv(r, 'assignment_group')) || CI_WORDS.test(vv(r, 'short_description') + ' ' + desc)
  let ciFix: Fix | undefined
  if (ciExpected && !vv(r, 'cmdb_ci') && caller) {
    const prev = await rows('incident', `caller_id=${caller}^cmdb_ciISNOTEMPTY^sys_id!=${vv(r, 'sys_id')}`, 'cmdb_ci', 6, 'ORDERBYDESCopened_at').catch(() => [] as Rec[])
    const m = majority(prev.map((p) => vv(p, 'cmdb_ci')))
    if (m && m[1] >= 2) ciFix = { fields: { cmdb_ci: m[0] }, value: dv(prev.find((p) => vv(p, 'cmdb_ci') === m[0])!, 'cmdb_ci'), evidence: `on ${m[1]} of ${first}'s last ${prev.length} tickets` }
    else { const hw = (await rows('alm_hardware', `assigned_to=${caller}^ciISNOTEMPTY`, 'ci', 1).catch(() => [] as Rec[]))[0]; if (hw) ciFix = { fields: { cmdb_ci: vv(hw, 'ci') }, value: dv(hw, 'ci'), evidence: `hardware assigned to ${first}` } }
  }
  if (ciExpected) out.push({ key: 'cmdb_ci', label: 'Configuration item', ok: !!vv(r, 'cmdb_ci'), current: dv(r, 'cmdb_ci') || 'empty', fix: ciFix, ask: vv(r, 'cmdb_ci') || ciFix ? undefined : `Ask ${first} which device or service` })
  // Category: what the resolved look-alikes were filed under.
  const cat = majority(similar.filter((s) => s.category).map((s) => s.category))
  const catOk = !!vv(r, 'category') && !(cat && cat[1] >= 2 && cat[1] === similar.filter((s) => s.category).length && cat[0] !== vv(r, 'category'))
  const catFix = cat && (!vv(r, 'category') || !catOk) ? { fields: { category: cat[0] }, value: similar.find((s) => s.category === cat[0])!.category_label, evidence: `${cat[1]} of ${similar.length} resolved look-alikes` } : undefined
  out.push({ key: 'category', label: 'Category', ok: catOk, current: dv(r, 'category') || 'empty', fix: catFix })
  // Priority: ServiceNow sets it from impact and urgency, so a populated value is the agent's call and stays as it is.
  out.push({ key: 'priority', label: 'Priority', ok: !!vv(r, 'priority'), current: dv(r, 'priority') || 'empty', ask: vv(r, 'priority') ? undefined : 'Set impact and urgency on the record' })
  // Assignment group: who actually closed the look-alikes, only when the field is empty.
  const g = who.find((w) => w.kind === 'group'), gid = g ? similar.find((s) => s.group === g.name)?.group_id : undefined
  out.push({ key: 'assignment_group', label: 'Assignment group', ok: !!vv(r, 'assignment_group'), current: dv(r, 'assignment_group') || 'empty', fix: !vv(r, 'assignment_group') && g && gid ? { fields: { assignment_group: gid }, value: g.name, evidence: `closed ${g.n} similar ticket${g.n === 1 ? '' : 's'}` } : undefined })
  // Assigned to: the person who closed the look-alikes, or the agent takes it themselves.
  const p = who.find((w) => w.kind === 'person'), pid = p ? similar.find((s) => s.resolved_by === p.name)?.resolved_by_id : undefined
  out.push({ key: 'assigned_to', label: 'Assigned to', ok: !!vv(r, 'assigned_to'), current: dv(r, 'assigned_to') || 'nobody', fix: !vv(r, 'assigned_to') && p && pid && ID.test(pid) ? { fields: { assigned_to: pid }, value: p.name, evidence: `closed ${p.n} similar ticket${p.n === 1 ? '' : 's'}` } : undefined, alt: vv(r, 'assigned_to') ? undefined : { label: 'Assign to me', action: 'claim' } })
  const lastNote = [...journal].reverse().find((j) => j.kind === 'work_notes')
  if (lastNote && FIXED.test(lastNote.text)) out.push({ key: 'confirm', label: 'Caller confirmation', ok: false, current: 'last work note says it works', ask: `Ask ${first} to confirm it is fixed` })
  return out
}
const first_ = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s

async function ticketDetail(number: string) {
  return cached(`ticket:${number}`, async () => {
    const r = (await rows('incident', `number=${number}`, INC_FIELDS, 1))[0]
    if (!r) return null
    const id = vv(r, 'sys_id'), title = vv(r, 'short_description')
    const fields: Record<string, string> = {}
    for (const f of INC_FIELDS.split(',')) fields[f] = dv(r, f)
    const raw: Record<string, string> = {}; for (const f of ['state', 'priority', 'assigned_to', 'assignment_group', 'caller_id', 'sys_updated_by', 'reopen_count']) raw[f] = vv(r, f)
    // Everything below depends only on the record just read, so the five reads go out together.
    const simQ = `stateIN6,7^close_notesISNOTEMPTY^sys_id!=${id}^123TEXTQUERY321=${title.replace(/[\^=&]/g, ' ').slice(0, 150)}`
    const sameQ = `active=true^short_description=${title}^sys_id!=${id}`
    const [jRaw, slaRaw, simRaw, sameRaw, kbRaw] = await Promise.all([
      rows('sys_journal_field', `element_id=${id}^elementINcomments,work_notes`, 'element,value,sys_created_on,sys_created_by', 40, 'ORDERBYsys_created_on'),
      rows('task_sla', `task=${id}^active=true`, 'sla,has_breached,business_percentage,breach_time,stage', 10),
      rows('incident', simQ, 'sys_id,number,short_description,close_notes,close_code,resolved_by,assignment_group,resolved_at,opened_at,category', 8),
      rows('incident', sameQ, 'sys_id,number,caller_id,assignment_group,assigned_to,opened_at,state', 10),
      search.search(title).catch(() => []),
    ])
    const journal = jRaw.map((j) => ({ kind: vv(j, 'element'), text: vv(j, 'value'), at: vv(j, 'sys_created_on'), by: vv(j, 'sys_created_by') }))
    const slas = slaRaw.map((s) => ({ name: dv(s, 'sla'), breached: vv(s, 'has_breached') === 'true', pct: Number(vv(s, 'business_percentage')) || 0, breach_time: dv(s, 'breach_time'), stage: dv(s, 'stage') }))
    const similar = simRaw.filter((s) => !JUNK_NOTE.test(vv(s, 'close_notes'))).slice(0, 4)
      .map((s) => ({ number: vv(s, 'number'), title: vv(s, 'short_description'), close_notes: vv(s, 'close_notes'), close_code: dv(s, 'close_code'), resolved_by: dv(s, 'resolved_by'), resolved_by_id: vv(s, 'resolved_by'), group: dv(s, 'assignment_group'), group_id: vv(s, 'assignment_group'), category: vv(s, 'category'), category_label: dv(s, 'category'), resolved_at: vv(s, 'resolved_at'), opened_at: vv(s, 'opened_at'), url: `${cfg.sn.instanceUrl}/incident.do?sys_id=${vv(s, 'sys_id')}` }))
    const sameTitle = sameRaw.map((s) => ({ number: vv(s, 'number'), caller: dv(s, 'caller_id'), group: dv(s, 'assignment_group'), assigned_to: dv(s, 'assigned_to'), opened_at: vv(s, 'opened_at'), state: dv(s, 'state') }))
    const kb = kbRaw.slice(0, 3).map((a) => ({ number: a.label ?? '', title: a.title, url: a.url, excerpt: a.body.slice(0, 220), match: overlap(title, a.title) >= 2 }))
    // Who to bring in: people and groups who actually closed the similar tickets.
    const tally: Record<string, { name: string; kind: 'person' | 'group'; n: number; tickets: string[] }> = {}
    for (const s of similar) for (const [name, kind] of [[s.resolved_by, 'person'], [s.group, 'group']] as const) if (name) { tally[kind + name] ??= { name, kind, n: 0, tickets: [] }; tally[kind + name]!.n++; tally[kind + name]!.tickets.push(s.number) }
    const who = Object.values(tally).sort((a, b) => b.n - a.n)
    // Readiness: what is missing from the record itself. The model can add "what this fault type needs" on top.
    const missing: string[] = []
    if (!vv(r, 'caller_id')) missing.push('Who reported it: the caller field is empty')
    if (!vv(r, 'description') || vv(r, 'description').trim().length < 20) missing.push('What happened: the description is empty or one line')
    if (!vv(r, 'cmdb_ci')) missing.push('Which device or service: no configuration item')
    if (!journal.some((j) => j.kind === 'comments')) missing.push('Nothing from the caller yet: no comments on the ticket')
    const lastNote = [...journal].reverse().find((j) => j.kind === 'work_notes')
    if (lastNote && FIXED.test(lastNote.text)) missing.push('Caller confirmation: the last work note says it works, the caller has not said so')
    const readiness = Math.max(1, 10 - missing.length * 2)
    // Ticket check: one line per thing a workable record has. A gap carries a proposed value with its
    // evidence where the instance can supply one, otherwise the fix is to ask the caller.
    const checks = await ticketChecks(r, journal, similar, who)
    return { number, sys_id: id, title, fields, raw, journal, slas, similar, sameTitle, kb, who, missing, readiness, checks, url: `${cfg.sn.instanceUrl}/incident.do?sys_id=${id}`,
      queries: { similar: simQ, sameTitle: sameQ, kb: `kb_knowledge: workflow_state=published^123TEXTQUERY321=${title}` } }
  })
}
app.get('/api/resolve/ticket/:number', async (req, res) => {
  const n = String(req.params.number).toUpperCase()
  if (!/^INC\d{7,10}$/.test(n)) return res.status(400).json({ error: 'incident number expected' })
  const d = await ticketDetail(n)
  if (!d) return res.status(404).json({ error: `${n} not found` })
  res.json(d)
})

// ---- Drafts. Rules first (always available), the model on top when reachable.
type Detail = NonNullable<Awaited<ReturnType<typeof ticketDetail>>>
const section = (notes: string, name: string) => { const m = new RegExp(`${name}[^:\\n]*:\\s*([\\s\\S]*?)(?:\\n\\s*\\n|\\n[A-Z][A-Za-z ]+:|$)`, 'i').exec(notes); return m?.[1]?.trim() ?? '' }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const first = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s)

function stepsByRules(d: Detail) {
  const steps: { text: string; source: string }[] = []
  const caller = d.fields.caller_id || 'the caller'
  const lastNote = [...d.journal].reverse().find((j) => j.kind === 'work_notes')
  if (lastNote && FIXED.test(lastNote.text)) steps.push({ text: `Ask ${caller} whether it has stayed fixed since ${lastNote.at.slice(0, 10)}. The last work note says it works but nobody confirmed with the caller.`, source: `work note of ${lastNote.at.slice(0, 10)}` })
  if (d.missing.some((m) => m.startsWith('Who reported') || m.startsWith('What happened'))) steps.push({ text: `Ask ${caller} what exactly happens, since when, and which device: the ticket does not say.`, source: 'empty caller or description on the record' })
  // One step per distinct fix: two look-alikes closed with the same note are one step, citing both.
  const seenFix = new Map<string, { text: string; source: string }>()
  for (const s of d.similar) {
    const res = first((section(s.close_notes, 'Resolution') || section(s.close_notes, 'Actions Taken') || s.close_notes).replace(/\s+/g, ' '), 200)
    const k = norm(res); const cite = `${s.number}, closed ${s.resolved_at.slice(0, 10)}${s.resolved_by ? ' by ' + s.resolved_by : ''}`
    if (seenFix.has(k)) { seenFix.get(k)!.source += `; also ${s.number}`; continue }
    if (seenFix.size >= 2) continue
    const st = { text: `Try what closed ${s.number}: ${res}`, source: cite }; seenFix.set(k, st); steps.push(st)
  }
  for (const k of d.kb.filter((k) => k.match).slice(0, 1)) steps.push({ text: `Follow ${k.number} "${k.title}".`, source: `${k.number}, published knowledge` })
  if (d.sameTitle.length >= 2) steps.push({ text: `Raise one problem record and link the ${d.sameTitle.length + 1} open tickets with this exact title, so one fix closes them all.`, source: `${d.sameTitle.length} other open incidents with the same short description` })
  if (!d.fields.cmdb_ci) steps.push({ text: 'Record the affected device or service as the configuration item.', source: 'configuration item is empty' })
  steps.push({ text: `When ${caller} confirms, resolve with the close note drafted below.`, source: 'standard verification step' })
  return steps
}
const STEPS_SYSTEM = `You write next steps for an IT service desk agent. Use ONLY the facts supplied. Return JSON only: {"steps":[{"text":"one concrete action, one sentence","source":"which supplied item it came from, e.g. INC0012158 close note, KB0010463, work note of 2026-08-24, or 'inferred'"}]}. Five to seven steps, in the order verify, act, test, confirm with caller, document, resolve. Never invent ticket or article numbers.`
const DRAFT_SYSTEM = `You draft text for an IT service desk agent from supplied ticket records. Use ONLY the supplied facts. Wrap text copied or closely paraphrased from the supplied work notes in <mark class="rec">…</mark>, and anything inferred from similar tickets or not yet confirmed in <mark class="inf">…</mark>. Return exactly the format requested, no preamble.`
function facts(d: Detail) {
  return [`TICKET ${d.number}: ${d.title}`, `Fields: priority ${d.fields.priority}; state ${d.fields.state}; group ${d.fields.assignment_group}; assigned to ${d.fields.assigned_to || 'nobody'}; caller ${d.fields.caller_id || 'not recorded'}; category ${d.fields.category}; CI ${d.fields.cmdb_ci || 'none'}; opened ${d.fields.opened_at}`,
    `Description: ${d.fields.description || '(empty)'}`, `Journal:\n${d.journal.map((j) => `[${j.at}] ${j.kind} by ${j.by}: ${first(j.text.replace(/\s+/g, ' '), 300)}`).join('\n') || '(none)'}`,
    `Similar resolved tickets:\n${d.similar.map((s) => `${s.number} (${s.resolved_at.slice(0, 10)}, ${s.resolved_by || s.group}): ${first(s.close_notes.replace(/\s+/g, ' '), 500)}`).join('\n') || '(none)'}`,
    `Knowledge articles:\n${d.kb.map((k) => `${k.number} "${k.title}": ${k.excerpt}`).join('\n') || '(none)'}`,
    `Open tickets with the same title: ${d.sameTitle.map((s) => s.number).join(', ') || 'none'}`, `Ticket check, open lines: ${d.checks.filter((c) => !c.ok).map((c) => `${c.label} is ${c.current}${c.fix ? ` (proposed: ${c.fix.value})` : ''}`).join('; ') || 'none, the record is complete'}`].join('\n\n')
}
const audit: { at: string; who: string; what: string; record: string; evidence: string; dryRun?: boolean }[] = []
const logAudit = (who: string, what: string, record: string, evidence: string, dryRun?: boolean) => { audit.unshift({ at: new Date().toISOString(), who, what, record, evidence, dryRun }); if (audit.length > 200) audit.pop() }
/** One model call, logged with what it saw. Null when the model is off or unreachable. */
async function model(kind: string, d: Detail, system: string, user: string) {
  if (cfg.llmMode === 'stub') return null
  const out = await llm.draft(system, user)
  logAudit('NowOps', `Model call: ${kind}. ${d.journal.length} journal entries, ${d.kb.length} articles, ${d.similar.length} similar tickets in prompt (${user.length} chars).`, d.number, out ? 'answered' : 'no answer, rules used')
  return out
}

app.post('/api/resolve/steps/:number', async (req, res) => {
  const d = await ticketDetail(String(req.params.number).toUpperCase()); if (!d) return res.status(404).json({ error: 'not found' })
  const raw = await model('suggested steps', d, STEPS_SYSTEM, facts(d))
  if (raw) { try { const j = JSON.parse(raw.replace(/```json|```/g, '').trim()); if (Array.isArray(j.steps) && j.steps.length) return res.json({ source: 'model', steps: j.steps.slice(0, 7) }) } catch { /* fall through to rules */ } }
  res.json({ source: 'rules', steps: stepsByRules(d) })
})

// "Where this stands": two sentences, model only, and only when there is more to read than fits on
// screen. A one-line ticket gets nothing; the description is already in view.
const BRIEF_SYSTEM = `You brief an IT service desk agent who is about to work a ticket. Use ONLY the supplied facts. Write at most two plain sentences: what is wrong, what has been done so far, and what is blocking or what happens next. Every claim must be traceable to a supplied field, journal entry or SLA. Do not restate the ticket number, state or priority. Do not say more review is needed. If the facts do not support a sentence, leave it out. Plain text.`
app.post('/api/resolve/brief/:number', async (req, res) => {
  const d = await ticketDetail(String(req.params.number).toUpperCase()); if (!d) return res.status(404).json({ error: 'not found' })
  const enough = (d.fields.description || '').length > 300 || d.journal.length >= 3 || Number(d.raw.reopen_count) > 0
  if (!enough) return res.json({ text: null, reason: 'short ticket, the record speaks for itself' })
  if (cfg.llmMode === 'stub') return res.json({ text: null, reason: 'model off' })
  const slaLine = d.slas.map((s) => `${s.name}: ${s.breached ? 'breached' : Math.round(s.pct) + '% used'}`).join('; ') || 'none'
  const out = await model('brief', d, BRIEF_SYSTEM, `${facts(d)}\n\nSLAs: ${slaLine}\nReopened: ${d.raw.reopen_count || 0} times`)
  res.json({ text: out ? out.trim().split(/\n+/).slice(0, 2).join(' ') : null, reason: out ? undefined : 'model gave no answer' })
})

app.post('/api/resolve/draft/:number', async (req, res) => {
  const d = await ticketDetail(String(req.params.number).toUpperCase()); if (!d) return res.status(404).json({ error: 'not found' })
  const kind = String(req.body?.kind ?? 'close')
  const notes = d.journal.filter((j) => j.kind === 'work_notes' && !/^\[?AURA|SOP is not identified/i.test(j.text))
  const caller = d.fields.caller_id || 'the caller'
  const sim = d.similar[0]
  let html = '', title = ''
  if (kind === 'close') {
    const req_ = `Write resolution notes with exactly these headings on their own lines: Problem / Actions taken / Root cause / Resolution. Plain prose, past tense, 60-120 words total. Then on a final line: CLOSE_CODE: one of Solved (Permanently), Solved (Workaround/Temporarily), Not Solved (Not Reproducible), Closed/Resolved by Caller, Duplicate.`
    const m = await model('close note', d, DRAFT_SYSTEM, `${facts(d)}\n\n${req_}`)
    if (m) html = m.replace(/^(Problem|Actions taken|Root cause|Resolution)\s*:?\s*$/gim, '<h4>$1</h4').replace(/\n(?=CLOSE_CODE)/, '\n\n')
    else {
      const acts = notes.length ? notes.map((n) => `<mark class="rec">${esc(first(n.text.replace(/\s+/g, ' '), 220))}</mark>`).join(' ') : `<mark class="inf">No work notes were recorded. Steps you tick will appear here.</mark>`
      const rc = sim ? `<mark class="inf">${esc(first(section(sim.close_notes, 'Root Cause') || 'To be confirmed.', 240))}${section(sim.close_notes, 'Root Cause') ? ` (as recorded on ${sim.number})` : ''}</mark>` : '<mark class="inf">To be confirmed.</mark>'
      const last = [...notes].reverse()[0]
      const reso = last && FIXED.test(last.text) ? `<mark class="rec">${esc(first(last.text.replace(/\s+/g, ' '), 220))}</mark> <mark class="inf">Caller confirmation pending.</mark>` : sim ? `<mark class="inf">${esc(first(section(sim.close_notes, 'Resolution') || section(sim.close_notes, 'Actions Taken') || sim.close_notes.replace(/\s+/g, ' '), 260))} (what closed ${sim.number}; confirm it applies here)</mark>` : '<mark class="inf">Pending.</mark>'
      html = `<h4>Problem</h4>${esc(caller)} reported: ${esc(d.title.replace(/[.\s]+$/, ''))}. Category ${esc(d.fields.category || 'not set')}, group ${esc(d.fields.assignment_group)}, priority ${esc(d.fields.priority)}.\n<h4>Actions taken</h4>${acts}\n<h4>Root cause</h4>${rc}\n<h4>Resolution</h4>${reso}\n\nCLOSE_CODE: ${sim?.close_code || 'Solved (Permanently)'}`
    }
  } else if (kind === 'kb') {
    title = d.title
    const m = await model('knowledge article', d, DRAFT_SYSTEM, `${facts(d)}\n\nWrite a knowledge article with headings on their own lines: Symptom / Cause / Fix / Prevention. Numbered fix steps. Under 150 words. If a supplied article already covers this, end with a line: UPDATE_INSTEAD: <article number>.`)
    if (m) html = m.replace(/^(Symptom|Cause|Fix|Prevention)\s*:?\s*$/gim, '<h4>$1</h4>')
    else {
      const fix = sim ? section(sim.close_notes, 'Resolution') || section(sim.close_notes, 'Actions Taken') || sim.close_notes : ''
      html = `<h4>Symptom</h4>${esc(d.fields.description || d.title)}\n<h4>Cause</h4><mark class="inf">${esc(first((sim && section(sim.close_notes, 'Root Cause')) || 'To be confirmed from the resolution.', 240))}</mark>\n<h4>Fix</h4><mark class="inf">${esc(first(fix.replace(/\s+/g, ' ') || 'To be written once the ticket is resolved.', 400))}</mark>\n<h4>Prevention</h4><mark class="inf">To be added by the reviewer.</mark>${d.kb[0]?.match ? `\n\nUPDATE_INSTEAD: ${d.kb[0].number}` : ''}`
    }
  } else if (kind === 'message') {
    // Only what the caller can answer, taken from Ticket check: an open line with no proposed value.
    const gaps = d.checks.filter((c) => !c.ok && !c.fix && c.ask && ['description', 'cmdb_ci', 'caller'].includes(c.key))
    const asks = gaps.map((c) => c.ask!.replace(/^Ask \S+ /, ''))
    const confirm = d.checks.some((c) => c.key === 'confirm' && !c.ok)
    const m = await model('message to caller', d, DRAFT_SYSTEM, `${facts(d)}\n\nWrite a short, friendly comment to ${caller} from the agent. ${confirm ? 'The last work note says it works: ask them to confirm it is fixed, and say the ticket closes on their yes.' : asks.length ? `Ask only for: ${asks.join('; ')}.` : 'Ask them to confirm it is still happening.'} The comments in the journal are the caller's own replies: never ask for anything they have already given there, and acknowledge what they did give. Under 80 words. Plain text, no markup.`)
    html = m ? esc(m) : `Hi ${esc(caller.split(' ')[0]!)}, I am picking up your ticket "${esc(d.title)}"${d.fields.opened_at ? ` from ${d.fields.opened_at.slice(0, 10)}` : ''}. ${confirm ? 'The notes suggest it was fixed. Can you confirm it is still working? If yes, I will close the ticket.' : asks.length ? `To move it forward I need: ${asks.join('; ')}.` : 'Could you confirm it is still happening?'} Thanks.`
  } else if (kind === 'problem') {
    html = `${esc(d.title)}\n\n${d.sameTitle.length + 1} open incidents share this exact title: ${[d.number, ...d.sameTitle.map((s) => s.number)].join(', ')}.${sim ? ` ${d.similar.length} earlier one${d.similar.length > 1 ? 's were' : ' was'} closed (${d.similar.map((s) => s.number).join(', ')}); the recorded resolution on ${sim.number} was: ${esc(first((section(sim.close_notes, 'Resolution') || sim.close_notes).replace(/\s+/g, ' '), 300))}` : ''}`
    title = `Recurring: ${d.title}`
  } else return res.status(400).json({ error: 'kind must be close, kb, message or problem' })
  res.json({ kind, title, html, source: cfg.llmMode === 'stub' ? 'rules' : 'model or rules' })
})

// ---- Writes. A whitelist of incident fields, one PATCH, always audited. Dry run unless RESOLVE_WRITES=true.
const HOLD: Record<string, string> = { 'Awaiting Caller': '1', 'Awaiting Change': '5', 'Awaiting Problem': '4', 'Awaiting Vendor': '3' }
app.post('/api/resolve/write', async (req, res) => {
  const { number, action, payload = {}, as } = req.body ?? {}
  const d = await ticketDetail(String(number ?? '').toUpperCase()); if (!d) return res.status(404).json({ error: 'not found' })
  const who = String(as || 'nowops-mockup')
  const text = (s: unknown) => String(s ?? '').slice(0, 4000)
  let table = 'incident', method: 'PATCH' | 'POST' = 'PATCH', path = `/api/now/table/incident/${d.sys_id}`, body: Record<string, string> = {}, what = ''
  switch (action) {
    case 'work_note': body = { work_notes: text(payload.text) }; what = 'Work note'; break
    case 'comment': body = { comments: text(payload.text) }; what = 'Comment to caller'; break
    case 'claim': if (!ID.test(String(payload.user))) return res.status(400).json({ error: 'user sys_id required' }); body = { assigned_to: payload.user, work_notes: 'Picked up via NowOps.' }; if (d.raw.state === '1') body.state = '2'; what = 'Claimed'; break
    case 'hold': body = { state: '3', hold_reason: HOLD[payload.reason] ?? '1', work_notes: text(payload.note || `Put on hold (${payload.reason || 'Awaiting Caller'}) via NowOps.`) }; what = `On hold, ${payload.reason || 'Awaiting Caller'}`; break
    case 'reassign': {
      if (payload.group) { const g = (await rows('sys_user_group', `name=${text(payload.group)}^active=true`, 'sys_id', 1))[0]; if (!g) return res.status(400).json({ error: `group "${payload.group}" not found` }); body.assignment_group = vv(g, 'sys_id'); body.assigned_to = '' }
      if (payload.user) { const u = (await rows('sys_user', `name=${text(payload.user)}^active=true`, 'sys_id', 1))[0]; if (!u) return res.status(400).json({ error: `user "${payload.user}" not found` }); body.assigned_to = vv(u, 'sys_id') }
      body.work_notes = text(payload.note || `Handed over via NowOps: ${payload.reason || 'has closed the matching tickets on this instance'}.`); what = `Handed to ${payload.group || payload.user}`; break }
    case 'resolve': body = { state: '6', close_code: text(payload.close_code || 'Solved (Permanently)'), close_notes: text(payload.close_notes), work_notes: 'Resolved via NowOps.' }; what = 'Resolved'; break
    case 'kb_draft': table = 'kb_knowledge'; method = 'POST'; path = '/api/now/table/kb_knowledge'; body = { short_description: text(payload.title || d.title), text: text(payload.text), workflow_state: 'draft', description: `Drafted by NowOps from ${d.number}. Review before publishing.` }; what = 'Created Draft knowledge article'; break
    case 'problem': table = 'problem'; method = 'POST'; path = '/api/now/table/problem'; body = { short_description: text(payload.title || d.title), description: text(payload.text), first_reported_by_task: d.sys_id }; what = 'Raised problem record'; break
    case 'fields': {
      // Ticket check fixes: only these fields, reference fields must be sys_ids, choice fields short values.
      const allowed: Record<string, RegExp> = { cmdb_ci: ID, assignment_group: ID, assigned_to: ID, category: /^[\w .\-/]{1,40}$/ }
      const f = (payload.fields ?? {}) as Record<string, unknown>, labels: string[] = []
      for (const [k, v] of Object.entries(f)) { if (!(k in allowed)) return res.status(400).json({ error: `field ${k} not allowed` }); if (!allowed[k]!.test(String(v))) return res.status(400).json({ error: `bad value for ${k}` }); body[k] = String(v); labels.push(k.replace('_', ' ')) }
      if (!labels.length) return res.status(400).json({ error: 'no fields' })
      body.work_notes = `Record completed via NowOps: ${labels.join(', ')}.`; what = `Completed ${labels.join(', ')}`; break }
    default: return res.status(400).json({ error: 'unknown action' })
  }
  const evidence = `${method} ${table} · ${Object.keys(body).join(', ')}`
  if (!WRITES) { logAudit(who, `${what} (dry run, RESOLVE_WRITES is off)`, d.number, evidence, true); return res.json({ dryRun: true, table, method, sys_id: d.sys_id, body, message: 'Nothing was written. Set RESOLVE_WRITES=true to write to the instance.' }) }
  try {
    const r = await sn.send<{ result: Rec }>(method, path, body)
    cache.delete(`ticket:${d.number}`); for (const k of [...cache.keys()]) if (k.startsWith('queue:')) cache.delete(k)
    logAudit(who, what, d.number, evidence)
    res.json({ dryRun: false, table, method, sys_id: r.result?.sys_id ?? d.sys_id, number: r.result?.number ?? d.number, body })
  } catch (e) { res.status(502).json({ error: (e as Error).message }) }
})
app.get('/api/resolve/audit', (_req, res) => res.json({ writes: WRITES, entries: audit }))

// On Windows a second bind to a port that another Node process already serves does not fail: the
// new process prints its banner and exits with code 0, which reads as "it turned off instantly".
// Probe the port first so a running copy is named, and treat any listen error as fatal and loud.
const PORT = Number(process.env.MOCKUP_PORT) || 3100
fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) }).then(
  () => { console.error(`Another NowOps mockup is already serving http://localhost:${PORT}. Use that one, or stop it and start again.`); process.exit(1) },
  () => {
    const srv = app.listen(PORT, () => console.log(`mockup at http://localhost:${PORT}`))
    srv.on('error', (e: Error) => { console.error(`Cannot listen on port ${PORT}: ${e.message}`); process.exit(1) })
  },
)
