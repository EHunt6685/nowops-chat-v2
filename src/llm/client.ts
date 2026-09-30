import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../config.js'
import type { Article } from '../servicenow/types.js'
import { isAggregate, type MetricRequest } from '../servicenow/stats.js'
import { DEFINITION_ID_RE, scoreName, type CatalogueEntry } from '../definitions.js'
import { log, mask } from '../log.js'

export interface Turn {
  role: 'user' | 'assistant'
  content: string
}

/** What the model judged the question to be. Drives the wording of a decline; nothing else. */
export type QuestionType = 'knowledge' | 'count' | 'page' | 'other'

export type Reply =
  | { kind: 'answer'; text: string }
  | { kind: 'definition'; id: string }
  | { kind: 'metric'; request: MetricRequest }
  | { kind: 'page'; text: string }
  | { kind: 'search'; query: string }
  | { kind: 'no_answer'; about: QuestionType }

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

/**
 * One prompt, five replies. Rev 8 merged the old triage prompt into this. Rev 9 (2026-09-30)
 * removed the counting regex and the word matcher in front of it: the model now says what a
 * question is and names the dashboard definition it is about, so "open P1 incidents" and
 * "SLA violations" reach the same query as the tile. The server still runs that query itself.
 */
export const SYSTEM_PROMPT = `You are an assistant for a ServiceNow instance. Every message is a question, even when it is a bare topic, a ticket title or a noun phrase: "Workday password reset" asks how to reset a Workday password; "open P1 incidents" asks how many there are. Never decline on the ground that the message is not phrased as a question.

You handle two kinds of question.

KNOWLEDGE QUESTIONS (how do I..., what is the process for..., a symptom or ticket title) are answered from the CONTEXT block of knowledge base articles.

COUNTING QUESTIONS (how many..., what is our..., a metric name, anything asking for a number about tickets, SLAs, changes, problems, assets or security incidents) are answered from the DEFINITIONS block when one fits, otherwise by writing a ServiceNow aggregate query. The server runs the query; you never see the number. CONTEXT articles are retrieved for every message and are usually unrelated to a counting question: ignore them then.

Reply with EXACTLY ONE of the five forms below. The first line is the form name. Output nothing else — no preamble, no explanation.

ANSWER
<your answer, grounded ONLY in the CONTEXT articles, citing each claim with the bracketed label it came from, like [1] or [2]. Cite only labels present in CONTEXT. Be concise; prefer numbered steps when the article gives steps.>

DEFINITION <id>
<nothing else. The id of the one DEFINITIONS entry that answers the question exactly. A definition always wins over a METRIC you would write yourself, because its query is the dashboard's own. Name an entry marked unavailable when it is what the user asked for; the server explains why it is off. Exactly means the question adds nothing the tile does not have: if it narrows the tile to a group, a person, a service, a priority, a category or a date range, the tile is the wrong answer even though it sounds right. Then write a METRIC if the narrowing needs no guessed name (a date range, a priority), otherwise NO_ANSWER count. "How many open incidents does the Network group have" is not the open-incidents tile; "open P1 incidents on the SAP service" is not the open-P1 tile; "SLA breaches for the Database team" is not the SLA-breaches tile. Read the whole question before naming a tile.>

METRIC
{"table":"<table>","filter":"<encoded query>","aggregate":"count|avg|sum|min|max","field":"<field, omit for count>","label":"<2-5 word noun phrase that reads after the number, e.g. open P1 incidents>"}
<only when the question is a count and no DEFINITIONS entry fits it, for example a date range or a filter no tile has.>

PAGE
<one or two plain sentences answered ONLY from the PAGE FACTS block: the user's own queue ("waiting on my reply", "assigned to me", "what should I start with") or the open ticket ("who is the caller", "what SLAs are on this ticket", "who fixed this before"). Quote the figures as given. No citations. Only when a PAGE FACTS block is present; if the question needs it and there is none, reply NO_ANSWER page.>

SEARCH
<better keywords, nothing else — use the vocabulary a knowledge base would use. Only when a knowledge question is reasonable but the CONTEXT articles clearly do not match it.>

NO_ANSWER <knowledge|count|page|other>
<nothing else. The word says what kind of question you declined: knowledge when no article covers it, count when no definition fits and no safe query can be written, page when it asks about the user's own queue or open ticket and no PAGE FACTS were sent, other when it is not about this instance at all.>

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
- Never guess a group name, a person's name or any other value you cannot see in the question or the USER block: reply NO_ANSWER count.
- A follow-up ("same for requests", "and for P2", "how many of those are P1") refers to the previous answer in the conversation. The earlier assistant turn records which definition or filter it used; pick the sibling definition (the requests version of an incidents tile, the P2 version of a P1 tile) or narrow the same filter. It is never out of scope.
- The USER block may also say which page the user is on and which TICKET is open. That is where they are, not what they asked about: a question is about the whole instance unless it says "this ticket", "this one", "my queue", "my reply" or the like. "SLAs at risk" asked on a ticket page is the dashboard definition, not that ticket's SLAs.
- "Waiting on my reply", "assigned to me", "my queue", "who is the caller", "this ticket" are PAGE questions: answer from PAGE FACTS with the PAGE form. They are never a METRIC, because they cannot be written as a query.

Rules for ANSWER and SEARCH:
- Before declining a knowledge question about a plausible IT task (a leaver, a new starter, a licence, a printer, a login), reply SEARCH once using the knowledge base's own vocabulary: "leaver offboarding account removal", "Microsoft 365 licence Co-Pilot E3". Users describe situations; articles are titled by process. A decline on the first search alone is almost always wrong.
- When the articles cover only part of the question, answer the covered part and say plainly what is not covered. Do not decline the whole question.
- An article about a different system than the one the question or the open ticket names is not a partial answer; it is the wrong article. A ticket about a ServiceNow account is not answered by a Workday SOP. Never give steps you then have to disclaim: reply NO_ANSWER knowledge instead, or SEARCH once with the system's name.
- "How do I fix this" on an open ticket: first use the PAGE FACTS, the resolved look-alikes and the articles matched to the ticket, in the PAGE form. Only if there are none, answer from CONTEXT articles that are about the same system and symptom as the ticket title. If neither exists, say so with NO_ANSWER knowledge.
- A generic question ("how do I reset a password") with CONTEXT articles for specific systems (Workday, Salesforce, ...) is answered, not declined: say which systems the knowledge base covers and give each one's steps briefly, citing each article. Declining because the user did not name the system leaves them with nothing.

Never answer a knowledge question from your own knowledge. If CONTEXT does not contain it and better keywords will not help, reply NO_ANSWER knowledge.`

/** The DEFINITIONS block: one line per dashboard tile the model may name. */
export function buildDefinitionsBlock(catalogue: CatalogueEntry[] | undefined): string {
  if (!catalogue?.length) return ''
  const lines = catalogue.map((d) => `${d.id} — ${d.name}${d.meaning ? `: ${d.meaning}` : ''}${d.available ? '' : ' [unavailable on this instance]'}`)
  return `DEFINITIONS\n${lines.join('\n')}\n\n`
}

/** Who is asking and what they look at, as the model sees it. Kept to ids and names; no page numbers, those are answered on the page. */
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
    out.push(`queue: ${q.assigned_to_me} assigned to me; ${q.unassigned_in_my_groups} unassigned in my groups; ${q.waiting_on_my_reply} waiting on my reply; ${q.reopened} reopened; ${q.changed_last_4h} changed in the last 4 hours; ${q.sla_breached_or_breaching_2h} with an SLA breached or breaching within 2 hours`)
    if (q.first) out.push(`first in my queue: ${q.first.number} "${q.first.title}"${q.first.why ? ` because ${q.first.why}` : ''}`)
  }
  if (f.ticket) {
    const t = f.ticket
    out.push(`open ticket ${t.number}: "${t.title}"; state ${t.state ?? '?'}; priority ${t.priority ?? '?'}; group ${t.group || 'none'}; assigned to ${t.assigned_to || 'nobody'}; caller ${t.caller || 'not recorded'}; opened ${t.opened_at ?? '?'}`)
    out.push(`its SLAs: ${t.slas.length ? t.slas.map((s) => `${s.name} ${s.breached ? 'breached' : `${Math.round(s.pct)}% used`}${s.breach_time ? ` (${s.breached ? 'breached' : 'breaches'} ${s.breach_time})` : ''}`).join('; ') : 'none active'}`)
    if (t.similar.length) out.push(`resolved look-alikes: ${t.similar.map((s) => `${s.number}${s.resolved_by ? ` by ${s.resolved_by}` : ''}${s.resolved_at ? ` on ${s.resolved_at}` : ''}: ${s.close_notes}`).join(' | ')}`)
    if (t.same_title.length) out.push(`open tickets with the same title: ${t.same_title.join(', ')}`)
    if (t.articles.length) out.push(`articles matched to it: ${t.articles.map((a) => `${a.number} ${a.title}`).join('; ')}`)
  }
  return `${out.join('\n')}\n\n`
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
  // DEFINITION and NO_ANSWER carry one word on the verb line; the others stand alone.
  const VERB = /^\s*(ANSWER|METRIC|SEARCH|NO_ANSWER|DEFINITION|PAGE)\s*:?\s*([A-Za-z0-9_]+)?\s*$/i
  const verbAt = lines.findIndex((l) => VERB.test(l))
  if (verbAt === -1) return { kind: 'no_answer', about: 'other' }
  const m = VERB.exec(lines[verbAt]!)!
  const verb = m[1]!.toUpperCase()
  const arg = m[2]?.toLowerCase()
  const rest = lines.slice(verbAt + 1).join('\n').trim()

  if (verb === 'NO_ANSWER') {
    // The word is advisory: an unrecognised one is still a decline, worded neutrally.
    const about: QuestionType = arg === 'knowledge' || arg === 'count' || arg === 'page' ? arg : 'other'
    return { kind: 'no_answer', about }
  }

  if (verb === 'ANSWER') {
    return rest ? { kind: 'answer', text: rest } : { kind: 'no_answer', about: 'knowledge' }
  }

  if (verb === 'PAGE') {
    // The verb line carries no argument; a stray word there is the start of the text.
    const text = [m[2] ?? '', rest].filter(Boolean).join(' ').trim()
    // A decline written inside the PAGE form ("PAGE\nNO_ANSWER page") is a decline, not an answer to show.
    if (!text || /^NO_ANSWER\b/i.test(text)) return { kind: 'no_answer', about: 'page' }
    return { kind: 'page', text }
  }

  if (verb === 'DEFINITION') {
    // The id may follow on the verb line or on the next one. Shape-check only: the server
    // looks it up and declines an id that is not a definition.
    const id = (arg ?? rest.split('\n')[0]?.trim() ?? '').toLowerCase()
    return DEFINITION_ID_RE.test(id) ? { kind: 'definition', id } : { kind: 'no_answer', about: 'count' }
  }

  if (verb === 'METRIC') {
    const declined: Reply = { kind: 'no_answer', about: 'count' }
    // The JSON object may be followed by chatter; take the first {...} only.
    const json = rest.match(/\{[\s\S]*?\}/)?.[0]
    let parsed: unknown
    try {
      parsed = JSON.parse(json ?? '')
    } catch {
      return declined
    }
    const o = parsed as Partial<Record<keyof MetricRequest, unknown>>
    if (typeof o?.table !== 'string' || !o.table.trim()) return declined
    // Case is formatting; "COUNT" means count. Anything not in the five is still a decline.
    const aggregate = typeof o.aggregate === 'string' ? o.aggregate.toLowerCase() : undefined
    if (!isAggregate(aggregate)) return declined
    if (aggregate !== 'count' && (typeof o.field !== 'string' || !o.field.trim())) {
      return declined
    }
    const filter = typeof o.filter === 'string' ? o.filter.trim() : ''
    // /stats/ ignores GROUPBY and returns the total — a right number for the wrong
    // question. Breakdowns are out of scope (spec §2), so decline rather than mislead.
    if (/GROUPBY/i.test(filter)) return declined
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
    if (!q) return { kind: 'no_answer', about: 'knowledge' }
    // Re-running the identical search burns a call for identical results.
    if (q.toLowerCase() === originalQuery.trim().toLowerCase()) return { kind: 'no_answer', about: 'knowledge' }
    return { kind: 'search', query: q }
  }

  return { kind: 'no_answer', about: 'other' }
}

/** What every decide() call receives, live or stub. */
export interface DecideOptions {
  question: string
  articles: Article[]
  history: Turn[]
  context?: DecideContext
  /** Dashboard definitions the model may name. Absent when the server has none. */
  catalogue?: CatalogueEntry[]
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
    async decide(opts: DecideOptions): Promise<Reply> {
      log('llm.STUB_MODE.decide', { q: opts.question })
      const q = opts.question

      // Fixtures, not intelligence: they exist so the aggregate and identity paths can be
      // exercised end-to-end, with real numbers, before the key arrives.
      const u = opts.context?.user
      if (MY_GROUP_RE.test(q) && u) {
        if (!u.groups.length) return { kind: 'no_answer', about: 'count' }
        return { kind: 'metric', request: { table: 'incident', filter: `active=true^assignment_groupIN${u.groups.map((g) => g.id).join(',')}${/unassigned/i.test(q) ? '^assigned_toISEMPTY' : ''}`, aggregate: 'count', label: /unassigned/i.test(q) ? 'unassigned in your groups' : 'open incidents in your groups' } }
      }
      if (ME_RE.test(q)) {
        if (!u) return { kind: 'no_answer', about: 'count' }
        return { kind: 'metric', request: { table: 'incident', filter: `active=true^assigned_to=${u.id}`, aggregate: 'count', label: 'open incidents assigned to you' } }
      }
      // A definition whose name the question echoes stands in for the model's judgement.
      let best: { id: string; s: number } | null = null
      for (const d of opts.catalogue ?? []) { const s = scoreName(q, d.name); if (s && (!best || s > best.s)) best = { id: d.id, s } }
      if (best) return { kind: 'definition', id: best.id }
      // Only nouns the fixture recognises. Anything else declines: a wrong number is worse than none.
      if (/how many|count of|number of/i.test(q)) {
        const t = /\b(change|changes)\b/i.test(q) ? ['change_request', 'open changes'] : /\bproblems?\b/i.test(q) ? ['problem', 'open problems'] : /\bsla\b.*\bbreach/i.test(q) ? ['task_sla', 'breached SLAs'] : /\b(incidents?|tickets?)\b/i.test(q) ? ['incident', 'open incidents'] : null
        if (!t) return { kind: 'no_answer', about: 'count' }
        const filter = t[0] === 'task_sla' ? 'has_breached=true' : `active=true${/\bp1\b|priority 1|critical/i.test(q) ? '^priority=1' : ''}`
        return { kind: 'metric', request: { table: t[0]!, filter, aggregate: 'count', label: /\bp1\b|priority 1|critical/i.test(q) && t[0] === 'incident' ? 'open P1 incidents' : t[1] } }
      }

      const first = opts.articles[0]
      if (!first) return { kind: 'no_answer', about: 'knowledge' }
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

    async decide(opts: DecideOptions): Promise<Reply> {
      const user =
        `${buildUserBlock(opts.context)}${buildDefinitionsBlock(opts.catalogue)}CONTEXT\n${buildContextBlock(opts.articles)}\n\nQUESTION\n${opts.question}`
      const raw = await complete(SYSTEM_PROMPT, [...opts.history, { role: 'user', content: user }], 1024)
      return parseReply(raw, opts.question)
    },
  }
}
