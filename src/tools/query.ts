// Checks on an encoded query before it reaches the instance. ServiceNow does not reliably reject a
// bad query: prose is ignored and the whole table is counted, an unknown field is dropped from the
// filter, and a JavaScript expression runs. Each check returns a plain-language issue the model can
// act on, so a wrong query is corrected on the next step instead of becoming a wrong number.
import { isEncodedQuery, filterFields } from '../servicenow/stats.js'

/** The GlideSystem date functions a filter may call. Anything else in a javascript: clause is rejected. */
const SAFE_GS = /^javascript:gs\.(beginningOfToday|endOfToday|beginningOfYesterday|endOfYesterday|beginningOfThisWeek|endOfThisWeek|beginningOfLastWeek|endOfLastWeek|beginningOfThisMonth|endOfThisMonth|beginningOfLastMonth|endOfLastMonth|beginningOfThisQuarter|endOfThisQuarter|beginningOfLastQuarter|endOfLastQuarter|beginningOfThisYear|endOfThisYear|beginningOfLastYear|endOfLastYear|beginningOfNextMonth|endOfNextMonth|beginningOfNextWeek|endOfNextWeek|daysAgo|daysAgoStart|daysAgoEnd|hoursAgo|hoursAgoStart|hoursAgoEnd|minutesAgo|minutesAgoStart|minutesAgoEnd|monthsAgo|monthsAgoStart|monthsAgoEnd|quartersAgo|quartersAgoStart|quartersAgoEnd|yearsAgo|yearsAgoStart|yearsAgoEnd|now|nowDateTime|getUserID)\((\d{0,4})\)$|^javascript:gs\.dateGenerate\('\d{4}-\d{2}-\d{2}','\d{2}:\d{2}:\d{2}'\)$/

export const MAX_QUERY_LENGTH = 2048

export interface QueryIssue { issue: string; fix?: string }

/** Everything wrong with a filter, in words. An empty list means the shape is acceptable; field names are checked against the table separately. */
export function lintQuery(filter: string): QueryIssue[] {
  const issues: QueryIssue[] = []
  if (filter.length > MAX_QUERY_LENGTH) issues.push({ issue: `the query is ${filter.length} characters; the limit is ${MAX_QUERY_LENGTH}` })
  if (/\s(AND|OR)\s/i.test(filter)) issues.push({ issue: 'conditions are joined with SQL-style AND/OR', fix: 'join conditions with ^ for AND and ^OR for OR, e.g. active=true^priority=1' })
  if (/ORDER BY/i.test(filter)) issues.push({ issue: 'ORDER BY is not encoded-query syntax', fix: 'use ^ORDERBYfield or ^ORDERBYDESCfield' })
  if (/\bWHERE\b|\bSELECT\b/i.test(filter)) issues.push({ issue: 'this looks like SQL, not a ServiceNow encoded query' })
  if (/javascript:/i.test(filter)) {
    for (const clause of filter.split('^')) {
      const m = /javascript:.*$/.exec(clause)
      if (m && !SAFE_GS.test(m[0])) issues.push({ issue: `"${m[0].slice(0, 60)}" is not an allowed date function`, fix: 'use gs.daysAgoStart(N), gs.beginningOfToday(), gs.beginningOfThisMonth(), gs.endOfLastMonth() and similar; no other JavaScript' })
    }
  }
  if (!issues.length && !isEncodedQuery(filter)) {
    issues.push({ issue: 'one or more clauses are not "field<operator>value"', fix: 'each clause is a lowercase field name followed by an operator such as =, !=, >, <, IN, LIKE, ISEMPTY, ISNOTEMPTY, STARTSWITH; clauses are joined with ^' })
  }
  if (/\b(state|priority|impact|urgency)=[A-Za-z]/.test(filter)) issues.push({ issue: 'a choice field is compared to a label, not a value', fix: 'use the stored value (e.g. state=2, priority=1); call list_choices to see them' })
  return issues
}

/** Field names a filter uses, first segment only, for checking against the table's dictionary. */
export function queryFields(filter: string): string[] {
  return filterFields(filter)
}

/** True for a table name shaped like one. Not an allow-list. */
export const TABLE_RE = /^[a-z][a-z0-9_]{1,79}$/
/** A field path: plain or dotted identifiers. */
export const FIELD_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/
export const SYS_ID_RE = /^[0-9a-f]{32}$/
/** Free text a tool may put into a filter value. The characters that would open a new clause are refused. */
export function safeValue(v: string): boolean {
  return !/[\^=]/.test(v) && !/javascript:/i.test(v)
}
