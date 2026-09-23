import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../config.js'
import type { Article } from '../servicenow/types.js'
import { isAggregate, type MetricRequest } from '../servicenow/stats.js'
import { log, mask } from '../log.js'

export interface Turn {
  role: 'user' | 'assistant'
  content: string
}

export type Reply =
  | { kind: 'answer'; text: string }
  | { kind: 'metric'; request: MetricRequest }
  | { kind: 'search'; query: string }
  | { kind: 'no_answer' }

/**
 * One prompt, four replies (D16). Rev 8 merged the old triage prompt into this —
 * with D13 in place the coverage floor only chose which prompt to send, so the
 * two prompts became one for the same number of model calls.
 */
export const SYSTEM_PROMPT = `You are an assistant for a ServiceNow instance. You handle two kinds of question.

KNOWLEDGE QUESTIONS ("how do I...", "what is the process for...") are answered from the CONTEXT block of knowledge base articles.

COUNTING QUESTIONS ("how many...", "what is our...", anything asking for a number about tickets, SLAs, changes, problems, assets or security incidents) are answered by writing a ServiceNow aggregate query, which the server runs.

Reply with EXACTLY ONE of the four forms below. The first line is the form name, alone. Output nothing else — no preamble, no explanation.

ANSWER
<your answer, grounded ONLY in the CONTEXT articles, citing each claim with the bracketed label it came from, like [1] or [2]. Cite only labels present in CONTEXT. Be concise; prefer numbered steps when the article gives steps.>

METRIC
{"table":"<table>","filter":"<encoded query>","aggregate":"count|avg|sum|min|max","field":"<field, omit for count>","label":"<2-5 word noun phrase that reads after the number, e.g. open P1 incidents>"}

SEARCH
<better keywords, nothing else — use the vocabulary a knowledge base would use. Only when the question is reasonable but the CONTEXT articles clearly do not match it.>

NO_ANSWER

Rules for METRIC:
- "filter" is a ServiceNow encoded query: clauses joined by ^, e.g. active=true^priority=1
- Open/active tickets are active=true. Priorities are priority=1..5. Incident states: 1 New, 2 In Progress, 3 On Hold, 6 Resolved, 7 Closed, 8 Cancelled. Be careful: "closed" usually means both 6 and 7, so use stateIN6,7 unless the user clearly means only one. On this instance Resolved incidents are still active=true; if the user says "unresolved", "still open" or "not yet resolved", use active=true^stateIN1,2,3.
- Only use fields you are confident exist on that table. A filter with an unknown field is rejected by the server and the question is declined — it is never silently ignored.
- "Tickets" means incidents (table incident) unless the user names requests (sc_req_item), changes (change_request) or problems (problem). "All" or "total" means no active filter; only add active=true when the user says open, active, current or outstanding.
- Breached SLAs are task_sla with has_breached=true. Security incidents are sn_si_incident.
- Breakdowns ("by priority", "per group", "trend over time") are not supported: reply NO_ANSWER rather than returning a single total.
- Relative dates use ServiceNow javascript functions, e.g. opened_at<javascript:gs.daysAgoStart(30)
- Never invent a table or field you are not confident exists. Prefer NO_ANSWER.
- If the data plainly does not exist in ServiceNow (uptime, latency, synthetic checks, anything from a monitoring tool), reply NO_ANSWER.
- A USER block, when present, names the person asking with their sys_id and groups. "me", "my", "mine", "I" refer to that person: assigned_to=<user sys_id>; "my group" or "my team" is assignment_groupIN<group sys_ids>. "this ticket" is the TICKET number given. Without a USER block those words cannot be resolved: reply NO_ANSWER rather than counting everyone.

Never answer a knowledge question from your own knowledge. If CONTEXT does not contain it and better keywords will not help, reply NO_ANSWER.`

/** Who is asking and what they look at, as the model sees it. Kept to ids and names; no page numbers, those are answered on the page. */
export interface DecideContext {
  user?: { id: string; name: string; groups: { id: string; name: string }[] }
  page?: string
  ticket?: string
}
export function buildUserBlock(c?: DecideContext): string {
  if (!c) return ''
  const lines: string[] = []
  if (c.user) lines.push(`name: ${c.user.name}`, `sys_id: ${c.user.id}`, `groups: ${c.user.groups.map((g) => `${g.name} (${g.id})`).join(', ') || 'none'}`)
  if (c.ticket) lines.push(`TICKET: ${c.ticket}`)
  if (c.page) lines.push(`page: ${c.page}`)
  return lines.length ? `USER\n${lines.join('\n')}\n\n` : ''
}
const ME_RE = /\b(assigned to me|my (open )?(tickets|incidents|queue|work)|mine)\b/i
const MY_GROUP_RE = /\bmy (group|groups|team)\b/i

/** Articles are labelled [1]..[n]. The model cites labels, never sys_ids or KB numbers (D10). */
export function buildContextBlock(articles: Article[]): string {
  if (articles.length === 0) return '(no articles matched)'
  return articles.map((a, i) => `[${i + 1}] ${a.title}\n${a.body}`).join('\n\n---\n\n')
}

export function parseCitations(answer: string): number[] {
  return [...new Set([...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])))]
}

/** Intersects cited labels with those actually supplied. Anything else is fabricated. */
export function verifyCitations(
  cited: number[],
  supplied: Article[],
): { sources: Article[]; fabricated: number[] } {
  const sources: Article[] = []
  const fabricated: number[] = []
  for (const label of cited) {
    const a = supplied[label - 1]
    if (a) sources.push(a)
    else fabricated.push(label)
  }
  return { sources, fabricated }
}

/** Removes bracketed labels once sources are rendered separately. */
export function stripCitationMarkup(answer: string): string {
  return answer.replace(/\s*\[\d{1,2}\]/g, '').replace(/\s{2,}/g, ' ').trim()
}

/**
 * Interprets the model's reply. Anything unrecognised, malformed or useless
 * becomes NO_ANSWER — the same discipline as stripping a fabricated citation.
 * This function never repairs; it only accepts or declines.
 */
export function parseReply(raw: string, originalQuery: string): Reply {
  // Models add preambles, colons and code fences even when told not to. Those are
  // formatting noise, not a different intent: find the verb line wherever it is,
  // and drop fence markers. Nothing here changes what the model asked for.
  const lines = raw.replace(/```[a-z]*/gi, '').trim().split('\n')
  const verbAt = lines.findIndex((l) => /^\s*(ANSWER|METRIC|SEARCH|NO_ANSWER)\s*:?\s*$/i.test(l))
  if (verbAt === -1) return { kind: 'no_answer' }
  const verb = lines[verbAt]!.trim().replace(/:$/, '').toUpperCase()
  const rest = lines.slice(verbAt + 1).join('\n').trim()

  if (verb === 'ANSWER') {
    return rest ? { kind: 'answer', text: rest } : { kind: 'no_answer' }
  }

  if (verb === 'METRIC') {
    // The JSON object may be followed by chatter; take the first {...} only.
    const json = rest.match(/\{[\s\S]*?\}/)?.[0]
    let parsed: unknown
    try {
      parsed = JSON.parse(json ?? '')
    } catch {
      return { kind: 'no_answer' }
    }
    const o = parsed as Partial<Record<keyof MetricRequest, unknown>>
    if (typeof o?.table !== 'string' || !o.table.trim()) return { kind: 'no_answer' }
    // Case is formatting; "COUNT" means count. Anything not in the five is still a decline.
    const aggregate = typeof o.aggregate === 'string' ? o.aggregate.toLowerCase() : undefined
    if (!isAggregate(aggregate)) return { kind: 'no_answer' }
    if (aggregate !== 'count' && (typeof o.field !== 'string' || !o.field.trim())) {
      return { kind: 'no_answer' }
    }
    const filter = typeof o.filter === 'string' ? o.filter.trim() : ''
    // /stats/ ignores GROUPBY and returns the total — a right number for the wrong
    // question. Breakdowns are out of scope (spec §2), so decline rather than mislead.
    if (/GROUPBY/i.test(filter)) return { kind: 'no_answer' }
    return {
      kind: 'metric',
      request: {
        table: o.table.trim(),
        filter,
        aggregate,
        ...(typeof o.field === 'string' && o.field.trim() ? { field: o.field.trim() } : {}),
        ...(typeof o.label === 'string' && o.label.trim() ? { label: o.label.trim() } : {}),
      },
    }
  }

  if (verb === 'SEARCH') {
    const q = rest.replace(/^["'`]+|["'`]+$/g, '').trim()
    if (!q) return { kind: 'no_answer' }
    // Re-running the identical search burns a call for identical results.
    if (q.toLowerCase() === originalQuery.trim().toLowerCase()) return { kind: 'no_answer' }
    return { kind: 'search', query: q }
  }

  return { kind: 'no_answer' }
}

/**
 * Stand-in for the gateway, used only when LLM_MODE=stub — for building and
 * exercising the whole app before the Key Vault secret is available.
 *
 * It must be loud and obviously fake. Shipping with this enabled unnoticed
 * would be far worse than not booting at all.
 */
export function makeStubLlm() {
  return {
    async preflight(): Promise<void> {
      log('llm.STUB_MODE', { warning: 'No real model. Answers are canned. Do not demo as real.' })
    },

    /** No model in stub mode: callers fall back to their rule-based text. */
    async draft(_system: string, _user: string): Promise<string | null> {
      return null
    },

    // Same signature as the live client so makeLlm returns one shape; history is unused here.
    async decide(opts: { question: string; articles: Article[]; history: Turn[]; context?: DecideContext }): Promise<Reply> {
      log('llm.STUB_MODE.decide', { q: opts.question })
      const q = opts.question

      // Fixtures, not intelligence: they exist so the aggregate and identity paths can be
      // exercised end-to-end, with real numbers, before the key arrives.
      const u = opts.context?.user
      if (MY_GROUP_RE.test(q) && u) {
        if (!u.groups.length) return { kind: 'no_answer' }
        return { kind: 'metric', request: { table: 'incident', filter: `active=true^assignment_groupIN${u.groups.map((g) => g.id).join(',')}${/unassigned/i.test(q) ? '^assigned_toISEMPTY' : ''}`, aggregate: 'count', label: /unassigned/i.test(q) ? 'unassigned in your groups' : 'open incidents in your groups' } }
      }
      if (ME_RE.test(q)) {
        if (!u) return { kind: 'no_answer' }
        return { kind: 'metric', request: { table: 'incident', filter: `active=true^assigned_to=${u.id}`, aggregate: 'count', label: 'open incidents assigned to you' } }
      }
      if (/how many|count of|number of/i.test(q)) {
        const t = /\b(change|changes)\b/i.test(q) ? ['change_request', 'open changes'] : /\bproblems?\b/i.test(q) ? ['problem', 'open problems'] : /\bsla\b.*\bbreach/i.test(q) ? ['task_sla', 'breached SLAs'] : ['incident', 'open incidents']
        const filter = t[0] === 'task_sla' ? 'has_breached=true' : `active=true${/\bp1\b|priority 1|critical/i.test(q) ? '^priority=1' : ''}`
        return { kind: 'metric', request: { table: t[0]!, filter, aggregate: 'count', label: /\bp1\b|priority 1|critical/i.test(q) && t[0] === 'incident' ? 'open P1 incidents' : t[1] } }
      }

      const first = opts.articles[0]
      if (!first) return { kind: 'no_answer' }
      return {
        kind: 'answer',
        text:
          `[STUB — no live model] The knowledge base article that matches this is ` +
          `"${first.title}". Its content begins: ${first.body.slice(0, 200)} [1]`,
      }
    },
  }
}

export function makeLlm(cfg: Config) {
  if (cfg.llmMode === 'stub') return makeStubLlm()

  // Two env vars, standard SDK, no wrapper (nowstudio-reference §1).
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey, baseURL: cfg.anthropicBaseUrl })

  async function complete(system: string, messages: Turn[], maxTokens: number): Promise<string> {
    const res = await client.messages.create({
      model: cfg.claudeModel,
      max_tokens: maxTokens,
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
     * One cheap call against the configured model id. The gateway renames models,
     * and a wrong id yields a silent wrong answer rather than an error — so this
     * must fail the boot, loudly (spec §7 rule 2).
     */
    async preflight(): Promise<void> {
      try {
        await client.messages.create({
          model: cfg.claudeModel,
          max_tokens: 4,
          messages: [{ role: 'user', content: 'ping' }],
        })
        log('llm.preflight.ok', { model: cfg.claudeModel, baseUrl: cfg.anthropicBaseUrl })
      } catch (e) {
        throw new Error(
          `Gateway preflight failed for model '${cfg.claudeModel}' at ${cfg.anthropicBaseUrl} ` +
            `(key ${mask(cfg.anthropicApiKey)}). The gateway renames model ids — check the exact ` +
            `id with the platform team. Cause: ${e instanceof Error ? e.message : String(e)}`,
        )
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

    async decide(opts: {
      question: string
      articles: Article[]
      history: Turn[]
      context?: DecideContext
    }): Promise<Reply> {
      const user =
        `${buildUserBlock(opts.context)}CONTEXT\n${buildContextBlock(opts.articles)}\n\nQUESTION\n${opts.question}`
      const raw = await complete(SYSTEM_PROMPT, [...opts.history, { role: 'user', content: user }], 1024)
      return parseReply(raw, opts.question)
    },
  }
}
