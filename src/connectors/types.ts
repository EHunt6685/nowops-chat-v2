/** One knowledge item, whatever platform it came from. */
export interface Article {
  /** Stable unique id — ServiceNow sys_id, Confluence page id, Jira issue key. */
  id: string
  /** Human-facing label such as KB0010141. Display only: NOT unique on ServiceNow. */
  label?: string
  title: string
  body: string
  /** Where a human opens this article. */
  url: string
}

export interface HealthStatus {
  ok: boolean
  detail?: string
}

/**
 * The platform seam (D12). Nothing above this interface may know which
 * ticketing platform is in use.
 */
export interface KnowledgeConnector {
  name: string
  search(query: string, limit: number): Promise<Article[]>
  health(): Promise<HealthStatus>
}

/**
 * Thrown when the platform cannot be reached or rejects our credentials.
 * Distinct from "no results" — the two must never produce the same user message.
 */
export class PlatformUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'PlatformUnavailableError'
  }
}
