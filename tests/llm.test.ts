import { describe, it, expect } from 'vitest'
import {
  buildContextBlock, parseReply, parseCitations, verifyCitations, stripCitationMarkup,
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

  it('reads NO_ANSWER', () => {
    expect(parseReply('NO_ANSWER', 'q').kind).toBe('no_answer')
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
