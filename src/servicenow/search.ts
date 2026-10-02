import type { Article } from './types.js'
import type { SnClient } from './client.js'

interface SnRecord {
  sys_id: string
  number?: string
  short_description?: string
  text?: string
  name?: string
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
}

/** Article bodies are HTML. Tags become spaces so words never run together. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

/** `^`, `=` and `&` break sysparm_query syntax, so they never reach the instance. */
export function sanitiseQuery(q: string): string {
  return q.replace(/[\^=&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** Five candidates reach the prompt. Measured at 83% recall@5; not configurable. */
const SEARCH_LIMIT = 5

/**
 * Words that shape a question but name nothing: interrogatives, auxiliaries, pronouns,
 * articles, prepositions and the verbs of asking. Negatives ("not", "cannot", "unable")
 * are not here: they are part of the symptom.
 */
const SCAFFOLD = new Set([
  'how', 'do', 'does', 'did', 'done', 'doing', 'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your', 'yours',
  'he', 'she', 'they', 'them', 'their', 'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'what', 'which', 'when', 'where', 'why', 'who', 'whom', 'whose',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'has', 'have', 'had',
  'a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'into', 'onto', 'up', 'as', 'if', 'so', 'or', 'and', 'but', 'than', 'then',
  'please', 'tell', 'show', 'give', 'know', 'want', 'need', 'help', 'let', 'get', 'got', 'make', 'way', 'like', 'just', 'some', 'any',
  'someone', 'somebody', 'something', 'anyone', 'anybody', 'anything', 'one',
  'steps', 'step', 'procedure', 'process', 'guide', 'instructions', 'article', 'kb', 'question',
])

/**
 * The words a knowledge search should see. ServiceNow's text search ranks every word in the
 * query, so "How do I reset a password?" lands on an article titled "How do I quit an
 * application" while "reset password" lands on the password articles. Seen live 2026-10-01:
 * the raw sentence returned one article, about a payment terminal; the two content words
 * returned five password articles. Question scaffolding is removed; everything else, including
 * negatives, codes and product names, stays in the user's order. A question that is all
 * scaffolding goes through unchanged rather than as an empty search.
 */
export function searchTerms(question: string): string {
  const words = question.replace(/[^\p{L}\p{N}$._\-'\s]/gu, ' ').split(/\s+/).filter(Boolean)
  const kept = words.filter((w) => !SCAFFOLD.has(w.toLowerCase().replace(/^'|'$/g, '')))
  return (kept.length ? kept : words).join(' ')
}

export function makeSearch(sn: SnClient, opts: { terms?: (q: string) => string } = {}) {
  const terms = opts.terms ?? searchTerms
  async function call(path: string): Promise<SnRecord[]> {
    return (await sn.get<{ result?: SnRecord[] }>(path)).result ?? []
  }

  function buildPath(query: string, limit = SEARCH_LIMIT): string {
    // Two clauses only. A knowledge base filter was A/B tested and removed (D5).
    const sysparmQuery = [
      'workflow_state=published',
      `123TEXTQUERY321=${sanitiseQuery(terms(query))}`,
    ].join('^')

    const params = new URLSearchParams({
      sysparm_limit: String(limit),
      sysparm_fields: 'sys_id,number,short_description,text',
      sysparm_query: sysparmQuery,
    })
    return `/api/now/table/kb_knowledge?${params.toString()}`
  }

  return {
    async search(query: string): Promise<Article[]> {
      const records = await call(buildPath(query))
      return records.map((r) => ({
        id: r.sys_id,
        label: r.number,
        title: (r.short_description ?? '').trim(),
        body: stripHtml(r.text ?? ''),
        // Link by sys_id: number is not unique on this instance (D10).
        url: `${sn.instanceUrl}/kb_view.do?sys_kb_id=${r.sys_id}`,
      }))
    },

    async health(): Promise<{ ok: boolean; detail?: string }> {
      try {
        await call(buildPath('test', 1))
        return { ok: true, detail: 'search reachable' }
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
