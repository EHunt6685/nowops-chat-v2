import { describe, it, expect, vi } from 'vitest'
import {
  buildStatsPath, buildListUrl, isAggregate, isTableName, makeStats,
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

  it('raises rather than repairing a filter ServiceNow rejects', async () => {
    await expect(
      stats(snFetch(() => new Response('Invalid query', { status: 400 })))
        .run({ table: 'incident', filter: 'nonsense!!', aggregate: 'count' }),
    ).rejects.toBeInstanceOf(ServiceNowUnavailableError)
  })

  it('raises when the body carries no usable stats', async () => {
    await expect(
      stats(snFetch(() => ok({ result: {} }))).run({ table: 'incident', filter: '', aggregate: 'count' }),
    ).rejects.toThrow(/no value/)
  })
})
