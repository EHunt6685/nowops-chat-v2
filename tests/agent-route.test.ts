import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { makeApp } from '../src/server.js'
import { parseConfig, type Config } from '../src/config.js'
import type { AgentModel } from '../src/llm/agent.js'
import type { SnClient } from '../src/servicenow/client.js'

const cfg: Config = parseConfig({
  ANTHROPIC_API_KEY: 'sk-test-key-1234567890', ANTHROPIC_BASE_URL: 'https://llmproxy.example.com', CLAUDE_MODEL: 'm',
  SN_INSTANCE_URL: 'https://sn.example.com', SN_CLIENT_ID: 'cid', SN_CLIENT_SECRET: 'csecret', SN_REFRESH_TOKEN: 'rtoken',
})

const snClient: SnClient = {
  instanceUrl: 'https://sn.example.com',
  async get<T>(raw: string): Promise<T> {
    const path = decodeURIComponent(raw.replace(/\+/g, ' '))
    if (path.includes('/stats/')) return { result: { stats: { count: '42' } } } as T
    if (path.includes('sys_db_object')) return { result: path.includes('name=incident') ? [{ name: 'incident', super_class: { value: '' } }] : [] } as T
    if (path.includes('sys_dictionary')) return { result: [{ name: { value: 'incident' }, element: { value: 'active' }, column_label: { display_value: 'Active' }, internal_type: { value: 'boolean' }, reference: { value: '' } }] } as T
    if (path.includes('/table/incident')) return { result: [{ active: 'true' }] } as T
    return { result: [] } as T
  },
  async send<T>(): Promise<T> { throw new Error('read-only') },
}
const sn = { health: async () => ({ ok: true, detail: 'reachable' }) }

function scripted(steps: (string | { name: string; input: Record<string, unknown> }[])[]): AgentModel {
  let i = 0
  return {
    async step() {
      const s = steps[Math.min(i++, steps.length - 1)]!
      const content = (typeof s === 'string' ? [{ type: 'text', text: s }] : s.map((t, k) => ({ type: 'tool_use', id: `tu${i}_${k}`, name: t.name, input: t.input }))) as unknown as Anthropic.ContentBlock[]
      return { content, stop_reason: typeof s === 'string' ? 'end_turn' : 'tool_use' } as unknown as Anthropic.Message
    },
  }
}

async function post(app: ReturnType<typeof makeApp>, body: unknown) {
  const server = app.listen(0)
  const addr = server.address(), port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  } finally { server.close() }
}

describe('POST /api/chat with the tool loop', () => {
  it('renders one cited count as the metric card, with the trace and Verify link', async () => {
    const agent = scripted([[{ name: 'count', input: { table: 'incident', filter: 'active=true', label: 'open incidents' } }], 'There are 42 open incidents [r1].'])
    const app = makeApp({ cfg, sn, agent, snClient })
    const r = await post(app, { message: 'how many open incidents are there', conversationId: 'a1' })
    expect(r.body.kind).toBe('metric')
    expect(r.body.answer).toBe('There are 42 open incidents.')
    const metric = r.body.metric as Record<string, unknown>
    expect(metric.value).toBe(42)
    expect(String(metric.url)).toContain('incident_list.do')
    expect((r.body.trace as unknown[]).length).toBe(1)
  })
  it('withholds an answer whose figure no result contains', async () => {
    const agent = scripted([[{ name: 'count', input: { table: 'incident', filter: 'active=true' } }], 'There are 43 open incidents [r1].'])
    const app = makeApp({ cfg, sn, agent, snClient })
    const r = await post(app, { message: 'how many open incidents are there', conversationId: 'a2' })
    expect(r.body.kind).toBe('decline')
    expect(r.body.gateReason).toBe('ungrounded')
  })
  it('returns a clarifying question as its own kind', async () => {
    const agent = scripted([[{ name: 'ask_user', input: { question: 'Which Network group do you mean?' } }]])
    const app = makeApp({ cfg, sn, agent, snClient })
    const r = await post(app, { message: 'breached SLAs for the network group', conversationId: 'a3' })
    expect(r.body.kind).toBe('clarify')
    expect(r.body.answer).toContain('Which Network group')
  })
  it('shows an uncited explanation as a decline, keeping the model\'s own words', async () => {
    const agent = scripted(['I answer only about this ServiceNow instance, so I cannot help with the weather.'])
    const app = makeApp({ cfg, sn, agent, snClient })
    const r = await post(app, { message: 'what is the weather in Pune', conversationId: 'a4' })
    expect(r.body.kind).toBe('decline')
    expect(r.body.gateReason).toBe('model_declined')
    expect(String(r.body.answer)).toContain('weather')
  })
})
