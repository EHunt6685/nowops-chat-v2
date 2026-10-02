// The tool set the loop offers the model, and the one place a tool call is executed: arguments
// are the model's, the result is registered with an id, and every call is logged, including the
// ones that fail, because a rejected attempt is the signal that a description needs work.
import { log } from '../log.js'
import { resolveReference } from './reference.js'
import { describeTable, listChoices } from './schema.js'
import { count, aggregate, listRecords } from './records.js'
import { runDefinition } from './definition.js'
import { searchKnowledge, getArticle } from './knowledge.js'
import { getTicket, myQueue } from './ticket.js'
import { lintQuery } from './query.js'
import { ToolError, str, type ToolDef, type ToolContext, type ToolResult } from './types.js'

export const validateQuery: ToolDef = {
  name: 'validate_query',
  description: 'Check an encoded query for syntax problems before running it. Returns the issues in words, or ok. Field names are checked when the query runs.',
  input_schema: { type: 'object', properties: { filter: { type: 'string' } }, required: ['filter'] },
  async run(args) {
    const filter = str(args.filter, 2048)
    const issues = lintQuery(filter)
    return { data: { filter, ok: issues.length === 0, issues } }
  },
}

export const askUser: ToolDef = {
  name: 'ask_user',
  description:
    'Ask the user one short clarifying question and stop. Use when resolve_reference returned apply=false (name the candidates), or when the question has two readings that give different numbers. ' +
    'At most once per question. Do not ask when a sensible reading exists.',
  input_schema: { type: 'object', properties: { question: { type: 'string', description: 'One sentence, naming the options if there are some' } }, required: ['question'] },
  async run(args, ctx) {
    const q = str(args.question, 400)
    if (!q) throw new ToolError('question is empty')
    ctx.turn.clarify = q
    return { data: { asked: q } }
  },
}

export const TOOLS: ToolDef[] = [runDefinition, count, aggregate, listRecords, resolveReference, describeTable, listChoices, validateQuery, searchKnowledge, getArticle, getTicket, myQueue, askUser]

export function toolSpecs() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
}

/** Runs one call. Never throws: a failure becomes a result the model reads, with the reason. */
export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult & { error?: string }> {
  const started = Date.now()
  const id = ctx.turn.nextId()
  const tool = TOOLS.find((t) => t.name === name)
  const fail = (error: string, code = 'invalid'): ToolResult & { error: string } => {
    const r = { id, tool: name, args, data: { error, code }, ms: Date.now() - started, error }
    log('chat.tool_rejected', { id, tool: name, args, error, code, ms: r.ms })
    ctx.turn.results.push(r)
    return r
  }
  if (!tool) return fail(`no tool named ${name}`, 'unknown_tool')
  try {
    const out = await tool.run(args ?? {}, ctx)
    const r: ToolResult = { id, tool: name, args, ...out, ms: Date.now() - started }
    ctx.turn.results.push(r)
    log('chat.tool', { id, tool: name, args, url: r.url, ms: r.ms, summary: summarise(r) })
    return r
  } catch (e) {
    if (e instanceof ToolError) return fail(e.message, e.code)
    const msg = e instanceof Error ? e.message : String(e)
    return fail(`ServiceNow did not answer: ${msg.slice(0, 200)}`, 'servicenow')
  }
}

/** One line per result for the log. */
function summarise(r: ToolResult): string {
  const d = r.data
  if ('count' in d) return `count ${String(d.count)}`
  if ('value' in d) return `value ${String(d.value)}${d.narrowed ? ` ${String(d.narrowed)}` : ''}`
  if ('total' in d) return `total ${String(d.total)}`
  if ('candidates' in d) return `${(d.candidates as unknown[]).length} candidates, apply=${String(d.apply)}`
  if ('articles' in d) return `${(d.articles as unknown[]).length} articles`
  if ('asked' in d) return 'clarify'
  return Object.keys(d).slice(0, 4).join(',')
}
