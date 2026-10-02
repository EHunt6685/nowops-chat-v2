import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { numbersIn, ungrounded, parseCited, runAgent, type AgentModel } from '../src/llm/agent.js'
import { lintQuery } from '../src/tools/query.js'
import { nameVariants } from '../src/tools/reference.js'
import { narrowPhrase, narrowField, tableAllowed } from '../src/tools/tables.js'
import { executeTool } from '../src/tools/index.js'
import { makeTurn, type ToolResult, type ToolContext } from '../src/tools/types.js'
import type { SnClient } from '../src/servicenow/client.js'

const result = (id: string, data: Record<string, unknown>): ToolResult => ({ id, tool: 'count', args: {}, data, ms: 1 })

describe('grounding check', () => {
  it('finds the figures in an answer and ignores list markers, ticket numbers and dates', () => {
    expect(numbersIn('There are 5,527 breached SLAs [r1] and 76 incidents.')).toEqual(['5527', '76'])
    expect(numbersIn('1. Reset it\n2. Confirm with INC0011804 on 2026-09-30 at 14:05')).toEqual([])
    expect(numbersIn('SLA attainment is 61.5% [r2]')).toEqual(['61.5'])
  })
  it('passes a figure that a cited result contains, including a rounded percentage', () => {
    expect(ungrounded('5,527 breached SLAs [r1]', [result('r1', { count: 5527 })])).toEqual([])
    expect(ungrounded('about 62% [r1]', [result('r1', { value: '61.5%' })])).toEqual([])
  })
  it('reads a comma-separated value list in a filter as separate figures', () => {
    // Seen live 2026-10-02: "priority 2–4" was rejected because the filter's "2,3,4" was read as 234.
    expect(ungrounded('1,304 incidents, priority 2–4 [r1]', [result('r1', { value: 1304, filter: 'stateIN1,2,3^priorityIN2,3,4' })])).toEqual([])
  })
  it('does not treat a definition\'s description as evidence', () => {
    // Seen live 2026-10-02: "96 of 625 servers" from one instance's meaning text was repeated on another instance.
    const r = result('r1', { definition: { id: 'warranty_expired', name: 'x', meaning: '96 of 625 here' }, value: 0, note: 'see 42' })
    expect(ungrounded('96 of 625 servers [r1]', [r])).toEqual(['96', '625'])
    expect(ungrounded('0 servers [r1]', [r])).toEqual([])
  })
  it('rejects a figure no cited result contains', () => {
    expect(ungrounded('5,413 open incidents for the Network group [r1]', [result('r1', { value: 5527, narrowed: 'for the Network group' })])).toEqual(['5413'])
    // Cited nothing: every number is ungrounded.
    expect(ungrounded('There are 42 incidents.', [])).toEqual(['42'])
  })
  it('reads the cited ids in order, once each', () => {
    expect(parseCited('a [r2] b [r1] c [r2]')).toEqual(['r2', 'r1'])
  })
})

describe('lintQuery', () => {
  it('accepts an encoded query with an allowed date function', () => {
    expect(lintQuery('active=true^priority=1^opened_at>javascript:gs.daysAgoStart(7)')).toEqual([])
    expect(lintQuery('')).toEqual([])
  })
  it('accepts a named period written as literal dates, either way the model writes it', () => {
    // Seen live 2026-10-02: "SLAs met in June" became "last month" because the literal form was rejected. September was shown as June.
    expect(lintQuery('end_timeBETWEEN2026-06-01 00:00:00@2026-06-30 23:59:59')).toEqual([])
    expect(lintQuery("end_time>=javascript:gs.dateGenerate('2026-06-01','00:00:00')^end_time<javascript:gs.dateGenerate('2026-07-01','00:00:00')")).toEqual([])
    expect(lintQuery("end_time>=javascript:gs.dateGenerate('2026-06-01','00:00:00'); alert(1)").length).toBe(1)
  })
  it('names the problem in words', () => {
    expect(lintQuery('active=true AND priority=1')[0]!.issue).toContain('SQL-style')
    expect(lintQuery('state=New')[0]!.issue).toContain('label')
    expect(lintQuery('opened_at>javascript:gs.eval("x")')[0]!.issue).toContain('not an allowed date function')
    expect(lintQuery('this is not a query')[0]!.issue).toContain('not "field<operator>value"')
  })
})

describe('nameVariants', () => {
  it('drops filler words and shortens from the end', () => {
    // Seen live 2026-10-02: "network support" matched nothing; the group is "Network".
    expect(nameVariants('network support group')).toEqual(['network support group', 'network'])
    expect(nameVariants('Database Support Team')).toEqual(['Database Support Team', 'Database'])
    expect(nameVariants('South Africa')).toEqual(['South Africa', 'South'])
  })
})

describe('narrowing', () => {
  it('writes the phrase from the applied records, by kind', () => {
    expect(narrowPhrase('group', ['Network'])).toBe('for the Network group')
    expect(narrowPhrase('location', ['Cape Town', 'Johannesburg', 'South Africa'])).toBe('at Cape Town, Johannesburg, South Africa')
  })
  it('knows how each table reaches a reference, and refuses the ones it cannot', () => {
    expect(narrowField('task_sla', 'group')).toBe('task.assignment_group')
    expect(narrowField('incident', 'location')).toBe('location')
    expect(narrowField('alm_license', 'location')).toBeNull()
  })
  it('allows the base tables plus scanned ones, never the denied ones', () => {
    expect(tableAllowed('incident', null)).toBe(true)
    expect(tableAllowed('u_custom', new Set(['u_custom']))).toBe(true)
    expect(tableAllowed('u_custom', null)).toBe(false)
    expect(tableAllowed('sys_user_role', new Set(['sys_user_role']))).toBe(false)
  })
})

/** A ServiceNow that knows one table with two fields and counts 42 of anything. */
function fakeSn(): SnClient {
  return {
    instanceUrl: 'https://sn.example.com',
    async get<T>(raw: string): Promise<T> {
      const path = decodeURIComponent(raw.replace(/\+/g, ' '))
      if (path.includes('/stats/')) return { result: { stats: { count: '42' } } } as T
      if (path.includes('sys_db_object')) return { result: path.includes('name=incident') ? [{ name: 'incident', super_class: { value: '', display_value: '' } }] : [] } as T
      if (path.includes('sys_dictionary')) return { result: [
        { name: { value: 'incident', display_value: 'Incident' }, element: { value: 'active' }, column_label: { display_value: 'Active' }, internal_type: { value: 'boolean' }, reference: { value: '' } },
        { name: { value: 'incident', display_value: 'Incident' }, element: { value: 'priority' }, column_label: { display_value: 'Priority' }, internal_type: { value: 'integer' }, reference: { value: '' } },
      ] } as T
      if (path.includes('sys_user_group')) return { result: path.includes('name=Network') ? [{ sys_id: { value: 'a'.repeat(32) }, name: { display_value: 'Network' }, description: { display_value: '' }, type: { display_value: '' } }] : [] } as T
      if (path.includes('/table/incident')) return { result: [{ active: 'true', priority: '1' }] } as T
      return { result: [] } as T
    },
    async send<T>(): Promise<T> { throw new Error('read-only') },
  }
}

const ctxFor = (sn: SnClient): Omit<ToolContext, 'turn'> => ({ sn, scanned: null, openStates: '1,2,3' })

/** A model that follows a script: each entry is either tool calls or a final text. */
function scripted(steps: (string | { name: string; input: Record<string, unknown> }[])[]): AgentModel {
  let i = 0
  return {
    async step() {
      const s = steps[Math.min(i++, steps.length - 1)]!
      const content = (typeof s === 'string'
        ? [{ type: 'text', text: s, citations: null }]
        : s.map((t, k) => ({ type: 'tool_use', id: `tu${i}_${k}`, name: t.name, input: t.input }))) as unknown as Anthropic.ContentBlock[]
      return { id: 'm', type: 'message', role: 'assistant', model: 'test', content, stop_reason: typeof s === 'string' ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } as unknown as Anthropic.Message
    },
  }
}

describe('runAgent', () => {
  it('runs a tool, then accepts an answer whose figure the result contains', async () => {
    const model = scripted([[{ name: 'count', input: { table: 'incident', filter: 'active=true^priority=1', label: 'open P1 incidents' } }], 'There are 42 open P1 incidents [r1].'])
    const out = await runAgent(model, { question: 'how many open P1s', history: [], ctx: ctxFor(fakeSn()) })
    expect(out.kind).toBe('answer')
    if (out.kind === 'answer') { expect(out.cited.map((r) => r.id)).toEqual(['r1']); expect(out.results[0]!.url).toContain('incident_list.do') }
  })
  it('rejects a figure the cited result does not contain, after one retry', async () => {
    const model = scripted([[{ name: 'count', input: { table: 'incident', filter: 'active=true' } }], 'There are 43 open incidents [r1].', 'Still 43 [r1].'])
    const out = await runAgent(model, { question: 'q', history: [], ctx: ctxFor(fakeSn()) })
    expect(out.kind).toBe('ungrounded')
    if (out.kind === 'ungrounded') expect(out.missing).toEqual(['43'])
  })
  it('returns the tool error to the model instead of a number when the filter names an unknown field', async () => {
    const model = scripted([[{ name: 'count', input: { table: 'incident', filter: 'colour=blue' } }], 'I could not count that: the field does not exist.'])
    const out = await runAgent(model, { question: 'q', history: [], ctx: ctxFor(fakeSn()) })
    expect(out.kind).toBe('answer')
    if (out.kind === 'answer') { expect(out.results[0]!.data.error).toContain('does not exist'); expect(out.cited).toEqual([]) }
  })
  it('refuses a sys_id that no lookup returned this turn', async () => {
    const turn = makeTurn()
    const r = await executeTool('count', { table: 'incident', filter: `assignment_group=${'b'.repeat(32)}` }, { ...ctxFor(fakeSn()), turn })
    expect(r.error).toContain('not returned by resolve_reference')
  })
  it('stops with the question when the model asks the user', async () => {
    const model = scripted([[{ name: 'ask_user', input: { question: 'Which Network group: Network or Network Security?' } }]])
    const out = await runAgent(model, { question: 'q', history: [], ctx: ctxFor(fakeSn()) })
    expect(out.kind).toBe('clarify')
    if (out.kind === 'clarify') expect(out.text).toContain('Which Network group')
  })
  it('resolves a group exactly through its variants and remembers the sys_id for a narrowing', async () => {
    const turn = makeTurn()
    const ctx = { ...ctxFor(fakeSn()), turn }
    const r = await executeTool('resolve_reference', { kind: 'group', name: 'Network support group' }, ctx)
    expect(r.data.apply).toBe(true)
    expect(turn.resolved.get('a'.repeat(32))?.name).toBe('Network')
  })
})
