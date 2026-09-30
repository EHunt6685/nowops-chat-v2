import { describe, it, expect } from 'vitest'
import { systemsIn, sameSystem, classifyOutcome, isNowOpsNote, describePrecedent, noEvidence, fixFrom } from '../src/resolve/evidence.js'

describe('sameSystem', () => {
  it('rules out an article about another system', () => {
    // INC0011804: a ServiceNow account, offered the Workday SOP. Seen live 2026-09-30.
    expect(sameSystem('My Servicenow account is inactive', 'Workday Account Management – Password Reset, Login Issues, Account Lock')).toBe(false)
    expect(sameSystem('My Servicenow account is inactive', 'This SOP defines the process for troubleshooting Salesforce password and login-related issues')).toBe(false)
    // INC1201607: Edge will not load, offered a Yardi guide. INC0012438: MID server, offered the VPN article.
    expect(sameSystem('Microsoft Edge Browser - Customer unable to load MS Edge', 'Yardi 7S Voyager Application – Login & Access Issues')).toBe(false)
    expect(sameSystem('There is an error in the MID server - MID_FILE_MONITOR', 'VPN Login Redirect Failure in Cisco Secure Client')).toBe(false)
  })
  it('keeps an article about the same system, or a generic one', () => {
    expect(sameSystem('VPN Error message- trying to connect to VPN via Cisco Secure Client', 'VPN Login Redirect Failure in Cisco Secure Client')).toBe(true)
    expect(sameSystem('There is an error in the MID server', "Error: Login failed for user 'domain\\username, using MID server")).toBe(true)
    expect(sameSystem('PC very sluggish', 'How to set or change your default web browser')).toBe(true)
    // A ticket that names no system cannot rule anything out.
    expect(sameSystem('cannot log in', 'Workday Account Management')).toBe(true)
  })
  it('detects systems by their common spellings', () => {
    expect(systemsIn('Work Day password reset')).toEqual(['workday'])
    expect(systemsIn('trying to connect via Cisco Secure Client')).toEqual(['vpn'])
  })
})

describe('classifyOutcome', () => {
  it('calls a boilerplate closure hollow', () => {
    expect(classifyOutcome('Closed as part of demo data preparation.')).toBe('hollow')
    expect(classifyOutcome('Closed via script')).toBe('hollow')
    expect(classifyOutcome('Incident resolved automatically because the application name was not provided.')).toBe('hollow')
    expect(classifyOutcome('')).toBe('hollow')
  })
  it('calls an escalation an escalation, not a fix', () => {
    // INC0011685: L1 escalated to L2, L2 posted a checklist. Nothing says the account was reactivated.
    expect(classifyOutcome('Escalated to L2 support for investigation.', ['The user account is inactive. Escalating to L2 support for further investigation and resolution.'])).toBe('escalated')
  })
  it('calls a recorded fix resolved, even if it was escalated first', () => {
    expect(classifyOutcome('The L2 support team reactivated the user account. The user confirmed login works.', ['Escalating to L2.'])).toBe('resolved')
    expect(classifyOutcome('Password reset completed successfully. Temporary password shared securely.')).toBe('resolved')
  })
})

describe('isNowOpsNote', () => {
  it('recognises the notes NowOps itself writes', () => {
    expect(isNowOpsNote('Try what closed INC0011685: The L2 support team reactivated the account.')).toBe(true)
    expect(isNowOpsNote('Ask Alene Rabeck whether it has stayed fixed since 2026-09-23.')).toBe(true)
    expect(isNowOpsNote('Record completed via NowOps: cmdb ci.')).toBe(true)
    // INC0012237: the generator cited this rule-written note as "work note of 2026-09-22".
    expect(isNowOpsNote('Ask Abel Tuter what exactly happens, since when, and which device: the ticket does not say.')).toBe(true)
  })
  it('leaves a human note alone', () => {
    expect(isNowOpsNote('User account is inactive. Escalated to L2 support.')).toBe(false)
  })
})

describe('fixFrom', () => {
  // INC0011685's real close note: 900 characters, Resolution last. A flat cut hid the fix.
  const note = 'Problem: My Servicenow account is inactive Category: inquiry | Assignment Group: L2 - Shared Application Support | Priority: 4 - Low Actions Taken: The user\'s account was identified as inactive. The details and account status were verified in the ServiceNow instance to confirm the issue. Checks were performed to identify any known issues causing accounts to become inactive, as well as to determine if there were pending approvals or tasks related to the account reactivation. The user was notified about the ongoing investigation and the next steps. Since the issue could not be resolved at the initial level, it was escalated to the L2 support team for further investigation and account activation. All findings and actions were documented for audit purposes. Root Cause Analysis: The user\'s account was inactive due to an unspecified issue. The work notes do not provide specific technical details regarding the underlying cause of the account\'s inactive status. Resolution: The L2 support team reactivated the user\'s account after completing their investigation. The account reactivation was validated and confirmed with the user to ensure the issue was resolved. Referenced: INC0010056'
  it('leads with the Resolution section so the fix is never cut off', () => {
    const f = fixFrom(note)
    expect(f.startsWith('resolution: The L2 support team reactivated')).toBe(true)
    expect(f).toContain('root cause: The user\'s account was inactive')
    expect(f).not.toContain('Referenced: INC0010056')
  })
  it('falls back to the flat note when there are no sections', () => {
    expect(fixFrom('Password reset completed successfully.')).toBe('Password reset completed successfully.')
  })
})

describe('describePrecedent', () => {
  const p = { number: 'INC0011685', caller: 'Abel Tuter', resolved_at: '2026-06-18 15:48:58', resolved_by: 'Pragun Saraf', close_notes: 'Escalated to L2.', outcome: 'escalated' as const }
  it('names a different caller so the current one is never told they were fixed before', () => {
    expect(describePrecedent(p, 'Alene Rabeck')).toContain('a different caller, Abel Tuter')
    expect(describePrecedent({ ...p, outcome: 'resolved' }, 'Abel Tuter')).toContain('same caller')
  })
  it('says ESCALATED, no fix recorded', () => {
    expect(describePrecedent(p, 'Alene Rabeck')).toContain('ESCALATED, no fix recorded')
  })
  it('hides a hollow one', () => {
    expect(describePrecedent({ ...p, outcome: 'hollow' }, 'x')).toBeNull()
  })
})

describe('noEvidence', () => {
  it('is true with only escalated look-alikes and no matched article', () => {
    expect(noEvidence([{ number: 'a', close_notes: '', outcome: 'escalated' }], 0)).toBe(true)
    expect(noEvidence([{ number: 'a', close_notes: 'fixed', outcome: 'resolved' }], 0)).toBe(false)
    expect(noEvidence([], 1)).toBe(false)
  })
})
