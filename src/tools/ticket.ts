// get_ticket and my_queue: what the Resolve page assembles in the browser, done server-side on
// demand, so "how do I fix this" and "what is waiting on me" work from any page. Each section
// says "unavailable" when its read fails; a failure is never an empty list.
import { makeSearch } from '../servicenow/search.js'
import { relevant } from '../relevance.js'
import type { Article } from '../servicenow/types.js'
import { rows, dv, vv, statsCount, listUrl, recordUrl } from './fetch.js'
import { ToolError, str, type ToolDef, type ToolContext } from './types.js'
import { safeValue } from './query.js'

const PREFIX: Record<string, string> = { INC: 'incident', CHG: 'change_request', PRB: 'problem', RITM: 'sc_req_item', REQ: 'sc_request', SCTASK: 'sc_task', TASK: 'task' }
const NUMBER_RE = /^([A-Z]{3,6})\d{7,}$/

async function section<T>(fn: () => Promise<T>): Promise<T | { unavailable: string }> {
  try { return await fn() } catch (e) { return { unavailable: e instanceof Error ? e.message.slice(0, 160) : 'read failed' } }
}

export const getTicket: ToolDef = {
  name: 'get_ticket',
  description:
    'One ticket by number (INC..., CHG..., PRB..., RITM...): its fields, SLAs, latest journal entries, resolved tickets with the same title and their close notes, and knowledge articles matching its title. ' +
    'Use for "this ticket", "how do I fix this", "who is the caller", "has the SLA breached", when a number is known: from the message or the TICKET in the USER block. ' +
    'Never call it without a number. If the user says "this ticket" and no number is known anywhere, the question is about tickets like the one described: use search_knowledge for the described situation instead.',
  input_schema: { type: 'object', properties: { number: { type: 'string', description: 'Ticket number, e.g. INC0011804' } }, required: ['number'] },
  async run(args, ctx) {
    const number = str(args.number, 20).toUpperCase()
    const m = NUMBER_RE.exec(number)
    const table = m ? PREFIX[m[1]!] : undefined
    if (!table || !safeValue(number)) throw new ToolError(`"${number}" is not a ticket number (INC, CHG, PRB, RITM, REQ, SCTASK)`)
    const fields = 'sys_id,number,short_description,description,state,priority,impact,urgency,category,subcategory,assignment_group,assigned_to,caller_id,opened_by,requested_for,cmdb_ci,business_service,location,opened_at,resolved_at,resolved_by,close_code,close_notes,reassignment_count,reopen_count,sys_updated_on'
    const t = (await rows(ctx.sn, table, `number=${number}`, fields, 1))[0]
    if (!t) throw new ToolError(`no ${table} record ${number} on this instance`)
    const id = vv(t, 'sys_id')
    const ticket: Record<string, string> = {}
    for (const f of fields.split(',')) { const v = dv(t, f); if (v && f !== 'sys_id') ticket[f] = v.slice(0, 600) }
    const title = dv(t, 'short_description')
    const foundArticles: Article[] = title ? await (async () => relevant(title, await makeSearch(ctx.sn).search(title)).slice(0, 3))().catch(() => [] as Article[]) : []
    const [slas, journal, similar] = await Promise.all([
      section(async () => (await rows(ctx.sn, 'task_sla', `task=${id}^ORDERBYDESChas_breached`, 'sla,stage,has_breached,business_percentage,planned_end_time,active', 10))
        .map((s) => ({ sla: dv(s, 'sla'), stage: dv(s, 'stage'), breached: vv(s, 'has_breached') === 'true', percent: Number(vv(s, 'business_percentage')) || 0, planned_end: dv(s, 'planned_end_time'), active: vv(s, 'active') === 'true' }))),
      section(async () => (await rows(ctx.sn, 'sys_journal_field', `element_id=${id}^elementINcomments,work_notes^ORDERBYDESCsys_created_on`, 'element,value,sys_created_on,sys_created_by', 8))
        .map((j) => ({ when: dv(j, 'sys_created_on'), by: dv(j, 'sys_created_by'), kind: vv(j, 'element') === 'comments' ? 'comment' : 'work note', text: dv(j, 'value').slice(0, 400) }))),
      section(async () => {
        if (!title || table !== 'incident') return []
        const needle = title.replace(/[\^=]/g, ' ').slice(0, 60)
        return (await rows(ctx.sn, 'incident', `short_descriptionLIKE${needle}^stateIN6,7^sys_id!=${id}^ORDERBYDESCresolved_at`, 'number,caller_id,resolved_at,resolved_by,close_notes', 4))
          .map((s) => ({ number: dv(s, 'number'), caller: dv(s, 'caller_id'), resolved_at: dv(s, 'resolved_at'), resolved_by: dv(s, 'resolved_by'), close_notes: dv(s, 'close_notes').slice(0, 500) || '(none)' }))
      }),
    ])
    const articles = foundArticles.map((a) => ({ number: a.label, title: a.title, snippet: a.body.slice(0, 300), url: a.url }))
    return {
      data: { table, number, ticket, slas, journal, similar_resolved: similar, articles, note: 'Close notes of a similar ticket are evidence only if they record what fixed it; an escalation or a boilerplate closure is not a fix.' },
      url: recordUrl(ctx.sn.instanceUrl, table, id),
      articles: foundArticles,
    }
  },
}

export const myQueue: ToolDef = {
  name: 'my_queue',
  description:
    'The signed-in user\'s own work: tickets assigned to them, unassigned tickets in their groups, their breached or breaching SLAs, and the page\'s queue counts when the page sent them. ' +
    'Use for "my tickets", "assigned to me", "waiting on my reply", "what should I pick up". Needs a signed-in user; says so otherwise.',
  input_schema: { type: 'object', properties: {} },
  async run(_args, ctx: ToolContext) {
    const u = ctx.user
    if (!u) throw new ToolError('no signed-in user in this context; the user must sign in before their queue can be read')
    const open = `stateIN${ctx.openStates}`
    const groups = u.groups.map((g) => g.id).join(',')
    const mine = `${open}^assigned_to=${u.id}`
    const unassigned = groups ? `${open}^assigned_toISEMPTY^assignment_groupIN${groups}` : ''
    const [assigned, unassignedN, breaching, first] = await Promise.all([
      section(() => statsCount(ctx.sn, 'incident', mine)),
      section(async () => (unassigned ? statsCount(ctx.sn, 'incident', unassigned) : 0)),
      section(() => statsCount(ctx.sn, 'task_sla', `active=true^task.assigned_to=${u.id}^has_breached=true^ORbusiness_percentage>80^task.assigned_to=${u.id}`)),
      section(async () => (await rows(ctx.sn, 'incident', `${mine}^ORDERBYpriority^ORDERBYopened_at`, 'number,short_description,priority,opened_at', 5))
        .map((r) => ({ number: dv(r, 'number'), title: dv(r, 'short_description'), priority: dv(r, 'priority'), opened: dv(r, 'opened_at') }))),
    ])
    const page = ctx.facts?.queue
    return {
      data: {
        user: u.name, groups: u.groups.map((g) => g.name),
        assigned_to_me: assigned, unassigned_in_my_groups: unassignedN, my_slas_breached_or_past_80_percent: breaching,
        oldest_highest_priority_first: first,
        from_the_page: page ? { loaded_at: ctx.facts?.loadedAt, waiting_on_my_reply: page.waiting_on_my_reply, reopened: page.reopened, changed_last_4h: page.changed_last_4h, first_in_queue: page.first } : undefined,
        note: page ? '"waiting on my reply" and "first in queue" come from the page, computed when it loaded, not from a live query. Say so if you quote them.' : '"waiting on my reply" needs the Resolve page open; it is not available here.',
      },
      url: listUrl(ctx.sn.instanceUrl, 'incident', mine),
    }
  },
}
