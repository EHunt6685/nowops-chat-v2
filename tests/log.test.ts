import { describe, it, expect } from 'vitest'
import { mask } from '../src/log.js'

describe('mask', () => {
  it('shows only the first and last few characters', () => {
    expect(mask('sk-abc123456789wxyz')).toBe('sk-ab…wxyz')
  })

  it('fully masks short secrets rather than leaking them', () => {
    expect(mask('short')).toBe('…')
  })

  it('handles empty input', () => {
    expect(mask('')).toBe('…')
  })
})
