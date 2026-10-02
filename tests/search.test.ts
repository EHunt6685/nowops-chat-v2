import { describe, it, expect } from 'vitest'
import { searchTerms, makeSearch, sanitiseQuery } from '../src/servicenow/search.js'
import type { SnClient } from '../src/servicenow/client.js'

describe('searchTerms', () => {
  it('drops the words that shape a question and keeps the ones that name something', () => {
    // Seen live 2026-10-01: the raw sentence returned one article about a payment terminal,
    // the two content words returned five password articles.
    expect(searchTerms('How do I reset a password?')).toBe('reset password')
    expect(searchTerms('Can you tell me how to fix a printer that is not printing?')).toBe('fix printer not printing')
    expect(searchTerms('what is the process for onboarding a new joiner')).toBe('onboarding new joiner')
  })
  it('keeps negatives, codes and product names in the user\'s order', () => {
    expect(searchTerms('user cannot log in to Outlook')).toBe('user cannot log Outlook')
    expect(searchTerms('starter needs copilot and an E3')).toBe('starter needs copilot E3')
    expect(searchTerms('mid server is complaining that the password is too long')).toBe('mid server complaining password too long')
    expect(searchTerms('ORA-01017 invalid $HOME path')).toBe('ORA-01017 invalid $HOME path')
  })
  it('sends a question made only of scaffolding through unchanged, never as an empty search', () => {
    expect(searchTerms('what is this')).toBe('what is this')
  })
  it('leaves a ticket title alone when it has nothing to strip', () => {
    expect(searchTerms('Unable to login VPN')).toBe('Unable login VPN')
    expect(searchTerms('Cannot connect to VPN')).toBe('Cannot connect VPN')
  })
})

describe('makeSearch', () => {
  const calls: string[] = []
  const client = {
    instanceUrl: 'https://sn',
    get: async (path: string) => { calls.push(decodeURIComponent(path.replace(/\+/g, ' '))); return { result: [] } },
  } as unknown as SnClient
  it('searches the scrubbed terms, not the raw sentence', async () => {
    calls.length = 0
    await makeSearch(client).search('How do I reset a password?')
    expect(calls[0]).toContain('123TEXTQUERY321=reset password')
  })
  it('can be given another term function, for measuring', async () => {
    calls.length = 0
    await makeSearch(client, { terms: (q) => q }).search('How do I reset a password?')
    expect(calls[0]).toContain('123TEXTQUERY321=How do I reset a password?')
  })
})

describe('sanitiseQuery', () => {
  it('removes the characters that break an encoded query', () => {
    expect(sanitiseQuery('a^b=c&d')).toBe('a b c d')
  })
})
