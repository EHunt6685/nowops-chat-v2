/**
 * Evidence hygiene for Resolve's next steps. Everything the step generator is shown passes through
 * here first, so the model cannot cite an article about another system, treat an escalation as a
 * fix, build on a boilerplate closure, or read NowOps's own earlier suggestions back as findings.
 * Measured against nine tickets on abhrademo4 on 2026-09-30 (tests/fixtures/resolve-eval.json).
 */

/** Product and system names that decide whether an article is about the same thing as a ticket. */
const SYSTEMS: [RegExp, string][] = [
  [/\bservice ?now\b/i, 'servicenow'], [/\bwork ?day\b/i, 'workday'], [/\bWD\b/, 'workday'], [/\bsalesforce\b/i, 'salesforce'],
  [/\boracle\b|\bfusion\b/i, 'oracle'], [/\bsap\b/i, 'sap'], [/\byardi\b/i, 'yardi'], [/\bbaxter\b/i, 'baxter'],
  [/\bcanto\b/i, 'canto'], [/\bmagview\b/i, 'magview'], [/\btimeless\b/i, 'timeless'], [/\bepic\b/i, 'epic'],
  [/\boutlook\b|\bexchange\b/i, 'outlook'], [/\bteams\b/i, 'teams'], [/\bsharepoint\b/i, 'sharepoint'], [/\bonedrive\b/i, 'onedrive'],
  [/\bvpn\b|\bcisco secure client\b|\banyconnect\b/i, 'vpn'], [/\bwi-?fi\b|\bwireless\b/i, 'wifi'], [/\bcitrix\b/i, 'citrix'],
  [/\bedge\b/i, 'edge'], [/\bchrome\b/i, 'chrome'], [/\bfirefox\b/i, 'firefox'], [/\binternet explorer\b/i, 'ie'],
  [/\bipad\b|\biphone\b|\bios\b/i, 'ios'], [/\bandroid\b/i, 'android'], [/\bmac(book)?\b|\bmacos\b/i, 'mac'],
  [/\bprinter\b|\bzebra\b|\bepson\b|\bcitizen\b/i, 'printer'], [/\bsquare\b|\bshopify\b/i, 'pos'], [/\bself-?checkout\b|\bncr\b/i, 'selfcheckout'],
  [/\bmid server\b/i, 'midserver'], [/\bdynatrace\b/i, 'dynatrace'], [/\btanium\b/i, 'tanium'], [/\bintune\b/i, 'intune'], [/\bsccm\b/i, 'sccm'],
  [/\baws\b/i, 'aws'], [/\bgcp\b/i, 'gcp'], [/\bazure\b/i, 'azure'],
]

/** Systems a piece of text names, as canonical tokens. Empty when it names none. */
export function systemsIn(text: string): string[] {
  const out = new Set<string>()
  for (const [re, key] of SYSTEMS) if (re.test(text || '')) out.add(key)
  return [...out]
}

/**
 * Is an article about the same system as the ticket? True when they share a system, or when the
 * article names none (a generic how-to). False when the article names systems and the ticket names
 * others: a Workday SOP is not a partial answer for a ServiceNow account, it is the wrong article.
 * A ticket that names no system cannot rule an article out on this ground.
 */
export function sameSystem(ticketTitle: string, articleTitle: string): boolean {
  const a = systemsIn(articleTitle)
  if (!a.length) return true
  const t = systemsIn(ticketTitle)
  if (!t.length) return true
  return a.some((s) => t.includes(s))
}

/** Close notes that teach nothing. Measured on abhrademo4: bulk clean-ups, scripts, auto-closures. */
export const HOLLOW_NOTE = /demo data|remediation for Memorial|closed via script|data cleanup|not available from (the )?provided information|resolved automatically|closed as part of|auto[- ]?closed|closed by (the )?system|no longer required|duplicate of/i
/** A note that says the thing works again. */
export const FIXED_NOTE = /work(?:ing|s|ed) (?:fine|now|again|ok)|(?:issue|problem) (?:is |was |has been )?(?:resolved|fixed)|resolved the issue|is resolved|fixed the|reactivated|unlocked|reset (?:was|has been)? ?(?:successful|completed|performed)|user confirmed/i
/** A note that hands the ticket on rather than fixing it. */
export const ESCALATED_NOTE = /escalat(?:ed|ing|e) (?:the )?(?:ticket |incident )?to|assigned to (?:the )?L[23]\b|handed (?:over )?to|transferred to|reassigned to|routed to/i

export type Outcome = 'resolved' | 'escalated' | 'hollow'

/**
 * What a look-alike's notes actually record. "Escalated to L2 for investigation" is not a fix, and a
 * step generator that reads it as one tells an agent to do something nobody has shown works.
 */
export function classifyOutcome(closeNotes: string, workNotes: string[] = []): Outcome {
  const close = closeNotes || ''
  if (HOLLOW_NOTE.test(close) || !close.trim()) return 'hollow'
  if (FIXED_NOTE.test(close)) return 'resolved'
  const all = [close, ...workNotes].join('\n')
  if (ESCALATED_NOTE.test(all) && !FIXED_NOTE.test(all)) return 'escalated'
  return 'resolved'
}

/**
 * Work notes NowOps itself wrote: its earlier suggestions and its record fixes. They are not findings
 * about the ticket, and a generator that reads them as evidence agrees with itself forever.
 */
export const NOWOPS_NOTE = /via NowOps\b|^Try what closed INC\d+|^Ask .{1,80} whether it has stayed fixed|^Ask .{1,80} what exactly happens, since when|^Follow (?:KB|SOP)\d+|^Raise one problem record|^Record completed via NowOps|^Reverted by NowOps/i
export const isNowOpsNote = (text: string) => NOWOPS_NOTE.test((text || '').trim())

export interface Precedent { number: string; caller?: string; resolved_at?: string; resolved_by?: string; close_notes: string; outcome: Outcome }

/** A named section of a structured close note ("Resolution: …", "Root Cause Analysis: …"), or ''. */
export function noteSection(notes: string, name: string): string {
  const m = new RegExp(`${name}[^:\\n]*:\\s*([\\s\\S]*?)(?=\\s(?:Problem|Category|Actions Taken|Root Cause[^:]*|Resolution|Referenced|Next Steps)\\s*:|\\n\\s*\\n|$)`, 'i').exec(notes || '')
  return m?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
}

/**
 * The part of a close note that says what fixed it. Structured notes on this instance run to 900
 * characters with the Resolution last; a flat cut at 500 showed the model "user notified, escalated"
 * and hid "L2 reactivated the account", so it reported no documented fix for a ticket that had one.
 */
export function fixFrom(notes: string, max = 600): string {
  const flat = (notes || '').replace(/\s+/g, ' ').trim()
  const res = noteSection(notes, 'Resolution'), rc = noteSection(notes, 'Root Cause'), acts = noteSection(notes, 'Actions Taken')
  if (!res && !acts) return flat.slice(0, max)
  const parts = [res ? `resolution: ${res}` : '', rc ? `root cause: ${rc}` : '', acts ? `actions: ${acts}` : '']
  return parts.filter(Boolean).join(' | ').slice(0, max)
}

/**
 * One line per look-alike as the model should read it: who it was for, so the current caller is never
 * told they were fixed before; and what really happened, so an escalation is proposed as an
 * escalation. Hollow ones are not shown at all.
 */
export function describePrecedent(p: Precedent, currentCaller: string, maxNotes = 600): string | null {
  if (p.outcome === 'hollow') return null
  const who = p.caller && currentCaller && p.caller !== currentCaller ? `a different caller, ${p.caller}` : p.caller ? `same caller, ${p.caller}` : 'caller not recorded'
  const when = p.resolved_at ? p.resolved_at.slice(0, 10) : 'date unknown'
  const by = p.resolved_by ? `, ${p.resolved_by}` : ''
  const notes = fixFrom(p.close_notes, maxNotes)
  if (p.outcome === 'escalated') return `${p.number} (${who}; ${when}${by}) was ESCALATED, no fix recorded: ${notes}`
  return `${p.number} (${who}; ${when}${by}) resolved: ${notes}`
}

/** True when there is nothing that shows how to fix this: no same-system article, no resolved look-alike. */
export function noEvidence(precedents: Precedent[], matchedArticles: number): boolean {
  return matchedArticles === 0 && !precedents.some((p) => p.outcome === 'resolved')
}
