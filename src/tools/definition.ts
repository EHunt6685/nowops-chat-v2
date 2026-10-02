// run_definition: a dashboard tile's own query, optionally narrowed by records a lookup returned.
// The server writes the narrowing phrase from the filter it applied, so the words and the number
// cannot disagree. Seen live 2026-09-30: the tile's 5,413 was shown for "the Network group".
import { makeStats, type MetricRequest, type MetricResult } from '../servicenow/stats.js'
import { isNoDataYet } from '../definitions.js'
import { narrowField, narrowPhrase } from './tables.js'
import { ToolError, str, type ToolDef, type ToolContext } from './types.js'
import { SYS_ID_RE } from './query.js'

interface Narrow { kind: string; sys_ids: string[] }

function readNarrow(raw: unknown, ctx: ToolContext): Narrow[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new ToolError('narrow must be a list of {kind, sys_ids}')
  return raw.slice(0, 3).map((n) => {
    const kind = str((n as Record<string, unknown>)?.kind, 40)
    const ids = (n as Record<string, unknown>)?.sys_ids
    if (!kind || !Array.isArray(ids) || !ids.length) throw new ToolError('each narrow needs a kind and at least one sys_id')
    const sys_ids = ids.map((x) => str(x, 32)).slice(0, 50)
    for (const id of sys_ids) {
      if (!SYS_ID_RE.test(id)) throw new ToolError(`"${id}" is not a sys_id`)
      const r = ctx.turn.resolved.get(id)
      if (!r) throw new ToolError(`sys_id ${id} was not returned by resolve_reference in this turn; look the name up first`)
      if (r.kind !== kind) throw new ToolError(`sys_id ${id} is a ${r.kind}, not a ${kind}`)
    }
    return { kind, sys_ids }
  })
}

export function applyNarrow(req: MetricRequest, narrows: Narrow[], ctx: ToolContext): { request: MetricRequest; phrase: string } {
  let filter = req.filter
  const phrases: string[] = []
  for (const n of narrows) {
    const field = narrowField(req.table, n.kind)
    if (!field) throw new ToolError(`${req.table} cannot be narrowed by ${n.kind}`)
    filter = [filter, n.sys_ids.length === 1 ? `${field}=${n.sys_ids[0]}` : `${field}IN${n.sys_ids.join(',')}`].filter(Boolean).join('^')
    phrases.push(narrowPhrase(n.kind, n.sys_ids.map((id) => ctx.turn.resolved.get(id)!.name)))
  }
  const phrase = phrases.join(' ')
  return { request: { ...req, filter, label: [req.label, phrase].filter(Boolean).join(' ') }, phrase }
}

export const runDefinition: ToolDef = {
  name: 'run_definition',
  description:
    'Run a NowOps dashboard definition (a tile) by id, exactly as the dashboard does, so the chatbot and the dashboard always agree. ' +
    'ALWAYS prefer this over count when a definition matches the question exactly. To narrow a tile to a group, location, service, CI, user, company or department, ' +
    'first call resolve_reference, then pass the returned sys_ids in narrow; the server applies the filter and writes the narrowing phrase. ' +
    'A tile that the question narrows by a date range or a priority the tile does not have is NOT an exact match: use count with the tile\'s filter plus your clause instead. ' +
    'The DEFINITIONS list in your instructions has every id.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Definition id from the DEFINITIONS list, e.g. open_incidents, sla_breached' },
      narrow: {
        type: 'array',
        description: 'Optional narrowing: records returned by resolve_reference this turn',
        items: { type: 'object', properties: { kind: { type: 'string' }, sys_ids: { type: 'array', items: { type: 'string' } } }, required: ['kind', 'sys_ids'] },
      },
    },
    required: ['id'],
  },
  async run(args, ctx) {
    const id = str(args.id, 60)
    if (!ctx.kpis) throw new ToolError('no definitions are loaded on this server')
    const kpi = ctx.kpis.byId(id)
    if (!kpi) throw new ToolError(`"${id}" is not a definition id; use an id from the DEFINITIONS list`)
    const definition = { id: kpi.id, name: kpi.name, meaning: kpi.meaning }
    if (!kpi.request) return { data: { definition, unavailable: kpi.unavailable, note: 'Tell the user this definition exists but is not available on this instance, and why. Do not compose a substitute count.' } }
    const narrows = readNarrow(args.narrow, ctx)
    const stats = makeStats(ctx.sn)
    const base = { ...kpi.request, label: kpi.name.toLowerCase().replace(/\s*\(.*?\)/g, '') }
    let result: MetricResult, phrase = ''
    if (kpi.ratio) {
      const n = applyNarrow(kpi.ratio.num, narrows, ctx), d = applyNarrow(kpi.ratio.den, narrows, ctx)
      phrase = n.phrase
      const [nr, dr] = await Promise.all([stats.run(n.request), stats.run(d.request)])
      const nv = Number(nr.value), dvv = Number(dr.value)
      const pct = dvv > 0 && Number.isFinite(nv) ? Math.round(1000 * nv / dvv) / 10 : null
      result = { ...nr, label: [base.label, phrase].filter(Boolean).join(' '), filter: `${nr.filter || 'all'} ÷ ${dr.filter || 'all'}`, value: pct === null ? 'no data' : `${pct}%` }
      return {
        data: { definition, value: result.value, numerator: nv, denominator: dvv, label: result.label, narrowed: phrase || undefined, table: result.table, filter: result.filter, note: dvv === 0 ? 'The denominator is zero: nothing to measure yet.' : undefined },
        url: nr.url,
      }
    }
    const a = applyNarrow(base, narrows, ctx)
    phrase = a.phrase
    result = await stats.run(a.request)
    if (isNoDataYet(kpi, result.value)) {
      return { data: { definition, no_data_yet: true, note: `"${kpi.name}" is defined and its table exists here, but nothing is recorded for it on this instance yet: ${kpi.meaning}. Say so rather than reading out a zero.` }, url: result.url }
    }
    // An average says how many records it rests on; a share says what it is a share of. Both are read from the
    // instance, never written into text, so they are right on every instance (D-011).
    let records: number | undefined, thin: string | undefined
    if (result.aggregate === 'avg') {
      records = Number((await stats.run({ ...a.request, aggregate: 'count', field: undefined })).value)
      if (records === 0) return { data: { definition, no_data_yet: true, note: `No record on this instance has the field this average needs (${result.field}). Say the figure cannot be measured here.` }, url: result.url }
      if (records < 10) thin = `only ${records} record${records === 1 ? '' : 's'} have the field; say the average rests on that many`
    }
    let of: { definition: string; value: number; name: string } | undefined
    const basisId = (kpi as { basis?: string }).basis
    if (basisId) {
      const b = ctx.kpis.byId(basisId)
      if (b?.request) {
        const bv = Number((await stats.run(applyNarrow(b.request, narrows, ctx).request)).value)
        if (bv === 0) return { data: { definition, no_data_yet: true, note: `Nothing to measure: ${b.name.toLowerCase()} is zero on this instance, so this share has no basis.` }, url: result.url }
        of = { definition: b.id, value: bv, name: b.name.toLowerCase() }
      }
    }
    return {
      data: { definition, value: result.value, label: a.request.label, narrowed: phrase || undefined, table: result.table, filter: result.filter || '(all records)', aggregate: result.aggregate, field: result.field, records, thin, of, note: of ? `Quote this as "${result.value} of ${of.value} ${of.name}".` : undefined },
      url: result.url,
    }
  },
}
