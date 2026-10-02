import { describe, it, expect } from 'vitest'
import { DEFINITIONS, makeDefinitions, scoreName, DEFINITION_ID_RE } from '../src/definitions.js'

const scanned = { incident: { present: true, missing_fields: [] }, task_sla: { present: true, missing_fields: [] } }
const params = { open_states: '1,2,3,9', sla_p1_resolution: 'abc123' }

describe('makeDefinitions', () => {
  it('lists every definition in the catalogue, marking what this tenant cannot answer', () => {
    const k = makeDefinitions(() => ({ params, tables: scanned, confirmed: true }))
    const c = k.catalogue()
    expect(c).toHaveLength(DEFINITIONS.length)
    expect(c.find((e) => e.id === 'open_p1')).toMatchObject({ name: 'Open P1 Incidents', available: true })
    // change_request was not in the scan, so its tiles are off — but still listed, so the model names them.
    expect(c.find((e) => e.id === 'open_changes')?.available).toBe(false)
  })

  it('adds the meaning only where names alone are ambiguous', () => {
    const k = makeDefinitions(() => ({ params, tables: scanned }))
    const c = k.catalogue()
    expect(c.find((e) => e.id === 'sla_breached')?.meaning).toContain('Completed incident resolution SLAs')
    expect(c.find((e) => e.id === 'open_incidents')?.meaning).toBeUndefined()
  })

  it('uses a state class from the scan for every state-based tile, and reports the parameter a scan did not set', () => {
    const k = makeDefinitions(() => ({ params: { ...params, closed_states: '6,7,20', on_hold_states: '3,11', in_progress_states: '2,9', cancelled_states: '8,10' }, tables: scanned, confirmed: true }))
    expect(k.byId('closed_incidents')?.request?.filter).toBe('stateIN6,7,20')
    expect(k.byId('on_hold')?.request?.filter).toBe('stateIN3,11')
    expect(k.byId('backlog')?.request?.filter).toContain('stateIN2,9')
    expect(k.byId('mttr_p1')?.request?.filter).toBe('stateIN6,7,20^priority=1^calendar_duration>1970-01-01 00:00:00')
    // Without the scan's cancelled classes the tile is off, with the parameter named, never a guessed state number.
    const bare = makeDefinitions(() => ({ params, tables: scanned, confirmed: true }))
    expect(bare.byId('cancelled')?.unavailable).toContain('cancelled_states')
    expect(k.params().closed_states).toBe('6,7,20')
  })

  it('exposes the basis of a share so the server can read it live', () => {
    const k = makeDefinitions(() => ({ params, tables: { ...scanned, cmdb_ci_server: { present: true, missing_fields: [] } }, confirmed: true }))
    expect(k.byId('warranty_expired')?.basis).toBe('servers_with_warranty')
    expect(k.byId('servers_with_warranty')?.request?.filter).toBe('warranty_expirationISNOTEMPTY')
  })

  it('resolves tenant parameters into the tile query', () => {
    const k = makeDefinitions(() => ({ params, tables: scanned, confirmed: true }))
    const m = k.byId('open_p1')
    expect(m?.request?.filter).toBe('stateIN1,2,3,9^priority=1')
    expect(m?.request?.label).toBe('open p1 incidents')
  })

  it('reports a parameterised definition as unavailable until the tenant parameters exist', () => {
    const k = makeDefinitions(() => ({ tables: null }))
    expect(k.byId('open_p1')?.unavailable).toMatch(/tenant parameters not set/)
    // Rows without a parameter work with no scan at all: tables are assumed present.
    // Completed, type SLA, breached: the same population as the attainment tiles (D-010).
    expect(k.byId('sla_breached')?.request?.filter).toBe('stage=completed^sla.type=SLA^task.sys_class_name=incident^has_breached=true')
  })

  it('returns null for an id that is not a definition', () => {
    const k = makeDefinitions(() => ({ tables: null }))
    expect(k.byId('made_up')).toBeNull()
  })

  it('builds a ratio from its two parts', () => {
    const k = makeDefinitions(() => ({ params, tables: scanned }))
    const m = k.byId('sla_attainment')
    expect(m?.ratio?.num.filter).toContain('has_breached=false')
    expect(m?.ratio?.den.filter).toBe('stage=completed^sla.type=SLA^task.sys_class_name=incident')
  })

  it('knows which tables an available definition covers', () => {
    const k = makeDefinitions(() => ({ params, tables: scanned }))
    expect(k.coversTable('task_sla')).toBe(true)
    expect(k.coversTable('change_request')).toBe(false)
  })

  it('accepts only ids shaped like a definition id', () => {
    expect(DEFINITION_ID_RE.test('open_p1')).toBe(true)
    expect(DEFINITION_ID_RE.test('Open P1')).toBe(false)
    expect(DEFINITION_ID_RE.test('../etc')).toBe(false)
  })
})

describe('scoreName (diagnostic word matcher)', () => {
  it('folds breach synonyms so "violations" reaches the SLA breach tile', () => {
    expect(scoreName('how many SLA violations', 'SLA Breaches (incidents)')).toBeGreaterThan(0)
    expect(scoreName('how many SLAs were missed', 'SLA Breaches (incidents)')).toBeGreaterThan(0)
  })
  it('does not match on a lone generic word', () => {
    expect(scoreName('how many tickets', 'Open P1 Incidents')).toBe(0)
  })
})
