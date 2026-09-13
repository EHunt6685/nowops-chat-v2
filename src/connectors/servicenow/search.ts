import type { Config } from '../../config.js'
import type { Article, KnowledgeConnector, HealthStatus } from '../types.js'
import { PlatformUnavailableError } from '../types.js'
import { makeTokenProvider } from './auth.js'

interface SnRecord {
  sys_id: string
  number?: string
  short_description?: string
  text?: string
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
}

/** Article bodies are HTML. Reduce to readable plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

/** `^`, `=` and `&` break sysparm_query syntax, so they never reach the instance. */
export function sanitiseQuery(q: string): string {
  return q.replace(/[\^=&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

export function makeServiceNowConnector(
  cfg: Config,
  fetchImpl: typeof fetch = fetch,
): KnowledgeConnector {
  const tokens = makeTokenProvider(cfg, fetchImpl)

  async function call(path: string): Promise<SnRecord[]> {
    const token = await tokens.getToken()
    let res: Response
    try {
      res = await fetchImpl(`${cfg.sn.instanceUrl}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
    } catch (e) {
      throw new PlatformUnavailableError(`Cannot reach ${cfg.sn.instanceUrl}.`, e)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new PlatformUnavailableError(
        `ServiceNow search failed (HTTP ${res.status}). ${detail.slice(0, 200)}`,
      )
    }
    const json = (await res.json()) as { result?: SnRecord[] }
    return json.result ?? []
  }

  function buildPath(query: string, limit: number): string {
    const sysparmQuery = [
      'workflow_state=published',
      `kb_knowledge_baseIN${cfg.sn.kbAllowlist.join(',')}`,
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
    name: 'servicenow',

    async search(query: string, limit: number): Promise<Article[]> {
      const records = await call(buildPath(query, limit))
      return records.map((r) => ({
        id: r.sys_id,
        label: r.number,
        title: (r.short_description ?? '').trim(),
        body: stripHtml(r.text ?? ''),
        // Link by sys_id: number is not unique on this instance (D10).
        url: `${cfg.sn.instanceUrl}/kb_view.do?sys_kb_id=${r.sys_id}`,
      }))
    },

    async health(): Promise<HealthStatus> {
      try {
        await call(buildPath('test', 1))
        return { ok: true, detail: `${cfg.sn.kbAllowlist.length} knowledge bases in scope` }
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
