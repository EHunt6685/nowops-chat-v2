// Throwaway prototype of the NowOps onboarding flow: sign in → connect → scan → confirm →
// validate → live dashboard. Steps 3-6 hit abhrademo4 for real.
// Run: node --env-file=.env --import tsx mockup/server.ts   then open http://localhost:3100
import express from 'express'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadConfig } from '../src/config.js'
import { makeSnClient } from '../src/servicenow/client.js'
import { makeStats } from '../src/servicenow/stats.js'
import { log, mask } from '../src/log.js'
import { DEFINITIONS, fieldsOf, makeDefinitions } from '../src/definitions.js'
import { makeSearch } from '../src/servicenow/search.js'
import { makeLlm } from '../src/llm/client.js'
import { makeApp as makeChatApp } from '../src/server.js'
import { sameSystem, classifyOutcome, isNowOpsNote, describePrecedent, noEvidence, type Outcome } from '../src/resolve/evidence.js'

const cfg = loadConfig()
const sn = makeSnClient(cfg)
const stats = makeStats(sn)
const app = express()
app.use(express.json())
// The front door is the sign-in page; app-preview.html is the one page, from sign-in to dashboard, Resolve and chat.
app.get('/', (_req, res) => res.sendFile(join(dirname(fileURLToPath(import.meta.url)), 'public', 'app-preview.html')))
// Pages change often while this is a prototype. no-cache means the browser revalidates every time (the ETag
// makes that cheap), so nobody runs yesterday's page script against today's server.
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }))
// The real chatbot, same ServiceNow client, same guardrails. Its /api/chat and /api/health
// live alongside the mockup's routes so "Ask NowOps" can open a chat panel on any page.

// One tenant, in memory: the "small database" from the decision log, as an object.
const state: { profile?: any; params?: Record<string, string>; confirmed?: boolean } = {}
// One source of truth for what a tile counts; before the scan every table reads as not present.
const defs = makeDefinitions(() => ({ params: state.params, tables: state.profile?.tables ?? {}, confirmed: state.confirmed }))
app.use(makeChatApp({ cfg, sn: makeSearch(sn), stats, llm: makeLlm(cfg), kpis: defs, allowedTables: scannedTables }))
// Every ServiceNow request goes through here; the count is what a scan reports, so the read can show its work.
let snCalls = 0
const get = <T,>(p: string) => { snCalls++; return sn.get<T>(p).catch(() => null) }
type Rec = Record<string, string>
const STANDARD_STATES: Record<string, string> = { '1': 'New', '2': 'In Progress', '3': 'On Hold', '6': 'Resolved', '7': 'Closed', '8': 'Canceled' }

// Tables to scan are derived from the definitions — the only list there is.
const TABLES: Record<string, string[]> = {}
for (const d of DEFINITIONS) if (d.kind !== 'ratio') TABLES[d.table] = [...new Set([...(TABLES[d.table] ?? []), ...fieldsOf(d)])]

// Who is signed in, for the app header. Null until /api/signin has run; the page falls back to its own default.
// Sign-in is on the page, not the server: the page keeps the signed-in name itself and reads only the tenant here.
app.get('/api/me', (_req, res) => res.json({ user: null, tenant: 'Acme (demo tenant)' }))

app.get('/api/connection', (_req, res) => res.json({
  instance_url: cfg.sn.instanceUrl, client_id: mask(cfg.sn.clientId), credential: 'held in secrets store (prefilled from .env)',
}))

app.post('/api/scan', async (_req, res) => {
  const t0 = Date.now(), c0 = snCalls
  const tables: Record<string, any> = {}
  // Five tables at a time: the read is watched live, and one at a time took most of it.
  const tablesP = pool(Object.entries(TABLES), 5, async ([table, fields]) => {
    // One timeout must not record a table as absent: every definition on it would go dark. Probe twice.
    const probe = () => get<{ result: Rec[] }>(`/api/now/table/${table}?sysparm_fields=sys_id,${fields.join(',')}&sysparm_limit=1`)
    const r = (await probe()) ?? (await probe())
    // Still nothing: a network failure is "unknown", not "absent". Keep the last good scan's answer for
    // this table if there was one; otherwise mark it unreachable so the reason shows on the tile.
    if (!r) { const prev = state.profile?.tables?.[table]; tables[table] = prev?.present ? { ...prev, stale: true } : { present: false, reason: 'not reachable during the scan; re-run the scan' }; return }
    const rec = r.result[0]
    const cnt = await get<{ result: { stats: { count: string } } }>(`/api/now/stats/${table}?sysparm_count=true`)
    tables[table] = { present: true, rows: cnt ? Number(cnt.result.stats.count) : null, missing_fields: rec ? fields.filter((f) => !(f in rec)) : [] }
  })
  // Incident states: the client's labels for the standard six, plus every custom state —
  // in use or merely defined — because a ticket can move into a defined state tomorrow.
  const chP = get<{ result: Rec[] }>(`/api/now/table/sys_choice?sysparm_query=${encodeURIComponent('name=incident^element=state^inactive=false^language=en')}&sysparm_fields=value,label`)
  const ch = await chP
  const choices = (ch?.result ?? []).sort((a, b) => Number(a.value) - Number(b.value))
  const seenP = get<{ result: { groupby_fields: { value: string }[]; stats: { count: string } }[] }>(`/api/now/stats/incident?sysparm_count=true&sysparm_group_by=state`)
  const seen = await seenP
  const inUse = Object.fromEntries((seen?.result ?? []).map((r) => [r.groupby_fields[0]!.value, Number(r.stats.count)]))
  const standard_states = Object.entries(STANDARD_STATES).map(([value, shipped]) => ({ value, shipped, label: choices.find((c) => c.value === value)?.label ?? '(not defined)', count: inUse[value] ?? 0 }))
  const customValues = new Set([...choices.map((c) => c.value), ...Object.keys(inUse)].filter((v) => !(v in STANDARD_STATES)))
  const custom_states = [...customValues].sort((a, b) => Number(a) - Number(b)).map((value) => ({
    value, label: choices.find((c) => c.value === value)?.label ?? '(in use but not in choice list)', count: inUse[value] ?? 0, default: 'open',
  }))
  // SLA definitions: candidates per priority. Exactly one match → shown read-only.
  const slasP = get<{ result: Rec[] }>(`/api/now/table/contract_sla?sysparm_query=${encodeURIComponent('collection=incident^type=SLA^active=true^target=resolution')}&sysparm_fields=sys_id,name,duration&sysparm_display_value=true&sysparm_limit=50`)
  const slaList = (await slasP)?.result ?? []
  const sla_matches = Object.fromEntries([1, 2, 3, 4].map((p) => {
    const candidates = slaList.filter((s) => new RegExp(`\\b(P${p}|Priority ${p})\\b`, 'i').test(s.name))
    return [`sla_p${p}_resolution`, { priority: p, candidates, selected: candidates.length === 1 ? candidates[0]!.sys_id : '', sure: candidates.length === 1 }]
  }))
  await tablesP  // states and SLA definitions were fetched alongside the table probes
  const took_ms = Date.now() - t0, requests = snCalls - c0
  state.profile = { scanned_at: new Date().toISOString(), took_ms, requests, tables, standard_states, custom_states, sla_definitions: slaList, sla_matches }
  log('scan.done', { instance: cfg.sn.instanceUrl, requests, took_ms, tables_present: Object.values(tables).filter((t: any) => t.present).length, tables: Object.keys(tables).length })
  state.params = undefined; state.confirmed = undefined
  res.json(state.profile)
})

/** Build tenant parameters from the confirm step (or from the scan's defaults when skipped). */
function applyParams(slas: Record<string, string>, openExtra: string[], confirmed: boolean) {
  state.params = { ...slas, open_states: ['1', '2', '3', ...openExtra].join(',') }
  state.confirmed = confirmed
}
app.post('/api/skip-confirm', (_req, res) => {
  const p = state.profile
  const slas = Object.fromEntries(Object.entries(p.sla_matches).map(([k, m]: [string, any]) => [k, m.selected]))
  applyParams(slas, p.custom_states.map((s: any) => s.value), false) // conservative default: custom states count as open
  res.json({ ...state.params, confirmed: false })
})
// Definitions, validation and the tenant parameters live in src/definitions.ts, shared with the
// standalone chatbot server. The chatbot no longer matches questions to tiles by word: the model
// names a definition id from the catalogue and the server runs that tile's query (D-004).
const resolved = (filter: string) => defs.resolve(filter)
const validate = () => defs.rows() as any[]
app.get('/api/validate', (_req, res) => res.json(validate()))
// The last scan and the parameters built from it, so a page opened after the scan can show what was read.
app.get('/api/profile', (_req, res) => res.json({ profile: state.profile ?? null, params: state.params ?? null, confirmed: state.confirmed ?? null }))

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
      // Zero rows, or an average duration of zero (the field is never populated), both mean "no data yet".
      if (d.tier === 'B' && (r.value === 0 || String(r.value) === '00:00:00')) { d.status = 'no data yet'; d.reason = 'table and field exist; nothing recorded on this instance' }
    } catch (e) { d.status = 'error'; d.reason = (e as Error).message }
  })
  return rows
  })
  for (const d of rows) if (d.kind === 'ratio' && d.status === 'available') {
    const n = rows.find((x) => x.id === d.num), m = rows.find((x) => x.id === d.den)
    // A ratio over parts that have no data yet is itself "no data yet", not a dash.
    const part = [n, m].find((p) => p && p.status !== 'available')
    if (part) { d.status = part.status; d.reason = part.reason; continue }
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

/** Application map: two hops of CMDB relationships from a service, with the records linked to each CI.
 *  Nodes are CIs, edges are the ServiceNow relationship types. Counts come from one GROUP BY per table over
 *  the whole node set, so the map costs a handful of calls whatever its size. */
app.get('/api/graph', async (req, res) => {
  const id = String(req.query.service ?? ''), depth = Math.min(4, Math.max(1, Number(req.query.depth) || 3))
  if (!ID.test(id)) return res.status(400).json({ error: 'bad service id' })
  res.json(await cached(`graph:${id}:${depth}:${state.params?.open_states}`, async () => {
    const open = state.params?.open_states ?? '1,2,3'
    // The walk goes downward only: what the service contains, depends on and runs on. Things that merely share a
    // server with it (sibling services, other applications) are not drawn; they are listed per node as "also used by".
    const MAX = 40
    type Node = { id: string; name: string; cls: string; hop: number; counts: Record<string, number>; up?: boolean; shared: string[] }
    const nodes: Record<string, Node> = {}, edges: { from: string; to: string; type: string }[] = []
    const touch = (r: Row, side: 'parent' | 'child', hop: number) => {
      const nid = vv(r, side); if (!nid) return
      nodes[nid] ??= { id: nid, name: dv(r, side) || '(unnamed CI)', cls: dv(r, `${side}.sys_class_name`) || vv(r, `${side}.sys_class_name`) || 'CI', hop, counts: {}, shared: [] }
    }
    const addEdge = (r: Row) => { const key = `${vv(r, 'parent')}>${vv(r, 'child')}`; if (!edges.some((e) => `${e.from}>${e.to}` === key)) edges.push({ from: vv(r, 'parent'), to: vv(r, 'child'), type: (dv(r, 'type') || '').split('::')[0] || 'related to' }) }
    const walk = async (ids: string[], hop: number) => {
      if (!ids.length) return
      const rel = await rows('cmdb_rel_ci', `parentIN${ids.join(',')}^ORchildIN${ids.join(',')}`, 'parent,child,type,parent.sys_class_name,child.sys_class_name', 300)
      for (const r of rel) {
        const p = vv(r, 'parent'), c = vv(r, 'child'), fromP = ids.includes(p), fromC = ids.includes(c)
        if (fromP && !nodes[c] && Object.keys(nodes).length >= MAX) continue
        if (fromP) { touch(r, 'child', hop); addEdge(r) } // downstream: drawn
        else if (fromC && hop === 1) { touch(r, 'parent', hop); nodes[p]!.up = true; addEdge(r) } // what the service belongs to: drawn once, not expanded
        else if (fromC && nodes[c]) { const n = dv(r, 'parent'); if (n && !nodes[p] && !nodes[c]!.shared.includes(n)) nodes[c]!.shared.push(n) } // shared with something outside the map
        else if (fromP && nodes[p] && nodes[c]) addEdge(r)
      }
    }
    nodes[id] = { id, name: '', cls: 'Service', hop: 0, counts: {}, shared: [] }
    // Default depth three reaches the database under the servers under the web tier, where most stacks end.
    await walk([id], 1)
    for (let h = 2; h <= depth; h++) await walk(Object.values(nodes).filter((n) => n.hop === h - 1 && !n.up).map((n) => n.id), h)
    // The centre's name comes from the service record itself, not from an edge.
    const svc = (await rows('cmdb_ci_service', `sys_id=${id}`, 'name,busines_criticality', 1))[0]
    if (svc) nodes[id].name = dv(svc, 'name') || vv(svc, 'name')
    const ids = Object.keys(nodes)
    // Linked records per CI: one GROUP BY per table. Incidents on the centre also count business_service.
    const LINKS: Record<string, { table: string; q: string }> = {
      incidents: { table: 'incident', q: `cmdb_ciIN${ids.join(',')}^stateIN${open}` },
      changes: { table: 'change_request', q: `cmdb_ciIN${ids.join(',')}^active=true` },
      problems: { table: 'problem', q: `cmdb_ciIN${ids.join(',')}^active=true` },
      vulnerabilities: { table: 'sn_vul_vulnerable_item', q: `cmdb_ciIN${ids.join(',')}^active=true` },
    }
    type G = { result: { groupby_fields: { value: string }[]; stats: { count: string } }[] }
    await pool(Object.keys(LINKS), 4, async (k) => {
      const l = LINKS[k]!
      const g = await get<G>(`/api/now/stats/${l.table}?sysparm_count=true&sysparm_group_by=cmdb_ci&sysparm_query=${enc(l.q)}`)
      for (const x of g?.result ?? []) { const n = nodes[x.groupby_fields[0]!.value]; if (n) n.counts[k] = (n.counts[k] ?? 0) + Number(x.stats.count) }
    })
    const svcInc = await count('incident', `business_service=${id}^cmdb_ciNOT IN${ids.join(',')}^stateIN${open}`)
    if (svcInc) nodes[id].counts.incidents = (nodes[id].counts.incidents ?? 0) + svcInc
    const link = (k: string, ci: string) => `${cfg.sn.instanceUrl}/${LINKS[k]!.table}_list.do?sysparm_query=${enc(LINKS[k]!.q.replace(/cmdb_ciIN[^^]+/, `cmdb_ci=${ci}`))}`
    return { service: id, depth, open_states: open, nodes: Object.values(nodes).map((n) => ({ ...n, links: Object.fromEntries(Object.keys(LINKS).map((k) => [k, link(k, n.id)])) })), edges,
      recipe: { relationships: `cmdb_rel_ci · parentIN<nodes>^ORchildIN<nodes>, ${depth} step${depth === 1 ? '' : 's'} down from the service (contains, depends on, runs on)`, ...Object.fromEntries(Object.entries(LINKS).map(([k, l]) => [k, `${l.table} · ${l.q.replace(/cmdb_ciIN[^^]+/, 'cmdb_ci=<node>')}`])) } }
  }))
})

/** Read-only list for table-shaped tiles (the rights/cost table). Fields and table are shape-checked. */
app.get('/api/list', async (req, res) => {
  const table = String(req.query.table ?? ''), fields = String(req.query.fields ?? ''), order = String(req.query.order ?? ''), limit = Math.min(Number(req.query.limit ?? 10), 50)
  if (!/^[a-z0-9_]+$/.test(table) || !/^[a-z0-9_.,]+$/.test(fields) || !/^-?[a-z0-9_.]*$/.test(order)) return res.status(400).json({ error: 'bad table, fields or order' })
  // Optional filter, same placeholder handling as breakdown. Without it the call is unchanged.
  const q = resolved(String(req.query.q ?? ''))
  if (/\{\{/.test(q)) return res.status(409).json({ error: 'instance not scanned yet: run the onboarding scan, then reload' })
  const ord = order ? (order.startsWith('-') ? `&sysparm_orderby=${order.slice(1)}DESC` : `&sysparm_orderby=${order}`) : ''
  const query = [q, order.startsWith('-') ? `ORDERBYDESC${order.slice(1)}` : order ? `ORDERBY${order}` : ''].filter(Boolean).join('^')
  res.json(await cached(`list:${table}:${fields}:${order}:${limit}:${q}`, async () => {
    const r = await get<{ result: Rec[] }>(`/api/now/table/${table}?sysparm_fields=${fields}&sysparm_display_value=true&sysparm_limit=${limit}${ord}${query ? `&sysparm_query=${enc(query)}` : ''}`)
    return { table, fields: fields.split(','), rows: r?.result ?? [] }
  }))
})

/** Figures beyond the core catalogue that the dashboard's live loader applies by tile id.
    Tiles come back in the same shape as /api/dashboard rows so the page renders them with stat(). */
app.get('/api/next', async (_req, res) => {
  const open = state.params?.open_states ?? '1,2,3'
  res.json(await cached(`next:${open}`, async () => {
    const url = (t: string, q: string) => `${cfg.sn.instanceUrl}/${t}_list.do?sysparm_query=${enc(q)}`
    const tile = (id: string, name: string, table: string, filter: string, meaning: string, value: unknown, extra: Record<string, unknown> = {}) =>
      ({ id, name, kind: 'metric', status: value === null || value === undefined ? 'not available' : 'available', reason: value == null ? 'ServiceNow did not answer' : undefined, table, aggregate: 'count', filter_resolved: filter, meaning, value, url: url(table, filter), ...extra })
    const months: any[] = [], jobs: (() => Promise<void>)[] = []
    for (let i = 5; i >= 0; i--) { const m: any = { label: monthLabel(i), q: monthQ('opened_at', i) }; months.push(m); jobs.push(async () => { m.requests = await count('sc_req_item', m.q) }) }
    const uq = `stateIN${open}^assigned_toISEMPTY`, mq = 'stateIN6,7^priorityIN1,2', aq = 'stateIN6,7^resolved_by.name=AURA Agent', rq = 'stateIN6,7^resolved_byISNOTEMPTY'
    const sq = 'workflow_state=published^sys_updated_on<javascript:gs.daysAgoStart(180)', kq = 'workflow_state=published'
    let unassigned: number | null = null, majorN: number | null = null, majorRaw: string | null = null, autoN: number | null = null, resolvedN: number | null = null, staleN: number | null = null, kbN: number | null = null
    jobs.push(async () => { unassigned = await count('incident', uq) },
      async () => { majorN = await count('incident', mq); const r = await stats.run({ table: 'incident', filter: mq, aggregate: 'avg', field: 'calendar_duration' }).catch(() => null); majorRaw = r?.value == null ? null : String(r.value) },
      async () => { autoN = await count('incident', aq) }, async () => { resolvedN = await count('incident', rq) },
      async () => { staleN = await count('kb_knowledge', sq) }, async () => { kbN = await count('kb_knowledge', kq) })
    await pool(jobs, 6, (j) => j())
    const share = autoN === null || !resolvedN ? null : `${(100 * autoN / resolvedN).toFixed(1)}%`
    return { months, tiles: {
      unassigned: tile('unassigned', 'Unassigned incidents', 'incident', uq, 'Open incidents with nobody assigned', unassigned),
      major_mttr: tile('major_mttr', 'MTTR, P1 and P2', 'incident', mq, 'Average calendar duration of resolved P1 and P2 incidents', majorRaw, { aggregate: 'avg', field: 'calendar_duration', detail: `${(majorN ?? 0).toLocaleString('en-US')} incidents` }),
      automation_share: tile('automation_share', 'Resolved by automation', 'incident', aq, 'Resolved incidents whose resolver is the AURA automation account, over all resolved incidents with a named resolver', share, { kind: 'ratio', detail: `${(autoN ?? 0).toLocaleString('en-US')} ÷ ${(resolvedN ?? 0).toLocaleString('en-US')}`, filter_resolved: `${aq}  ÷  ${rq}` }),
      kb_stale: tile('kb_stale', 'Stale articles', 'kb_knowledge', sq, 'Published articles not updated in 180 days', staleN, { detail: `of ${(kbN ?? 0).toLocaleString('en-US')} published` }),
    } }
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
// Request items: the same shape as incidents as far as the queue is concerned. Requested-for stands in
// for the caller, the catalog item for the category. Both tables extend task, so journal, SLA and
// assignment reads are identical; only the state values and the close writes differ.
const RITM_FIELDS = 'sys_id,number,short_description,description,priority,state,stage,approval,cat_item,requested_for,request,assignment_group,assigned_to,opened_at,due_date,sys_updated_on,sys_updated_by,close_notes'
type Kind = 'incident' | 'sc_req_item'
const KIND_OF: [RegExp, Kind][] = [[/^INC\d+$/i, 'incident'], [/^RITM\d+$/i, 'sc_req_item']]
const kindOf = (n: string): Kind | null => KIND_OF.find(([re]) => re.test(n))?.[1] ?? null
const KIND_WORD: Record<Kind, string> = { incident: 'incident', sc_req_item: 'request item' }
/** Present a request item row with incident field names so one scoring path serves both kinds. */
function asIncidentShape(r: Row, kind: Kind): Row {
  if (kind === 'incident') return r
  const out: Row = { ...r }
  const pick = (f: string) => r[f] ?? { value: '', display_value: '' }
  out.caller_id = pick('requested_for')
  out.category = pick('cat_item')
  out.reopen_count = { value: '0', display_value: '0' }
  out.cmdb_ci = { value: '', display_value: '' }
  return out
}

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
  { id: 'approval', name: 'Approval waiting on you', meaning: 'A request item has an approval in Requested state with you as the approver', q: 'sysapproval_approver: approver=<you>^state=requested^source_table=sc_req_item' },
  { id: 'past_due', name: 'Past its due date', meaning: 'A request item whose due date has passed and is still active', q: 'active=true^due_date<javascript:gs.nowDateTime()' },
]

app.get('/api/resolve/rules', (_req, res) => res.json({ rules: RULES, writes: WRITES, llm: cfg.llmMode }))

/** People with open tickets, so a reviewer can look at the queue as one of them. */
app.get('/api/resolve/people', async (_req, res) => {
  res.json(await cached(`people:${openStates()}`, async () => {
    // display_value=all returns both the sys_id and the name per group; =true returns only the name.
    // Incident assignees and request approvers, one list; `open` is the total they hold.
    type G = { result: { groupby_fields: Dv[]; stats: { count: string } }[] }
    const [inc, apr] = await Promise.all([
      get<G>(`/api/now/stats/incident?sysparm_count=true&sysparm_display_value=all&sysparm_group_by=assigned_to&sysparm_query=${enc(`stateIN${openStates()}^assigned_toISNOTEMPTY`)}`),
      get<G>(`/api/now/stats/sysapproval_approver?sysparm_count=true&sysparm_display_value=all&sysparm_group_by=approver&sysparm_query=${enc('state=requested^source_table=sc_req_item')}`),
    ])
    const people: Record<string, { id: string; name: string; open: number; incidents: number; approvals: number }> = {}
    const addAll = (g: G | null, k: 'incidents' | 'approvals') => { for (const x of g?.result ?? []) { const id = x.groupby_fields[0]!.value, name = x.groupby_fields[0]!.display_value; if (!ID.test(id) || !name || /agent|system|integration/i.test(name)) continue; people[id] ??= { id, name, open: 0, incidents: 0, approvals: 0 }; people[id]![k] += Number(x.stats.count); people[id]!.open += Number(x.stats.count) } }
    addAll(inc, 'incidents'); addAll(apr, 'approvals')
    return Object.values(people).sort((a, b) => b.open - a.open).slice(0, 15)
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
    // Incidents the person owns or that sit unassigned in their groups, plus request items waiting on their approval.
    const [me, mine, approvals] = await Promise.all([userOf(as),
      rows('incident', `stateIN${open}^assigned_to=${as}`, INC_FIELDS, 100, 'ORDERBYpriority^ORDERBYopened_at'),
      rows('sysapproval_approver', `approver=${as}^state=requested^source_table=sc_req_item`, 'sys_id,sysapproval,sys_created_on', 50)])
    const gids = me.groups.map((g) => g.id).join(',')
    const [gq, ritms] = await Promise.all([
      gids ? rows('incident', `stateIN${open}^assignment_groupIN${gids}^assigned_toISEMPTY`, INC_FIELDS, 200, 'ORDERBYpriority^ORDERBYopened_at') : [],
      approvals.length ? rows('sc_req_item', `sys_idIN${approvals.map((a) => vv(a, 'sysapproval')).join(',')}`, RITM_FIELDS, 50) : []])
    const approvalOf: Record<string, string> = {}; for (const a of approvals) approvalOf[vv(a, 'sysapproval')] = vv(a, 'sys_id')
    const kindOfRow = new Map<Row, Kind>()
    const forApproval = ritms.map((r) => { const s = asIncidentShape(r, 'sc_req_item'); kindOfRow.set(s, 'sc_req_item'); return s })
    // The dashboard counts unconfirmed custom states as open (D-005, the safe default for a
    // count). A work queue must not hand someone a ticket whose state label says it is finished.
    const all = [...mine, ...gq, ...forApproval].filter((r) => !/cancel|closed|resolved/i.test(dv(r, 'state')))
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
      const id = vv(r, 'sys_id'), pri = Number(vv(r, 'priority')), j = journal[id] ?? {}, s = sla[id], days = daysSince(vv(r, 'opened_at')), kind = kindOfRow.get(r) ?? 'incident'
      const reasons: { rule: string; text: string }[] = []; let score = 0
      if (kind === 'sc_req_item' && approvalOf[id]) { score += 30; reasons.push({ rule: 'approval', text: 'approval waiting on you' }) }
      const due = vv(r, 'due_date'); if (kind !== 'incident' && due && daysSince(due) > 0) { score += 25; reasons.push({ rule: 'past_due', text: `due ${due.slice(0, 10)}, ${Math.round(daysSince(due))} d ago` }) }
      if (pri && pri <= 2) { score += pri === 1 ? 40 : 30; reasons.push({ rule: 'priority', text: `P${pri}` }) }
      if (s?.breached) { score += 50; reasons.push({ rule: 'sla', text: 'SLA breached' }) } else if (s && s.pct > 80) { score += 35; reasons.push({ rule: 'sla', text: `SLA at ${Math.round(s.pct)}%, breaches ${s.breach_time}` }) }
      const replyOwed = !!(j.lastComment && (!j.lastNote || j.lastComment > j.lastNote))
      if (replyOwed) { score += 30; reasons.push({ rule: 'reply_owed', text: `caller wrote on ${j.lastComment!.slice(0, 10)}, no work note since` }) }
      if (kind === 'incident' && j.lastNoteText && FIXED.test(j.lastNoteText)) { score += 25; reasons.push({ rule: 'fixed_open', text: `last work note (${j.lastNote!.slice(0, 10)}) says it works, ticket still open` }) }
      const same = titleCount[norm(vv(r, 'short_description'))] ?? 0
      if (kind === 'incident' && same >= 3) { score += 15; reasons.push({ rule: 'recurring', text: `same title on ${same} open tickets in your scope` }) }
      if (kind !== 'sc_req_item' && !vv(r, 'assigned_to')) { score += 10; reasons.push({ rule: 'unassigned', text: 'unassigned in your group queue' }) }
      const ageScore = Math.min(15, Math.floor(days / 7)); if (ageScore) { score += ageScore; reasons.push({ rule: 'age', text: `${Math.round(days)} days open` }) }
      // Flags the browse filters use. SLA "soon" = breached, or breaching within two hours.
      const soon = !!s && (s.breached || (!!s.breach_raw && new Date(s.breach_raw.replace(' ', 'T') + 'Z').getTime() - Date.now() < 2 * 3_600_000))
      return { sys_id: id, number: vv(r, 'number'), kind, kind_word: KIND_WORD[kind], title: vv(r, 'short_description') || dv(r, 'category') || vv(r, 'number'), priority: dv(r, 'priority'), state: dv(r, 'state'), caller: dv(r, 'caller_id'), group: dv(r, 'assignment_group'), assigned_to: dv(r, 'assigned_to') || null, opened_at: vv(r, 'opened_at'), updated_at: vv(r, 'sys_updated_on'), updated_by: vv(r, 'sys_updated_by'), due_date: due || null, approval_id: approvalOf[id] ?? null, days: Math.round(days), score, reasons, kb: null as null | { number: string; title: string; url: string }, also: [] as string[],
        flags: { mine: vv(r, 'assigned_to') === as, group: kind !== 'sc_req_item' && !vv(r, 'assigned_to'), approvals: !!approvalOf[id], sla: soon, waiting: replyOwed, reopened: Number(vv(r, 'reopen_count')) > 0, changed: daysSince(vv(r, 'sys_updated_on')) < 4 / 24 } }
    }).sort((a, b) => b.score - a.score)
    // One row per distinct title: eight identical "account is inactive" tickets are one job, not eight.
    const top: typeof scored = [], seen: Record<string, (typeof scored)[number]> = {}
    for (const t of scored) { const k = t.kind + ':' + norm(t.title); if (seen[k]) { seen[k]!.also.push(t.number); continue } seen[k] = t; if (top.length < 10) top.push(t) }
    // Knowledge match for the top ten incidents only: one text search each.
    await pool(top.filter((t) => t.kind === 'incident'), 10, async (t) => {
      const hits = await search.search(t.title).catch(() => [])
      const h = hits.find((a) => overlap(t.title, a.title) >= 2)
      if (h) { t.kb = { number: h.label ?? '', title: h.title, url: h.url }; t.score += 10; t.reasons.push({ rule: 'knowledge', text: `${h.label} "${first(h.title, 60)}" may answer it` }) }
    })
    top.sort((a, b) => b.score - a.score)
    // Browse lists: the same candidates, filtered, newest change first. Reasons are omitted; the list is the point.
    const lite = (t: (typeof scored)[number]) => { const { reasons, kb, also, flags, score, ...rest } = t; return rest }
    const browse: Record<string, ReturnType<typeof lite>[]> = {}
    for (const k of ['mine', 'group', 'approvals', 'sla', 'waiting', 'reopened', 'changed'] as const) browse[k] = scored.filter((t) => t.flags[k]).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(lite)
    return { me, counts: { mine: mine.length, group_unassigned: gq.length, approvals: forApproval.length, group_capped: gq.length >= 200, distinct: Object.keys(seen).length, finished_label: mine.length + gq.length + forApproval.length - all.length }, queue: top.map((t) => { const { flags, ...rest } = t; return rest }), browse }
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
    const kind = kindOf(number); if (!kind) return null
    const table = kind, FIELDS = kind === 'incident' ? INC_FIELDS : RITM_FIELDS
    const raw0 = (await rows(table, `number=${number}`, FIELDS, 1))[0]
    if (!raw0) return null
    const r = asIncidentShape(raw0, kind)
    const id = vv(r, 'sys_id'), title = vv(r, 'short_description') || dv(r, 'category') || number
    const fields: Record<string, string> = {}
    for (const f of new Set([...INC_FIELDS.split(','), ...FIELDS.split(',')])) fields[f] = dv(r, f)
    fields.caller_id = dv(r, 'caller_id'); fields.category = dv(r, 'category')
    const raw: Record<string, string> = {}; for (const f of ['state', 'priority', 'assigned_to', 'assignment_group', 'caller_id', 'sys_updated_by', 'reopen_count', 'approval', 'request_item', 'cat_item']) raw[f] = vv(r, f)
    // Look-alikes: for an incident, resolved tickets with a usable close note that read the same;
    // for a request item, completed ones for the same catalog item, which is what a fulfiller reuses.
    const catField = 'cat_item', catId = kind === 'incident' ? '' : vv(raw0, catField)
    const textQ = `123TEXTQUERY321=${title.replace(/[\^=&]/g, ' ').slice(0, 150)}`
    const simQ = kind === 'incident' ? `stateIN6,7^close_notesISNOTEMPTY^sys_id!=${id}^${textQ}` : catId ? `${catField}=${catId}^state=3^close_notesISNOTEMPTY^sys_id!=${id}` : `state=3^close_notesISNOTEMPTY^sys_id!=${id}^${textQ}`
    const simFields = kind === 'incident' ? 'sys_id,number,short_description,close_notes,close_code,resolved_by,assignment_group,resolved_at,opened_at,category,caller_id' : `sys_id,number,short_description,close_notes,closed_by,assignment_group,closed_at,opened_at,${catField},requested_for`
    const sameQ = `active=true^short_description=${title}^sys_id!=${id}`
    const ritmId = kind === 'sc_req_item' ? id : ''
    // Everything below depends only on the record just read, so the reads go out together.
    const [jRaw, slaRaw, simRaw, sameRaw, kbRaw, varRaw, aprRaw] = await Promise.all([
      rows('sys_journal_field', `element_id=${id}^elementINcomments,work_notes`, 'element,value,sys_created_on,sys_created_by', 40, 'ORDERBYsys_created_on'),
      rows('task_sla', `task=${id}^active=true`, 'sla,has_breached,business_percentage,breach_time,stage', 10),
      rows(table, simQ, simFields, 8),
      rows(table, sameQ, 'sys_id,number,caller_id,assignment_group,assigned_to,opened_at,state', 10),
      search.search(title).catch(() => []),
      ritmId ? rows('sc_item_option_mtom', `request_item=${ritmId}`, 'sc_item_option.item_option_new.question_text,sc_item_option.value', 25) : [],
      ritmId ? rows('sysapproval_approver', `sysapproval=${ritmId}`, 'sys_id,approver,state,comments,sys_created_on', 20) : [],
    ])
    // Notes NowOps wrote itself (earlier suggestions, record fixes) are flagged: they are not findings.
    const journal = jRaw.map((j) => ({ kind: vv(j, 'element'), text: vv(j, 'value'), at: vv(j, 'sys_created_on'), by: vv(j, 'sys_created_by'), nowops: isNowOpsNote(vv(j, 'value')) }))
    const slas = slaRaw.map((s) => ({ name: dv(s, 'sla'), breached: vv(s, 'has_breached') === 'true', pct: Number(vv(s, 'business_percentage')) || 0, breach_time: dv(s, 'breach_time'), stage: dv(s, 'stage') }))
    const byF = kind === 'incident' ? 'resolved_by' : 'closed_by', atF = kind === 'incident' ? 'resolved_at' : 'closed_at'
    // Each look-alike carries what its notes really record (resolved, escalated, hollow) and whose
    // ticket it was. Hollow ones teach nothing and are dropped; escalated ones stay, marked, so the
    // step generator proposes an escalation rather than a fix nobody has shown works.
    const similar = simRaw
      .map((s) => ({ number: vv(s, 'number'), title: vv(s, 'short_description'), close_notes: vv(s, 'close_notes'), close_code: dv(s, 'close_code'), resolved_by: dv(s, byF), resolved_by_id: vv(s, byF), group: dv(s, 'assignment_group'), group_id: vv(s, 'assignment_group'), category: vv(s, kind === 'incident' ? 'category' : catField), category_label: dv(s, kind === 'incident' ? 'category' : catField), resolved_at: vv(s, atF), opened_at: vv(s, 'opened_at'), caller: dv(s, kind === 'incident' ? 'caller_id' : 'requested_for'), outcome: classifyOutcome(vv(s, 'close_notes')) as Outcome, url: `${cfg.sn.instanceUrl}/${table}.do?sys_id=${vv(s, 'sys_id')}` }))
      .filter((s) => s.outcome !== 'hollow').slice(0, 4)
    const sameTitle = sameRaw.map((s) => ({ number: vv(s, 'number'), caller: dv(s, 'caller_id'), group: dv(s, 'assignment_group'), assigned_to: dv(s, 'assigned_to'), opened_at: vv(s, 'opened_at'), state: dv(s, 'state') }))
    // An article about another system is never a match, however many words it shares: a Workday SOP
    // for a ServiceNow account, a Yardi guide for Edge. It is kept in the list, flagged, so the page
    // can show why it was set aside, but the step generator never sees it.
    const kb = kbRaw.slice(0, 3).map((a) => { const same = sameSystem(title, a.title); return { number: a.label ?? '', title: a.title, url: a.url, excerpt: a.body.slice(0, 220), match: same && overlap(title, a.title) >= 2, otherSystem: !same } })
    // The request behind the item: what was asked for and its approvals.
    const request = ritmId ? {
      ritm: number, ritm_id: ritmId, request: dv(raw0, 'request'),
      cat_item: dv(r, 'category'), requested_for: dv(r, 'caller_id'), stage: dv(raw0, 'stage'), approval: dv(raw0, 'approval'), due_date: vv(raw0, 'due_date'),
      // Variables whose value is a reference show as an id; the requested-for one is already a field, so drop those.
      variables: varRaw.map((v) => ({ q: vv(v, 'sc_item_option.item_option_new.question_text'), v: vv(v, 'sc_item_option.value') })).filter((x) => x.q && x.v && !ID.test(x.v)),
      approvals: aprRaw.map((a) => ({ id: vv(a, 'sys_id'), approver: dv(a, 'approver'), approver_id: vv(a, 'approver'), state: dv(a, 'state'), state_raw: vv(a, 'state'), comments: vv(a, 'comments'), at: vv(a, 'sys_created_on') })),
    } : null
    // Who to bring in: people and groups who actually closed the similar tickets.
    const tally: Record<string, { name: string; kind: 'person' | 'group'; n: number; tickets: string[] }> = {}
    for (const s of similar) for (const [name, k] of [[s.resolved_by, 'person'], [s.group, 'group']] as const) if (name) { tally[k + name] ??= { name, kind: k, n: 0, tickets: [] }; tally[k + name]!.n++; tally[k + name]!.tickets.push(s.number) }
    const who = Object.values(tally).sort((a, b) => b.n - a.n)
    // Readiness: what is missing from the record itself. The model can add "what this fault type needs" on top.
    const missing: string[] = []
    const person = kind === 'incident' ? 'caller' : 'requester'
    if (!vv(r, 'caller_id')) missing.push(kind === 'incident' ? 'Who reported it: the caller field is empty' : 'Who it is for: requested for is empty')
    if (kind === 'incident') {
      if (!vv(r, 'description') || vv(r, 'description').trim().length < 20) missing.push('What happened: the description is empty or one line')
      if (!vv(r, 'cmdb_ci')) missing.push('Which device or service: no configuration item')
    } else if (!(request?.variables.length) && (!vv(r, 'description') || vv(r, 'description').trim().length < 20)) missing.push('What was asked for: no variables and no description')
    if (!journal.some((j) => j.kind === 'comments')) missing.push(`Nothing from the ${person} yet: no comments on the ticket`)
    const lastNote = [...journal].reverse().find((j) => j.kind === 'work_notes')
    if (kind === 'incident' && lastNote && FIXED.test(lastNote.text)) missing.push('Caller confirmation: the last work note says it works, the caller has not said so')
    const readiness = Math.max(1, 10 - missing.length * 2)
    // Ticket check: one line per thing a workable record has. A gap carries a proposed value with its
    // evidence where the instance can supply one, otherwise the fix is to ask the caller.
    const checks = kind === 'incident' ? await ticketChecks(r, journal, similar, who) : requestChecks(r, kind, request!, who, similar)
    return { number, kind, kind_word: KIND_WORD[kind], table, sys_id: id, title, fields, raw, journal, slas, similar, sameTitle, kb, request, who, missing, readiness, checks, url: `${cfg.sn.instanceUrl}/${table}.do?sys_id=${id}`,
      queries: { similar: simQ, sameTitle: sameQ, kb: `kb_knowledge: workflow_state=published^123TEXTQUERY321=${title}` } }
  })
}
/** Ticket check for a request item: what a fulfiller needs before they can act. */
function requestChecks(r: Row, _kind: Kind, req: { variables: { q: string; v: string }[]; approvals: { state_raw: string }[]; approval: string; due_date: string }, _who: { name: string; kind: string; n: number }[], _similar: unknown[]): Check[] {
  const rf = dv(r, 'caller_id'), first = rf.split(' ')[0] || 'the requester', out: Check[] = []
  out.push({ key: 'caller', label: 'Requested for', ok: !!vv(r, 'caller_id'), current: rf, ask: vv(r, 'caller_id') ? undefined : 'Find out who the request is for' })
  const detail = req.variables.length ? `${req.variables.length} variable${req.variables.length === 1 ? '' : 's'} filled in` : vv(r, 'description').trim().length >= 20 ? first_(vv(r, 'description'), 60) : ''
  out.push({ key: 'description', label: 'What was asked for', ok: !!detail, current: detail || 'no variables, no description', ask: detail ? undefined : `Ask ${first} exactly what they need` })
  const pending = req.approvals.filter((a) => a.state_raw === 'requested').length
  out.push({ key: 'approval', label: 'Approval', ok: !pending, current: pending ? `${pending} approver${pending === 1 ? '' : 's'} still to decide` : req.approval || 'not required', ask: pending ? 'Decide, or chase the approver' : undefined })
  if (req.due_date) out.push({ key: 'due', label: 'Due date', ok: daysSince(req.due_date) <= 0, current: daysSince(req.due_date) > 0 ? `${req.due_date.slice(0, 10)}, ${Math.round(daysSince(req.due_date))} d ago` : req.due_date.slice(0, 10), ask: daysSince(req.due_date) > 0 ? `Tell ${first} when to expect it` : undefined })
  return out
}
app.get('/api/resolve/ticket/:number', async (req, res) => {
  const n = String(req.params.number).toUpperCase()
  if (!kindOf(n)) return res.status(400).json({ error: 'incident or request item number expected' })
  const d = await ticketDetail(n)
  if (!d) return res.status(404).json({ error: `${n} not found` })
  res.json(d)
})

// ---- Drafts. Rules first (always available), the model on top when reachable.
type Detail = NonNullable<Awaited<ReturnType<typeof ticketDetail>>>
const section = (notes: string, name: string) => { const m = new RegExp(`${name}[^:\\n]*:\\s*([\\s\\S]*?)(?:\\n\\s*\\n|\\n[A-Z][A-Za-z ]+:|$)`, 'i').exec(notes); return m?.[1]?.trim() ?? '' }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const first = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s)

/** Steps for a request item: the fulfiller acts; NowOps says what to check and what to write. */
function requestSteps(d: Detail) {
  const steps: { text: string; source: string }[] = [], req = d.request!, who = d.fields.caller_id || 'the requester'
  const pending = req.approvals.filter((a) => a.state_raw === 'requested')
  if (d.kind === 'sc_req_item' && pending.length) steps.push({ text: `Read the justification in the request variables and approve or reject. ${pending.length === 1 ? pending[0]!.approver : pending.length + ' approvers'} still to decide.`, source: `${pending.length} approval record${pending.length === 1 ? '' : 's'} in Requested state` })
  if (d.checks.some((c) => c.key === 'description' && !c.ok)) steps.push({ text: `Ask ${who} exactly what they need: the request carries no variables and no description.`, source: 'empty variables and description on the record' })
  const seenFix = new Map<string, { text: string; source: string }>()
  for (const s of d.similar) {
    const res = first((section(s.close_notes, 'Resolution') || section(s.close_notes, 'Actions Taken') || s.close_notes).replace(/\s+/g, ' '), 200)
    const k = norm(res); const cite = `${s.number}, closed ${s.resolved_at.slice(0, 10)}${s.resolved_by ? ' by ' + s.resolved_by : ''}`
    if (seenFix.has(k)) { seenFix.get(k)!.source += `; also ${s.number}`; continue }
    if (seenFix.size >= 2) continue
    const st = { text: `Do what completed ${s.number} for the same catalog item: ${res}`, source: cite }; seenFix.set(k, st); steps.push(st)
  }
  for (const k of d.kb.filter((k) => k.match).slice(0, 1)) steps.push({ text: `Follow ${k.number} "${k.title}".`, source: `${k.number}, published knowledge` })
  if (req.due_date && daysSince(req.due_date) > 0) steps.push({ text: `Tell ${who} when to expect it; the due date passed ${Math.round(daysSince(req.due_date))} days ago.`, source: `due ${req.due_date.slice(0, 10)}` })
  steps.push({ text: `Confirm with ${who} that they have what they asked for, then close complete with the note drafted below.`, source: 'standard fulfilment step' })
  return steps
}
function stepsByRules(d: Detail) {
  if (d.kind !== 'incident') return requestSteps(d)
  const steps: { text: string; source: string }[] = []
  const caller = d.fields.caller_id || 'the caller'
  const lastNote = [...d.journal].reverse().find((j) => j.kind === 'work_notes')
  if (lastNote && FIXED.test(lastNote.text)) steps.push({ text: `Ask ${caller} whether it has stayed fixed since ${lastNote.at.slice(0, 10)}. The last work note says it works but nobody confirmed with the caller.`, source: `work note of ${lastNote.at.slice(0, 10)}` })
  if (d.missing.some((m) => m.startsWith('Who reported') || m.startsWith('What happened'))) steps.push({ text: `Ask ${caller} what exactly happens, since when, and which device: the ticket does not say.`, source: 'empty caller or description on the record' })
  const matched = d.kb.filter((k) => k.match && !k.otherSystem)
  // One step per distinct fix: two look-alikes closed with the same note are one step, citing both.
  // A look-alike that was only escalated is proposed as an escalation, never as a fix.
  const seenFix = new Map<string, { text: string; source: string }>()
  for (const s of d.similar) {
    const other = s.caller && s.caller !== d.fields.caller_id ? ', a different caller' : ''
    if (s.outcome === 'escalated') {
      if (![...seenFix.values()].some((v) => v.text.startsWith('Escalate'))) steps.push({ text: `Escalate to ${s.group || 'the resolving team'} as ${s.number} was: that ticket records an escalation, not a fix.`, source: `${s.number}${other}, escalated ${s.resolved_at.slice(0, 10)}` })
      seenFix.set(`esc:${s.number}`, { text: 'Escalate', source: '' })
      continue
    }
    const res = first((section(s.close_notes, 'Resolution') || section(s.close_notes, 'Actions Taken') || s.close_notes).replace(/\s+/g, ' '), 200)
    const k = norm(res); const cite = `${s.number}${other}, closed ${s.resolved_at.slice(0, 10)}${s.resolved_by ? ' by ' + s.resolved_by : ''}`
    if (seenFix.has(k)) { seenFix.get(k)!.source += `; also ${s.number}`; continue }
    if ([...seenFix.keys()].filter((x) => !x.startsWith('esc:')).length >= 2) continue
    const st = { text: `Try what closed ${s.number}: ${res}`, source: cite }; seenFix.set(k, st); steps.push(st)
  }
  for (const k of matched.slice(0, 1)) steps.push({ text: `Follow ${k.number} "${k.title}".`, source: `${k.number}, published knowledge` })
  if (noEvidence(d.similar, matched.length)) steps.push({ text: `No published article or resolved look-alike covers "${first(d.title, 80)}". Escalate to the team for ${d.fields.category || 'this category'} with the symptom and what the caller has tried.`, source: 'no evidence on this instance' })
  if (d.sameTitle.length >= 2) steps.push({ text: `Raise one problem record and link the ${d.sameTitle.length + 1} open tickets with this exact title, so one fix closes them all.`, source: `${d.sameTitle.length} other open incidents with the same short description` })
  if (!d.fields.cmdb_ci) steps.push({ text: 'Record the affected device or service as the configuration item.', source: 'configuration item is empty' })
  steps.push({ text: `When ${caller} confirms, resolve with the close note drafted below.`, source: 'standard verification step' })
  return steps
}
const STEPS_SYSTEM = `You write next steps for an IT service desk agent. Use ONLY the facts supplied. Return JSON only: {"steps":[{"text":"one concrete action, one sentence","source":"which supplied item it came from, e.g. INC0012158 close note, KB0010463, work note of 2026-08-24, or 'inferred'"}]}. Never invent ticket or article numbers.

Rules, each learned from a wrong answer on this instance:
- An article marked [MATCHES THE TICKET] is the fix. Its resolution steps go in, citing it. Articles listed as "set aside, about another system" do not exist for you.
- Look-alikes are other people's tickets. Never write that this caller was fixed before, never carry a look-alike's dates or caller onto this ticket. Cite them as "INC… (different caller)".
- A look-alike marked ESCALATED shows no fix. Propose the same escalation, to the same team, and say the precedent was escalated. Do not write "reactivate as done previously" or any step that claims a prior fix.
- Journal lines marked [EARLIER NOWOPS SUGGESTION] are suggestions this tool made before. They are not findings; do not cite them as evidence that something happened.
- When the Evidence line says NONE: write three to five steps only. One says plainly that no published article or resolved look-alike covers this ticket; one proposes escalation to the team the category implies, with the ticket's symptom summarised; the rest are what the record still needs. Do not pad with generic verify, test, confirm and document lines.
- Otherwise five to seven steps, in the order verify, act, test, confirm with caller, document, resolve. Record gaps from "Ticket check" are one step each, cited to it.`
const DRAFT_SYSTEM = `You draft text for an IT service desk agent from supplied ticket records. Use ONLY the supplied facts. Wrap text copied or closely paraphrased from the supplied work notes in <mark class="rec">…</mark>, and anything inferred from similar tickets or not yet confirmed in <mark class="inf">…</mark>. Return exactly the format requested, no preamble.`
function facts(d: Detail) {
  const req = d.request ? [`Request: ${d.request.ritm} under ${d.request.request}; catalog item ${d.request.cat_item || 'none'}; requested for ${d.request.requested_for || 'not recorded'}; stage ${d.request.stage || 'n/a'}; approval ${d.request.approval || 'n/a'}; due ${d.request.due_date || 'none'}`,
    `Variables:\n${d.request.variables.map((v) => `${v.q}: ${first(v.v, 200)}`).join('\n') || '(none)'}`,
    `Approvals:\n${d.request.approvals.map((a) => `${a.approver}: ${a.state}${a.comments ? ' · ' + first(a.comments, 120) : ''}`).join('\n') || '(none)'}`] : []
  return [`${d.kind_word.toUpperCase()} ${d.number}: ${d.title}`, `Fields: priority ${d.fields.priority}; state ${d.fields.state}; group ${d.fields.assignment_group}; assigned to ${d.fields.assigned_to || 'nobody'}; ${d.kind === 'incident' ? 'caller' : 'requested for'} ${d.fields.caller_id || 'not recorded'}; ${d.kind === 'incident' ? 'category' : 'catalog item'} ${d.fields.category}; CI ${d.fields.cmdb_ci || 'none'}; opened ${d.fields.opened_at}`, ...req,
    `Description: ${d.fields.description || '(empty)'}`, `Journal:\n${d.journal.map((j) => `[${j.at}] ${j.kind} by ${j.by}${j.nowops ? ' [EARLIER NOWOPS SUGGESTION, not a finding]' : ''}: ${first(j.text.replace(/\s+/g, ' '), 300)}`).join('\n') || '(none)'}`,
    `Look-alike tickets (other tickets, usually other callers; never say this caller was fixed before):\n${d.similar.map((s) => describePrecedent(s, d.fields.caller_id)).filter(Boolean).join('\n') || '(none)'}`,
    `Knowledge articles about the same system:\n${d.kb.filter((k) => !k.otherSystem).map((k) => `${k.number}${k.match ? ' [MATCHES THE TICKET]' : ''} "${k.title}": ${k.excerpt}`).join('\n') || '(none)'}${d.kb.some((k) => k.otherSystem) ? `\nSet aside, about another system: ${d.kb.filter((k) => k.otherSystem).map((k) => k.number).join(', ')}` : ''}`,
    `Evidence: ${noEvidence(d.similar, d.kb.filter((k) => k.match && !k.otherSystem).length) ? 'NONE. No same-system article and no resolved look-alike. Say so in one step and propose escalation; do not pad.' : 'present, see above.'}`,
    `Open tickets with the same title: ${d.sameTitle.map((s) => s.number).join(', ') || 'none'}`, `Ticket check, open lines: ${d.checks.filter((c) => !c.ok).map((c) => `${c.label} is ${c.current}${c.fix ? ` (proposed: ${c.fix.value})` : ''}`).join('; ') || 'none, the record is complete'}`].join('\n\n')
}
// Writes and model calls go to the server log. ServiceNow holds the record of what changed;
// the work note on each write names the NowOps user, so no second trail is kept here.
const logAudit = (who: string, what: string, record: string, evidence: string) => console.log(`[resolve] ${who} · ${what} · ${record} · ${evidence}`)
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
const BRIEF_SYSTEM = `You brief an IT service desk agent who is about to work a ticket. Use ONLY the supplied facts. Write at most two plain sentences: what is wrong, what has been done so far, and what is blocking or what happens next. Every claim must be traceable to a supplied field, journal entry or SLA. Attribute a journal entry to its recorded author or to "the agent", never to the assignee or anyone else by guess. Look-alike tickets are other people's tickets: never present their outcome as something that happened on this one. Do not restate the ticket number, state or priority. Do not say more review is needed. If the facts do not support a sentence, leave it out. Plain text.`
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
  // Work notes worth quoting: not automation chatter, and not the notes NowOps itself writes on actions.
  const notes = d.journal.filter((j) => j.kind === 'work_notes' && !j.nowops && !/^\[?AURA|SOP is not identified/i.test(j.text.trim()))
  const caller = d.fields.caller_id || 'the caller'
  const sim = d.similar[0]
  let html = '', title = ''
  // A problem record and a knowledge article come from incidents only; approving a request item teaches nothing worth an article.
  if ((kind === 'kb' || kind === 'problem') && d.kind !== 'incident') return res.status(400).json({ error: `${kind === 'kb' ? 'a knowledge article' : 'a problem record'} is drafted from incidents, not from a ${d.kind_word}` })
  if (kind === 'close' && d.kind !== 'incident') {
    // Fulfilment close note: what was asked, what was done, who confirmed. Outcome is complete or incomplete.
    const req_ = `Write the close note for this ${d.kind_word} with exactly these headings on their own lines: What was requested / What was done / Confirmed by. Plain prose, past tense, 40-100 words total. Then on a final line: CLOSE_CODE: one of Closed Complete, Closed Incomplete.`
    const m = await model('close note', d, DRAFT_SYSTEM, `${facts(d)}\n\n${req_}`)
    if (m) html = m.replace(/^(What was requested|What was done|Confirmed by)\s*:?\s*$/gim, '<h4>$1</h4>').replace(/\n(?=CLOSE_CODE)/, '\n\n')
    else {
      const asked = d.request?.variables.length ? d.request.variables.map((v) => `${esc(v.q)}: ${esc(first(v.v, 80))}`).join('; ') : esc(d.fields.description || d.title)
      const done = notes.length ? notes.map((n) => `<mark class="rec">${esc(first(n.text.replace(/\s+/g, ' '), 220))}</mark>`).join(' ') : sim ? `<mark class="inf">${esc(first(sim.close_notes.replace(/\s+/g, ' '), 260))} (what completed ${sim.number}; confirm it applies here)</mark>` : '<mark class="inf">No work notes were recorded. Steps you tick will appear here.</mark>'
      html = `<h4>What was requested</h4>${esc(caller)} asked for ${esc(d.fields.category || d.title)}. ${asked}\n<h4>What was done</h4>${done}\n<h4>Confirmed by</h4><mark class="inf">Confirmation from ${esc(caller)} pending.</mark>\n\nCLOSE_CODE: Closed Complete`
    }
  } else if (kind === 'close') {
    const req_ = `Write resolution notes with exactly these headings on their own lines: Problem / Actions taken / Root cause / Resolution. Plain prose, past tense, 60-120 words total. Then on a final line: CLOSE_CODE: one of Solved (Permanently), Solved (Workaround/Temporarily), Not Solved (Not Reproducible), Closed/Resolved by Caller, Duplicate. A close code is a claim about what happened on THIS ticket: pick one only when this ticket's own work notes or comments record a validated outcome. If nothing on this ticket records a fix (the look-alikes do not count), write Resolution as what is still outstanding and put CLOSE_CODE: Not ready to close. Never write Not Reproducible for a ticket nobody has tried to reproduce.`
    const m = await model('close note', d, DRAFT_SYSTEM, `${facts(d)}\n\n${req_}`)
    if (m) html = m.replace(/^(Problem|Actions taken|Root cause|Resolution)\s*:?\s*$/gim, '<h4>$1</h4>').replace(/\n(?=CLOSE_CODE)/, '\n\n')
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
    // No caller, nobody to write to: a message asking "who reported this" has no recipient.
    if (!d.fields.caller_id) return res.json({ kind, title: '', html: 'No caller is recorded on this ticket, so there is nobody to send a message to. Find out who reported it and set the caller first; the message can be drafted after that.', source: 'rules' })
    const m = await model('message to caller', d, DRAFT_SYSTEM, `${facts(d)}\n\nWrite a short, friendly comment to ${caller} from the agent. ${confirm ? 'The last work note says it works: ask them to confirm it is fixed, and say the ticket closes on their yes.' : asks.length ? `Ask only for: ${asks.join('; ')}.` : 'Ask them to confirm it is still happening.'} The comments in the journal are the caller's own replies: never ask for anything they have already given there, and acknowledge what they did give. This message goes to the caller, so use only this ticket's own fields, comments and work notes: never mention look-alike tickets, and never suggest the issue may be fixed or reactivated unless a note on THIS ticket says so. Under 80 words. Plain text, no markup, no <mark> tags.`)
    // The model is told to mark quoted text elsewhere; a message to a caller carries no markup.
    html = m ? esc(m.replace(/<\/?mark[^>]*>/g, '')) : `Hi ${esc(caller.split(' ')[0]!)}, I am picking up your ticket "${esc(d.title)}"${d.fields.opened_at ? ` from ${d.fields.opened_at.slice(0, 10)}` : ''}. ${confirm ? 'The notes suggest it was fixed. Can you confirm it is still working? If yes, I will close the ticket.' : asks.length ? `To move it forward I need: ${asks.join('; ')}.` : 'Could you confirm it is still happening?'} Thanks.`
  } else if (kind === 'problem') {
    // One ticket is not a recurrence. The steps only propose a problem record at three or more.
    if (d.sameTitle.length < 1) return res.json({ kind, title: '', html: `No other open incident has the title "${esc(d.title)}", so there is no recurrence to record. A problem record is drafted when at least two open tickets share the title.`, source: 'rules' })
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
  let table: string = d.table, method: 'PATCH' | 'POST' = 'PATCH', path = `/api/now/table/${d.table}/${d.sys_id}`, body: Record<string, string> = {}, what = ''
  const incidentOnly = ['hold', 'kb_draft', 'problem', 'claim']
  if (incidentOnly.includes(action) && d.kind !== 'incident') return res.status(400).json({ error: `${action} applies to incidents, not to a ${d.kind_word}` })
  switch (action) {
    case 'work_note': body = { work_notes: text(payload.text) }; what = 'Work note'; break
    case 'comment': body = { comments: text(payload.text) }; what = d.kind === 'incident' ? 'Comment to caller' : 'Comment to requester'; break
    case 'claim': if (!ID.test(String(payload.user))) return res.status(400).json({ error: 'user sys_id required' }); body = { assigned_to: payload.user, work_notes: 'Picked up via NowOps.' }; if (d.raw.state === '1') body.state = '2'; what = 'Claimed'; break
    case 'hold': body = { state: '3', hold_reason: HOLD[payload.reason] ?? '1', work_notes: text(payload.note || `Put on hold (${payload.reason || 'Awaiting Caller'}) via NowOps.`) }; what = `On hold, ${payload.reason || 'Awaiting Caller'}`; break
    // Approve or reject one approval record on a request item. The record must belong to this item.
    case 'approve': case 'reject': {
      const a = d.request?.approvals.find((x) => x.id === String(payload.approval) && x.state_raw === 'requested')
      if (!a) return res.status(400).json({ error: 'no approval in Requested state with that id on this request item' })
      table = 'sysapproval_approver'; path = `/api/now/table/sysapproval_approver/${a.id}`
      body = { state: action === 'approve' ? 'approved' : 'rejected', comments: text(payload.comment || `${action === 'approve' ? 'Approved' : 'Rejected'} via NowOps.`) }
      what = `${action === 'approve' ? 'Approved' : 'Rejected'} (approver ${a.approver})`; break }
    case 'reassign': {
      if (payload.group) { const g = (await rows('sys_user_group', `name=${text(payload.group)}^active=true`, 'sys_id', 1))[0]; if (!g) return res.status(400).json({ error: `group "${payload.group}" not found` }); body.assignment_group = vv(g, 'sys_id'); body.assigned_to = '' }
      if (payload.user) { const u = (await rows('sys_user', `name=${text(payload.user)}^active=true`, 'sys_id', 1))[0]; if (!u) return res.status(400).json({ error: `user "${payload.user}" not found` }); body.assigned_to = vv(u, 'sys_id') }
      body.work_notes = text(payload.note || `Handed over via NowOps: ${payload.reason || 'has closed the matching tickets on this instance'}.`); what = `Handed to ${payload.group || payload.user}`; break }
    case 'resolve':
      if (d.kind === 'incident') { body = { state: '6', close_code: text(payload.close_code || 'Solved (Permanently)'), close_notes: text(payload.close_notes), work_notes: 'Resolved via NowOps.' }; what = 'Resolved' }
      else { const incomplete = /incomplete/i.test(String(payload.close_code ?? '')); body = { state: incomplete ? '4' : '3', close_notes: text(payload.close_notes), work_notes: `${incomplete ? 'Closed incomplete' : 'Closed complete'} via NowOps.` }; what = incomplete ? 'Closed incomplete' : 'Closed complete' }
      break
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
  // The work note names the person, since ServiceNow only sees the service credential.
  for (const k of ['work_notes', 'comments']) if (body[k]) body[k] = body[k].replace(/via NowOps(?=[.:])/, `via NowOps by ${who}`)
  const evidence = `${method} ${table} · ${Object.keys(body).join(', ')}`
  if (!WRITES) { logAudit(who, `${what} (dry run, RESOLVE_WRITES is off)`, d.number, evidence); return res.json({ dryRun: true, table, method, sys_id: d.sys_id, body, message: 'Nothing was written. Set RESOLVE_WRITES=true to write to the instance.' }) }
  try {
    const r = await sn.send<{ result: Rec }>(method, path, body)
    cache.delete(`ticket:${d.number}`); if (d.request?.ritm) cache.delete(`ticket:${d.request.ritm}`); for (const k of [...cache.keys()]) if (k.startsWith('queue:')) cache.delete(k)
    logAudit(who, what, d.number, evidence)
    res.json({ dryRun: false, table, method, sys_id: r.result?.sys_id ?? d.sys_id, number: r.result?.number ?? d.number, body })
  } catch (e) { res.status(502).json({ error: (e as Error).message }) }
})

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
