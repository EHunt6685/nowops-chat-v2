import type { Article } from './types.js'
import type { SnClient } from './client.js'

interface SnRecord {
  sys_id: string
  number?: string
  short_description?: string
  text?: string
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

export function makeSearch(sn: SnClient) {
  async function call(path: string): Promise<SnRecord[]> {
    return (await sn.get<{ result?: SnRecord[] }>(path)).result ?? []
  }

  function buildPath(query: string, limit = SEARCH_LIMIT): string {
    // Two clauses only. A knowledge base filter was A/B tested and removed (D5).
    const sysparmQuery = [
      'workflow_state=published',
      `123TEXTQUERY321=${sanitiseQuery(query)}`,
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
