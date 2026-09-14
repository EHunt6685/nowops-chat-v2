import { describe, it, expect } from 'vitest'
import { tokenise, hasEnoughTokens } from '../src/guard.js'

describe('tokenise', () => {
  it('lowercases, strips punctuation and drops 1-2 character tokens', () => {
    expect(tokenise('How do I reset my SAP password')).toEqual(['how', 'reset', 'sap', 'password'])
  })

  it('keeps characters that appear in error codes', () => {
    expect(tokenise('ORA-01017 invalid $HOME path')).toEqual(['ora-01017', 'invalid', '$home', 'path'])
  })

  it('returns nothing for empty input', () => {
    expect(tokenise('')).toEqual([])
  })
})

describe('hasEnoughTokens', () => {
  it('rejects greeting noise before any network call', () => {
    expect(hasEnoughTokens('Hi Team,')).toBe(false)
    expect(hasEnoughTokens('nan')).toBe(false)
    expect(hasEnoughTokens('ok')).toBe(false)
  })

  it('lets a two-token fragment through to Claude', () => {
    // 'Bky OLO' is two 3-character tokens, exactly at the floor. Layer 2 handles it.
    expect(hasEnoughTokens('Bky OLO')).toBe(true)
  })

  it('lets short metric questions through — the model, not the guard, judges them', () => {
    // These were declined for free when common words counted as stopwords. A user
    // asking "how many incidents" must reach the model.
    expect(hasEnoughTokens('how many incidents')).toBe(true)
    expect(hasEnoughTokens('how many users do we have')).toBe(true)
    expect(hasEnoughTokens('what is our uptime')).toBe(true)
  })

  it('accepts a real question', () => {
    expect(hasEnoughTokens('how many open incidents are there')).toBe(true)
  })
})
