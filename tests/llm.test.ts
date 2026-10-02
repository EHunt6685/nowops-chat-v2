import { describe, it, expect } from 'vitest'
import { buildFactsBlock, buildUserBlock } from '../src/llm/client.js'

describe('buildFactsBlock', () => {
  it('renders the queue counts and the open ticket as plain lines, marked as the page\'s', () => {
    const b = buildFactsBlock({
      loadedAt: '2026-09-30T13:41:00Z',
      queue: { assigned_to_me: 7, unassigned_in_my_groups: 12, waiting_on_my_reply: 3, reopened: 1, changed_last_4h: 4, sla_breached_or_breaching_2h: 2, first: { number: 'INC0000017', title: 'VPN down', why: 'oldest P1' } },
      ticket: { number: 'INC0000017', title: 'VPN down', state: 'In Progress', priority: '1 - Critical', group: 'Network', caller: 'Ann Lee', slas: [{ name: 'P1 resolution', breached: true, pct: 140 }], similar: [], same_title: ['INC0000020'], articles: [] },
    })
    expect(b).toContain('PAGE FACTS')
    expect(b).toContain('not a live query')
    expect(b).toContain('3 waiting on my reply')
    expect(b).toContain('first in my queue: INC0000017')
    expect(b).toContain('caller Ann Lee')
    expect(b).toContain('P1 resolution breached')
    expect(b).toContain('same title: INC0000020')
  })
  it('is empty when the page sent nothing', () => {
    expect(buildFactsBlock(undefined)).toBe('')
    expect(buildFactsBlock({})).toBe('')
  })
})

describe('buildUserBlock', () => {
  it('names the user, their groups, the open ticket and the page', () => {
    const b = buildUserBlock({ user: { id: 'a'.repeat(32), name: 'Sam Roy', groups: [{ id: 'b'.repeat(32), name: 'Network' }] }, ticket: 'INC0000017', page: 'ticket' })
    expect(b).toContain('USER')
    expect(b).toContain('name: Sam Roy')
    expect(b).toContain('Network (' + 'b'.repeat(32) + ')')
    expect(b).toContain('TICKET: INC0000017')
    expect(b).toContain('page: ticket')
  })
  it('is empty without a context', () => {
    expect(buildUserBlock(undefined)).toBe('')
  })
})
