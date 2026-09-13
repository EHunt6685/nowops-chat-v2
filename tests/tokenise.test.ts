import { describe, it, expect } from 'vitest'
import { tokenise, coverage } from '../src/gate/tokenise.js'

describe('tokenise', () => {
  it('lowercases and splits on punctuation', () => {
    expect(tokenise('Printer, JAM!')).toEqual(['printer', 'jam'])
  })

  it('drops stopwords and very short tokens', () => {
    expect(tokenise('the printer is on my desk')).toEqual(['printer', 'desk'])
  })

  it('keeps error codes and identifiers intact', () => {
    expect(tokenise('AP_MAX_AMOUNT and $.entities')).toEqual(['ap_max_amount', '$.entities'])
  })

  it('reduces greeting-only input to a single term', () => {
    expect(tokenise('Hi Team,')).toEqual(['team'])
  })
})

describe('coverage', () => {
  it('is 1 when every query term appears', () => {
    expect(coverage('printer jam', 'the printer has a jam')).toBe(1)
  })

  it('is 0.5 when half appear', () => {
    expect(coverage('printer jam', 'the printer is fine')).toBe(0.5)
  })

  it('is 0 for no overlap', () => {
    expect(coverage('printer jam', 'network outage')).toBe(0)
  })

  it('is 0 when the query has no meaningful terms', () => {
    expect(coverage('the is a', 'anything')).toBe(0)
  })

  it('counts each distinct term once', () => {
    expect(coverage('printer printer jam', 'printer jam')).toBe(1)
  })
})
