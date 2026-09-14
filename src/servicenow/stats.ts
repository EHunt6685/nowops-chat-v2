import type { SnClient } from './client.js'

/** The only aggregates we will execute. Anything else is a decline, never a coercion. */
export const AGGREGATES = ['count', 'avg', 'sum', 'min', 'max'] as const
export type Aggregate = (typeof AGGREGATES)[number]

/** What the model supplies — as data. It never supplies a URL, a method or a path. */
export interface MetricRequest {
  table: string
  filter: string
  aggregate: Aggregate
  field?: string
  /** Short noun phrase for the sentence around the number, e.g. "open incidents". Display only. */
  label?: string
}

export interface MetricResult extends MetricRequest {
  /** Numeric where ServiceNow returns a number; a string for durations like '00:43:22'. */
  value: number | string
  url: string
}

export function isAggregate(v: unknown): v is Aggregate {
  return typeof v === 'string' && (AGGREGATES as readonly string[]).includes(v)
}

/**
 * The table name is the one piece of model output that lands in a URL *path*.
 * ServiceNow table names are lowercase identifiers; anything else could escape
 * /api/now/stats/. This is a shape check, not an allowlist — ACLs decide access.
 */
export function isTableName(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9_]+$/.test(v)
}

/**
 * Shape check for an encoded query. ServiceNow does NOT reliably reject prose —
 * 'this is not a query!!' was silently ignored and returned the whole table (36,030),
 * as confidently as any real answer. Each ^-separated clause must be a field name
 * (lowercase identifier, dots allowed) followed immediately by an operator: a
 * comparison symbol or an uppercase keyword such as IN, ISEMPTY, ON, LIKE.
 * A wrong field name still passes; only prose is stopped here.
 */
export function isEncodedQuery(filter: string): boolean {
  if (filter === '') return true
  return filter.split('^').every((c) =>
    c === 'EQ' || /^ORDERBY(DESC)?[a-z0-9_.]+$/.test(c) || /^(NQ|OR)?[a-z0-9_.]+(=|!=|>=|<=|>|<|[A-Z])/.test(c))
}

/** Field names a filter refers to: the identifier before each clause's operator. */
export function filterFields(filter: string): string[] {
  const names = new Set<string>()
  for (const clause of filter.split('^')) {
    if (clause === '' || clause === 'EQ' || clause.startsWith('ORDERBY')) continue
    const m = /^(?:NQ|OR)?([a-z0-9_.]+)/.exec(clause)
    if (m) names.add(m[1]!)
  }
  return [...names]
}

/** count uses sysparm_count; every other aggregate uses sysparm_<agg>_fields. */
export function buildStatsPath(req: MetricRequest): string {
  const params = new URLSearchParams()
  if (req.aggregate === 'count') {
    params.set('sysparm_count', 'true')
  } else {
    if (!req.field) throw new Error(`aggregate '${req.aggregate}' requires a field`)
    params.set(`sysparm_${req.aggregate}_fields`, req.field)
  }
  if (req.filter) params.set('sysparm_query', req.filter)
  return `/api/now/stats/${req.table}?${params.toString()}`
}

/** The link that settles any argument about the number. */
export function buildListUrl(instanceUrl: string, req: MetricRequest): string {
  return `${instanceUrl}/${req.table}_list.do?sysparm_query=${encodeURIComponent(req.filter)}`
}

interface StatsBody {
  result?: { stats?: { count?: string } & Record<string, unknown> }
}

/** ServiceNow returns everything as strings. Numbers become numbers; durations stay text. */
function coerce(raw: string): number | string {
  const n = Number(raw)
  return raw.trim() !== '' && Number.isFinite(n) ? n : raw
}

function extract(body: StatsBody, req: MetricRequest): number | string {
  const stats = body.result?.stats
  if (!stats) throw new Error('ServiceNow returned no value for this query')

  if (req.aggregate === 'count') {
    if (stats.count === undefined) throw new Error('ServiceNow returned no value for this query')
    return coerce(stats.count)
  }

  const group = stats[req.aggregate] as Record<string, string> | undefined
  const raw = req.field ? group?.[req.field] : undefined
  if (raw === undefined) throw new Error('ServiceNow returned no value for this query')
  return coerce(raw)
}

export function makeStats(sn: SnClient) {
  return {
    async run(req: MetricRequest): Promise<MetricResult> {
      // Validate before spending a token refresh or a round trip.
      if (!isAggregate(req.aggregate)) {
        throw new Error(`unsupported aggregate '${String(req.aggregate)}'`)
      }
      if (!isTableName(req.table)) {
        throw new Error(`table name '${String(req.table)}' is not a plain identifier`)
      }
      if (!isEncodedQuery(req.filter)) {
        throw new Error(`filter '${req.filter}' is not an encoded query`)
      }

      // ServiceNow silently drops a clause whose field does not exist and returns the
      // whole table — measured: product_type=full on alm_license counted all 202 rows.
      // One record with the requested fields tells us which ones are real: the table
      // API omits unknown fields from the response. An empty table proves nothing and
      // counts to zero anyway, so it is not validated.
      const fields = [...filterFields(req.filter), ...(req.field ? [req.field] : [])]
      if (fields.length) {
        const probe = new URLSearchParams({ sysparm_fields: fields.join(','), sysparm_limit: '1' })
        const sample = (await sn.get<{ result?: Record<string, unknown>[] }>(
          `/api/now/table/${req.table}?${probe}`,
        )).result?.[0]
        const unknown = sample ? fields.filter((f) => !(f in sample)) : []
        if (unknown.length) throw new Error(`field '${unknown.join("', '")}' does not exist on ${req.table}`)
      }

      // The client rejects a non-2xx as ServiceNowUnavailableError. Deliberately no
      // repair attempt here: a second guess at a query is a second chance to be wrong.
      const body = await sn.get<StatsBody>(buildStatsPath(req))

      return {
        ...req,
        value: extract(body, req),
        url: buildListUrl(sn.instanceUrl, req),
      }
    },
  }
}
