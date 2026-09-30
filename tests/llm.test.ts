import { describe, it, expect } from 'vitest'
import {
  buildContextBlock, buildDefinitionsBlock, buildFactsBlock, parseReply, parseCitations, verifyCitations, stripCitationMarkup,
} from '../src/llm/client.js'
import type { Article } from '../src/servicenow/types.js'

const A = (id: string, title: string): Article =>
  ({ id, title, body: 'body', url: `https://sn/${id}`, label: `KB${id}` })

describe('buildContextBlock', () => {
  it('labels articles [1]..[n] in order', () => {
    const b = buildContextBlock([A('a', 'First'), A('b', 'Second')])
    expect(b).toContain('[1] First')
    expect(b).toContain('[2] Second')
  })
})

describe('buildDefinitionsBlock', () => {
  it('lists id and name, adds meaning only when given, and marks unavailable rows', () => {
    const b = buildDefinitionsBlock([
      { id: 'open_p1', name: 'Open P1 Incidents', available: true },
      { id: 'sla_breached', name: 'SLA Breaches (incidents)', meaning: 'Incident SLAs that have breached', available: false },
    ])
    expect(b).toContain('open_p1 — Open P1 Incidents\n')
    expect(b).toContain('sla_breached — SLA Breaches (incidents): Incident SLAs that have breached [unavailable on this instance]')
  })
  it('is empty when the server has no definitions', () => {
    expect(buildDefinitionsBlock(undefined)).toBe('')
    expect(buildDefinitionsBlock([])).toBe('')
  })
})

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

describe('parseReply', () => {
  it('reads an ANSWER and keeps its citations', () => {
    const r = parseReply('ANSWER\nReset it from the portal [1].', 'q')
    expect(r.kind).toBe('answer')
    if (r.kind === 'answer') expect(r.text).toBe('Reset it from the portal [1].')
  })

  it('reads a METRIC into a request, keeping the display label', () => {
    const r = parseReply(
      'METRIC\n{"table":"incident","filter":"active=true","aggregate":"count","label":"open incidents"}',
      'how many open incidents',
    )
    expect(r.kind).toBe('metric')
    if (r.kind === 'metric') {
      expect(r.request.table).toBe('incident')
      expect(r.request.filter).toBe('active=true')
      expect(r.request.aggregate).toBe('count')
      expect(r.request.label).toBe('open incidents')
    }
  })

  it('accepts a METRIC without a label', () => {
    const r = parseReply('METRIC\n{"table":"incident","filter":"","aggregate":"count"}', 'q')
    expect(r.kind).toBe('metric')
    if (r.kind === 'metric') expect(r.request.label).toBeUndefined()
  })

  it('declines a METRIC whose aggregate is not permitted', () => {
    const r = parseReply('METRIC\n{"table":"incident","filter":"","aggregate":"median"}', 'q')
    expect(r.kind).toBe('no_answer')
  })

  it('declines a METRIC that is not valid JSON', () => {
    expect(parseReply('METRIC\n{table: incident}', 'q').kind).toBe('no_answer')
  })

  it('declines a METRIC with no table', () => {
    expect(parseReply('METRIC\n{"filter":"active=true","aggregate":"count"}', 'q').kind)
      .toBe('no_answer')
  })

  it('reads a SEARCH as new keywords', () => {
    const r = parseReply('SEARCH\noutlook repeated password prompt credentials', 'windows popup')
    expect(r.kind).toBe('search')
    if (r.kind === 'search') expect(r.query).toBe('outlook repeated password prompt credentials')
  })

  it('declines a SEARCH that just repeats the question', () => {
    // Re-running the identical search burns a call for identical results.
    expect(parseReply('SEARCH\nwindows popup', 'windows popup').kind).toBe('no_answer')
  })

  it('declines an empty SEARCH', () => {
    expect(parseReply('SEARCH\n   ', 'q').kind).toBe('no_answer')
  })

  it('reads NO_ANSWER with the kind of question it declined', () => {
    expect(parseReply('NO_ANSWER count', 'q')).toEqual({ kind: 'no_answer', about: 'count' })
    expect(parseReply('NO_ANSWER knowledge', 'q')).toEqual({ kind: 'no_answer', about: 'knowledge' })
    // A bare or unrecognised word is still a decline, worded neutrally.
    expect(parseReply('NO_ANSWER', 'q')).toEqual({ kind: 'no_answer', about: 'other' })
    expect(parseReply('NO_ANSWER banana', 'q')).toEqual({ kind: 'no_answer', about: 'other' })
  })

  it('reads a DEFINITION id from the verb line or the next line', () => {
    expect(parseReply('DEFINITION open_p1', 'q')).toEqual({ kind: 'definition', id: 'open_p1' })
    expect(parseReply('DEFINITION\nsla_breached', 'q')).toEqual({ kind: 'definition', id: 'sla_breached' })
    expect(parseReply('DEFINITION: Open_P1', 'q')).toEqual({ kind: 'definition', id: 'open_p1' })
  })

  it('declines a DEFINITION whose id is not shaped like one', () => {
    expect(parseReply('DEFINITION\nOpen P1 Incidents', 'q')).toEqual({ kind: 'no_answer', about: 'count' })
    expect(parseReply('DEFINITION', 'q')).toEqual({ kind: 'no_answer', about: 'count' })
  })

  it('reads a PAGE answer and declines an empty one as a page question', () => {
    expect(parseReply('PAGE\n3 tickets are waiting on your reply.', 'q')).toEqual({ kind: 'page', text: '3 tickets are waiting on your reply.' })
    expect(parseReply('PAGE', 'q')).toEqual({ kind: 'no_answer', about: 'page' })
    // Seen live: a decline written inside the PAGE form. It must not be shown as an answer.
    expect(parseReply('PAGE\nNO_ANSWER page', 'q')).toEqual({ kind: 'no_answer', about: 'page' })
    expect(parseReply('NO_ANSWER page', 'q')).toEqual({ kind: 'no_answer', about: 'page' })
  })

  it('declines a malformed METRIC as a count, not a knowledge miss', () => {
    expect(parseReply('METRIC\n{table: incident}', 'q')).toEqual({ kind: 'no_answer', about: 'count' })
  })

  it('treats an unrecognised reply as NO_ANSWER rather than guessing', () => {
    expect(parseReply('Sure! Here is what I think...', 'q').kind).toBe('no_answer')
  })

  it('tolerates leading blank lines and stray whitespace', () => {
    expect(parseReply('\n\n  ANSWER  \nText [1]', 'q').kind).toBe('answer')
  })

  // Real models are sloppy in predictable ways. Each of these is a formatting
  // variation, not a different intent, and must not turn into a decline.
  it('reads a METRIC wrapped in a code fence', () => {
    const r = parseReply('METRIC\n```json\n{"table":"change_request","filter":"active=true","aggregate":"count"}\n```', 'q')
    expect(r.kind).toBe('metric')
  })

  it('skips a preamble before the verb line', () => {
    const r = parseReply('Sure! Here is the query:\nMETRIC\n{"table":"problem","filter":"active=true","aggregate":"count"}', 'q')
    expect(r.kind).toBe('metric')
  })

  it('accepts a colon after the verb', () => {
    expect(parseReply('METRIC:\n{"table":"incident","filter":"","aggregate":"count"}', 'q').kind).toBe('metric')
    expect(parseReply('ANSWER:\nText [1]', 'q').kind).toBe('answer')
  })

  it('normalises aggregate case — COUNT is count, not a different aggregate', () => {
    const r = parseReply('METRIC\n{"table":"incident","filter":"state=8","aggregate":"COUNT"}', 'q')
    expect(r.kind).toBe('metric')
    if (r.kind === 'metric') expect(r.request.aggregate).toBe('count')
  })

  it('ignores chatter after the JSON object', () => {
    const r = parseReply('METRIC\n{"table":"alm_asset","filter":"","aggregate":"count"}\n\nLet me know if you need anything else!', 'q')
    expect(r.kind).toBe('metric')
  })

  it('declines a METRIC that asks for a breakdown — series are out of scope', () => {
    // ServiceNow ignores GROUPBY on /stats/ and returns the total, which is a correct
    // number for the wrong question. Decline rather than show it.
    const r = parseReply('METRIC\n{"table":"incident","filter":"active=true^GROUPBYpriority","aggregate":"count"}', 'q')
    expect(r.kind).toBe('no_answer')
  })
})

describe('verifyCitations', () => {
  const supplied = [A('a', 'First'), A('b', 'Second')]

  it('maps cited labels back to articles', () => {
    const { sources, fabricated } = verifyCitations([1, 2], supplied)
    expect(sources.map((s) => s.id)).toEqual(['a', 'b'])
    expect(fabricated).toEqual([])
  })

  it('reports a label that was never supplied', () => {
    const { sources, fabricated } = verifyCitations([1, 7], supplied)
    expect(sources.map((s) => s.id)).toEqual(['a'])
    expect(fabricated).toEqual([7])
  })
})

describe('parseCitations and stripCitationMarkup', () => {
  it('finds each distinct label once', () => {
    expect(parseCitations('a [1] b [2] c [1]')).toEqual([1, 2])
  })
  it('removes the markers once sources render separately', () => {
    expect(stripCitationMarkup('Do this [1]. Then that [2].')).toBe('Do this. Then that.')
  })
})
