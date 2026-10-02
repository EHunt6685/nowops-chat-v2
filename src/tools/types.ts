// The tool loop's shared types. A tool takes arguments the model wrote, runs against the
// instance, and returns a result the model can cite. Every result has an id (r1, r2, ...),
// the numbers it contains, and where possible a link that opens the same list in ServiceNow.
import type { SnClient } from '../servicenow/client.js'
import type { Kpis } from '../definitions.js'
import type { Article } from '../servicenow/types.js'
import type { DecideContext } from '../llm/client.js'

export interface ToolResult {
  id: string
  tool: string
  /** The arguments as the model wrote them, kept for the trace. */
  args: Record<string, unknown>
  /** What the model reads. Compact JSON; numbers it may quote are in here. */
  data: Record<string, unknown>
  /** A list in ServiceNow that shows the same records, for the Verify link. */
  url?: string
  /** Articles returned, so a citation of this result can be shown as a source link. */
  articles?: Article[]
  ms: number
}

/** State for one question: results so far and the sys_ids a lookup returned, which are the only ones a filter may use. */
export interface TurnState {
  results: ToolResult[]
  /** Every record a lookup returned this turn, by sys_id. A filter may use these and no other sys_id. */
  resolved: Map<string, { kind: string; name: string }>
  /** Set when the model called ask_user: the loop ends and the question is shown. */
  clarify?: string
  nextId(): string
}

export function makeTurn(): TurnState {
  let n = 0
  return { results: [], resolved: new Map(), nextId: () => `r${++n}` }
}

export interface ToolContext {
  sn: SnClient
  kpis?: Kpis
  /** Tables the instance scan found. Null when no scan has run: the built-in allow-list alone applies. */
  scanned: Set<string> | null
  openStates: string
  /** The tenant parameters the scan set: state classes, time zone, automation accounts. */
  params?: Record<string, string>
  user?: DecideContext['user']
  facts?: DecideContext['facts']
  turn: TurnState
}

/** Thrown by a tool when the model's arguments cannot be run. The message goes back to the model as the tool result. */
export class ToolError extends Error {
  constructor(message: string, readonly code: string = 'invalid') { super(message); this.name = 'ToolError' }
}

export interface ToolDef {
  name: string
  description: string
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<Omit<ToolResult, 'id' | 'tool' | 'args' | 'ms'>>
}

export const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
export const num = (v: unknown, dflt: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(max, Math.floor(v))) : dflt)
export const enc = (s: string) => encodeURIComponent(s)
