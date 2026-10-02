import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../config.js'
import { log, mask } from '../log.js'

export interface Turn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * What the Resolve page has already loaded under the user's session: the queue counts and the open
 * ticket. Sent with the question so "how many are waiting on my reply" is answered by the model from
 * these facts, labelled as such. They are as trustworthy as the page, and never a live query.
 */
export interface PageFacts {
  loadedAt?: string
  queue?: {
    assigned_to_me: number; unassigned_in_my_groups: number; waiting_on_my_reply: number
    reopened: number; changed_last_4h: number; sla_breached_or_breaching_2h: number
    first?: { number: string; title: string; why?: string }
  }
  ticket?: {
    number: string; title: string; state?: string; priority?: string; group?: string; assigned_to?: string
    caller?: string; opened_at?: string
    slas: { name: string; breached: boolean; pct: number; breach_time?: string }[]
    similar: { number: string; resolved_at?: string; resolved_by?: string; close_notes: string }[]
    same_title: string[]
    articles: { number: string; title: string }[]
  }
}

/** Who is asking and what they look at, as the model sees it. Kept to ids and names. */
export interface DecideContext {
  user?: { id: string; name: string; groups: { id: string; name: string }[] }
  page?: string
  ticket?: string
  facts?: PageFacts
}

export function buildUserBlock(c?: DecideContext): string {
  if (!c) return ''
  const lines: string[] = []
  if (c.user) lines.push(`name: ${c.user.name}`, `sys_id: ${c.user.id}`, `groups: ${c.user.groups.map((g) => `${g.name} (${g.id})`).join(', ') || 'none'}`)
  if (c.ticket) lines.push(`TICKET: ${c.ticket}`)
  if (c.page) lines.push(`page: ${c.page}`)
  const user = lines.length ? `USER\n${lines.join('\n')}\n\n` : ''
  return user + buildFactsBlock(c.facts)
}

/** The PAGE FACTS block: what the user's page has loaded, in plain lines the model can quote. */
export function buildFactsBlock(f?: PageFacts): string {
  if (!f || (!f.queue && !f.ticket)) return ''
  const when = f.loadedAt ? new Date(f.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'unknown time'
  const out: string[] = [`PAGE FACTS (loaded by the user's page at ${when}; computed by the page, not a live query)`]
  if (f.queue) {
    const q = f.queue
    out.push(`queue: ${q.assigned_to_me} assigned to me; ${q.unassigned_in_my_groups} unassigned in my groups; ${q.waiting_on_my_reply} waiting on my reply; ${q.reopened} reopened; ${q.changed_last_4h} changed in the last 4 hours; ${q.sla_breached_or_breaching_2h} SLAs breached or breaching within 2 hours`)
    if (q.first) out.push(`first in my queue: ${q.first.number} "${q.first.title}"${q.first.why ? ` because ${q.first.why}` : ''}`)
  }
  if (f.ticket) {
    const t = f.ticket
    out.push(`open ticket ${t.number}: "${t.title}"; state ${t.state ?? '?'}; priority ${t.priority ?? '?'}; group ${t.group || 'none'}; assigned to ${t.assigned_to || 'nobody'}; caller ${t.caller || 'unknown'}${t.opened_at ? `; opened ${t.opened_at}` : ''}`)
    out.push(`its SLAs: ${t.slas.length ? t.slas.map((s) => `${s.name} ${s.breached ? 'breached' : `${Math.round(s.pct)}% used`}${s.breach_time ? ` (${s.breached ? 'breached' : 'breaches'} ${s.breach_time})` : ''}`).join('; ') : 'none'}`)
    if (t.similar.length) out.push(`resolved look-alikes: ${t.similar.map((s) => `${s.number}${s.resolved_by ? ` by ${s.resolved_by}` : ''}${s.resolved_at ? ` on ${s.resolved_at}` : ''}: ${s.close_notes || '(no close notes)'}`).join(' | ')}`)
    if (t.same_title.length) out.push(`open tickets with the same title: ${t.same_title.join(', ')}`)
    if (t.articles.length) out.push(`articles matched to it: ${t.articles.map((a) => `${a.number} ${a.title}`).join('; ')}`)
  }
  return `${out.join('\n')}\n\n`
}

/**
 * The plain-completion client: a boot-time preflight and the draft call Resolve uses for its
 * briefs and drafts. The chatbot itself runs through the tool loop in agent.ts.
 */
export function makeLlm(cfg: Config) {
  // Two env vars, standard SDK, no wrapper (nowstudio-reference §1).
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey, baseURL: cfg.anthropicBaseUrl })

  async function complete(system: string, messages: Turn[], maxTokens: number): Promise<string> {
    const res = await client.messages.create({
      model: cfg.claudeModel,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    })
    return res.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim()
  }

  return {
    /**
     * One cheap call against the configured model id. The gateway renames models, and a wrong id
     * yields a silent wrong answer rather than an error, so the check names the id and the gateway.
     * Reported, never fatal: the dashboard and Resolve run without the model; chat says it is down.
     */
    async health(): Promise<{ ok: boolean; detail?: string }> {
      try {
        await client.messages.create({
          model: cfg.claudeModel,
          max_tokens: 4,
          messages: [{ role: 'user', content: 'ping' }],
        })
        log('llm.preflight.ok', { model: cfg.claudeModel, baseUrl: cfg.anthropicBaseUrl })
        return { ok: true, detail: `${cfg.claudeModel} reachable` }
      } catch (e) {
        return {
          ok: false,
          detail: `Model '${cfg.claudeModel}' at ${cfg.anthropicBaseUrl} did not answer (key ${mask(cfg.anthropicApiKey)}). ` +
            `The gateway renames model ids; check the exact id with the platform team. Cause: ${e instanceof Error ? e.message : String(e)}`,
        }
      }
    },

    /**
     * Plain completion for Resolve's drafts (steps, close note, article, message). The
     * caller supplies every fact in `user`; the model only arranges it. Returns null on
     * any failure so the caller can fall back to its rule-based text instead of erroring.
     */
    async draft(system: string, user: string): Promise<string | null> {
      try {
        return await complete(system, [{ role: 'user', content: user }], 1200)
      } catch (e) {
        log('llm.draft.failed', { detail: e instanceof Error ? e.message : String(e) })
        return null
      }
    },
  }
}
