import { describe, it, expect, vi } from 'vitest'
import {
  buildStatsPath, buildListUrl, isAggregate, isTableName, isEncodedQuery, makeStats,
} from '../src/servicenow/stats.js'
import { makeSnClient } from '../src/servicenow/client.js'
import { ServiceNowUnavailableError } from '../src/servicenow/types.js'
import { parseConfig } from '../src/config.js'

const cfg = parseConfig({
  ANTHROPIC_API_KEY: 'sk-test-key-1234567890',
  ANTHROPIC_BASE_URL: 'https://llmproxy.example.com',
  CLAUDE_MODEL: 'm',
  SN_INSTANCE_URL: 'https://sn.example.com',
  SN_CLIENT_ID: 'cid',
  SN_CLIENT_SECRET: 'csecret',
  SN_REFRESH_TOKEN: 'rtoken',
})

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const tokenResponse = () => ok({ access_token: 'tok-1', expires_in: 1800 })
const snFetch = (handler: (url: string) => Response | Promise<Response>) =>
  vi.fn(async (u: unknown, _init?: RequestInit) =>
    String(u).includes('oauth_token.do') ? tokenResponse() : handler(String(u)))
const stats = (fetchImpl: unknown) => makeStats(makeSnClient(cfg, fetchImpl as never))

describe('isAggregate', () => {
  it('accepts the five permitted aggregates', () => {
    for (const a of ['count', 'avg', 'sum', 'min', 'max']) expect(isAggregate(a)).toBe(true)
  })
  it('rejects anything else, including SQL-ish input', () => {
    expect(isAggregate('median')).toBe(false)
    expect(isAggregate('count; DROP')).toBe(false)
    expect(isAggregate(undefined)).toBe(false)
  })
})

describe('isTableName', () => {
  it('accepts plain ServiceNow table names', () => {
    for (const t of ['incident', 'task_sla', 'sn_si_incident', 'x_ustgl_backlog_be_thing']) {
      expect(isTableName(t)).toBe(true)
    }
  })
  it('rejects anything that could escape the stats path', () => {
    for (const t of ['../table/incident', 'incident?sysparm_x=1', 'incident/foo', 'Incident', '', undefined]) {
      expect(isTableName(t)).toBe(false)
    }
  })
})

describe('isEncodedQuery', () => {
  it('accepts every filter shape measured live in spec §8b', () => {
    for (const f of [
      '',
      'active=true',
      'active=true^priority=1',
      'active=true^assigned_toISEMPTY',
      'active=true^assignment_group.name=Network',
      'has_breached=true',
      'active=true^has_breached=false^percentage>80',
      'state=3',
      'stateIN6,7',
      'active=true^priority=1^opened_at<javascript:gs.daysAgoStart(30)',
      'resolved_atONLast month@javascript:gs.beginningOfLastMonth()@javascript:gs.endOfLastMonth()',
      'active=true^u_past_incidentsISNOTEMPTY^stateIN2^assigned_toISNOTEMPTY^priorityNOT IN1,5',
      'active=true^ORstate=2',
    ]) expect(isEncodedQuery(f), f).toBe(true)
  })

  it('rejects prose, which ServiceNow silently ignores and answers with the whole table', () => {
    // Measured live: 'this is not a query!!' returned 36,030 — the total, confidently.
    for (const f of ['this is not a query!!', 'show me open incidents', 'active = true', '^^']) {
      expect(isEncodedQuery(f), f).toBe(false)
    }
  })
})

describe('buildStatsPath', () => {
  it('uses sysparm_count for count', () => {
    const p = buildStatsPath({ table: 'incident', filter: 'active=true', aggregate: 'count' })
    expect(p).toBe('/api/now/stats/incident?sysparm_count=true&sysparm_query=active%3Dtrue')
  })

  it('uses sysparm_<agg>_fields for the others', () => {
    const p = buildStatsPath({
      table: 'incident', filter: 'priority=2', aggregate: 'avg', field: 'calendar_duration',
    })
    expect(p).toContain('sysparm_avg_fields=calendar_duration')
    expect(p).toContain('sysparm_query=priority%3D2')
  })

  it('refuses a non-count aggregate with no field', () => {
    expect(() => buildStatsPath({ table: 'incident', filter: '', aggregate: 'avg' }))
      .toThrow(/requires a field/)
  })

  it('omits sysparm_query entirely when the filter is empty', () => {
    expect(buildStatsPath({ table: 'sn_vul_vulnerable_item', filter: '', aggregate: 'count' }))
      .toBe('/api/now/stats/sn_vul_vulnerable_item?sysparm_count=true')
  })
})

describe('buildListUrl', () => {
  it('deep links to the same records the number counted', () => {
    const u = buildListUrl('https://sn.example.com', {
      table: 'incident', filter: 'active=true^state=2', aggregate: 'count',
    })
    expect(u).toBe('https://sn.example.com/incident_list.do?sysparm_query=active%3Dtrue%5Estate%3D2')
  })
})

describe('makeStats.run', () => {
  it('returns the count as a number, with the filter, label and link intact', async () => {
    const r = await stats(snFetch(() => ok({ result: { stats: { count: '5513' } } })))
      .run({ table: 'incident', filter: 'active=true', aggregate: 'count', label: 'open incidents' })
    expect(r.value).toBe(5513)
    expect(r.filter).toBe('active=true')
    expect(r.label).toBe('open incidents')
    expect(r.url).toContain('incident_list.do')
  })

  it('keeps a duration aggregate as a string', async () => {
    const r = await stats(snFetch(() => ok({ result: { stats: { avg: { calendar_duration: '00:43:22' } } } })))
      .run({ table: 'incident', filter: 'priority=2', aggregate: 'avg', field: 'calendar_duration' })
    expect(r.value).toBe('00:43:22')
  })

  it('rejects an aggregate outside the five, without calling ServiceNow', async () => {
    const fetchImpl = vi.fn()
    await expect(
      stats(fetchImpl).run({ table: 'incident', filter: '', aggregate: 'median' as never }),
    ).rejects.toThrow(/aggregate/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a table name that is not a plain identifier, without calling ServiceNow', async () => {
    const fetchImpl = vi.fn()
    await expect(
      stats(fetchImpl).run({ table: '../oauth_token.do', filter: '', aggregate: 'count' }),
    ).rejects.toThrow(/table/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a filter that is not an encoded query, without calling ServiceNow', async () => {
    const fetchImpl = vi.fn()
    await expect(
      stats(fetchImpl).run({ table: 'incident', filter: 'this is not a query!!', aggregate: 'count' }),
    ).rejects.toThrow(/filter/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('declines a filter naming a field the table does not have, before counting', async () => {
    // ServiceNow silently drops an unknown field from a filter and returns the whole
    // table — measured: product_type=full on alm_license returned all 202 rows.
    const calls: string[] = []
    const fetchImpl = snFetch((u) => {
      calls.push(u)
      // The probe: table API echoes back only the fields that exist.
      if (u.includes('/api/now/table/')) return ok({ result: [{ sys_id: 'x', active: 'true' }] })
      return ok({ result: { stats: { count: '202' } } })
    })
    await expect(
      stats(fetchImpl).run({ table: 'alm_license', filter: 'active=true^product_type=full', aggregate: 'count' }),
    ).rejects.toThrow(/product_type/)
    expect(calls.some((u) => u.includes('/api/now/stats/'))).toBe(false)
  })

  it('validates dotted and aggregate fields the same way, then counts', async () => {
    const fetchImpl = snFetch((u) => {
      if (u.includes('/api/now/table/')) {
        const fields = new URL(u).searchParams.get('sysparm_fields')!.split(',')
        const rec: Record<string, string> = {}
        for (const f of fields) rec[f] = 'v'
        return ok({ result: [rec] })
      }
      return ok({ result: { stats: { avg: { calendar_duration: '00:43:22' } } } })
    })
    const r = await stats(fetchImpl).run({
      table: 'incident', filter: 'active=true^assignment_group.name=Network^ORpriority=1', aggregate: 'avg', field: 'calendar_duration',
    })
    expect(r.value).toBe('00:43:22')
    const probe = fetchImpl.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/api/now/table/incident'))!
    expect(new URL(probe).searchParams.get('sysparm_fields')!.split(',').sort())
      .toEqual(['active', 'assignment_group.name', 'calendar_duration', 'priority'])
  })

  it('skips field validation when the table is empty — there is nothing to count anyway', async () => {
    const fetchImpl = snFetch((u) =>
      u.includes('/api/now/table/') ? ok({ result: [] }) : ok({ result: { stats: { count: '0' } } }))
    const r = await stats(fetchImpl).run({ table: 'sn_vul_entry', filter: 'active=true', aggregate: 'count' })
    expect(r.value).toBe(0)
  })

  it('raises rather than repairing a filter ServiceNow rejects', async () => {
    // Well-formed shape, so it reaches the instance; the instance says no.
    await expect(
      stats(snFetch(() => new Response('Invalid query', { status: 400 })))
        .run({ table: 'incident', filter: 'no_such_field=1', aggregate: 'count' }),
    ).rejects.toBeInstanceOf(ServiceNowUnavailableError)
  })

  it('raises when the body carries no usable stats', async () => {
    await expect(
      stats(snFetch(() => ok({ result: {} }))).run({ table: 'incident', filter: '', aggregate: 'count' }),
    ).rejects.toThrow(/no value/)
  })
})
