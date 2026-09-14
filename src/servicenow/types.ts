/** One knowledge base article. A plain record — nothing implements an interface here. */
export interface Article {
  /** ServiceNow sys_id. The identity key everywhere (D10). */
  id: string
  /** KB number for display only — NOT unique on abhrademo4. */
  label?: string
  title: string
  body: string
  /** Where a human opens this article. */
  url: string
}

/**
 * The instance is unreachable or rejected the request. Deliberately distinct
 * from "no results" — the two must never produce the same user-facing message.
 */
export class ServiceNowUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'ServiceNowUnavailableError'
  }
}
