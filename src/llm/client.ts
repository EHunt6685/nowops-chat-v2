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
- Open/active tickets are active=true. Priorities are priority=1..5. Incident states: 1 New, 2 In Progress, 3 On Hold, 6 Resolved, 7 Closed, 8 Cancelled. Be careful: "closed" usually means both 6 and 7, so use stateIN6,7 unless the user clearly means only one.
- "Tickets" means incidents (table incident) unless the user names requests (sc_req_item), changes (change_request) or problems (problem). "All" or "total" means no active filter; only add active=true when the user says open, active, current or outstanding.
- Breached SLAs are task_sla with has_breached=true. Security incidents are sn_si_incident.
- Breakdowns ("by priority", "per group", "trend over time") are not supported: reply NO_ANSWER rather than returning a single total.
- Relative dates use ServiceNow javascript functions, e.g. opened_at<javascript:gs.daysAgoStart(30)
- Never invent a table or field you are not confident exists. Prefer NO_ANSWER.
- If the data plainly does not exist in ServiceNow (uptime, latency, synthetic checks, anything from a monitoring tool), reply NO_ANSWER.

Never answer a knowledge question from your own knowledge. If CONTEXT does not contain it and better keywords will not help, reply NO_ANSWER.`

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

    // Same signature as the live client so makeLlm returns one shape; history is unused here.
    async decide(opts: { question: string; articles: Article[]; history: Turn[] }): Promise<Reply> {
      log('llm.STUB_MODE.decide', { q: opts.question })

      // A fixture, not intelligence: it exists so the aggregate path can be
      // exercised end-to-end, with a real number, before the key arrives.
      if (/how many|count of/i.test(opts.question)) {
        return {
          kind: 'metric',
          request: { table: 'incident', filter: 'active=true', aggregate: 'count', label: 'open incidents' },
        }
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

    async decide(opts: {
      question: string
      articles: Article[]
      history: Turn[]
    }): Promise<Reply> {
      const user =
        `CONTEXT\n${buildContextBlock(opts.articles)}\n\nQUESTION\n${opts.question}`
      const raw = await complete(SYSTEM_PROMPT, [...opts.history, { role: 'user', content: user }], 1024)
      return parseReply(raw, opts.question)
    },
  }
}
