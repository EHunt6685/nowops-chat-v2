import { describe, it, expect } from 'vitest'
import { makeFakeConnector } from '../src/connectors/fake.js'
import type { Article } from '../src/connectors/types.js'

const articles: Article[] = [
  { id: 'a1', label: 'KB0001', title: 'VPN will not connect', body: 'restart the vpn client', url: 'https://x/a1' },
  { id: 'a2', label: 'KB0002', title: 'Printer jam', body: 'open the tray and clear paper', url: 'https://x/a2' },
]

describe('KnowledgeConnector contract', () => {
  it('returns matching articles', async () => {
    const r = await makeFakeConnector(articles).search('vpn', 5)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('a1')
  })

  it('respects the limit', async () => {
    expect(await makeFakeConnector(articles).search('e', 1)).toHaveLength(1)
  })

  it('returns an empty array rather than throwing when nothing matches', async () => {
    expect(await makeFakeConnector(articles).search('zzzznomatch', 5)).toEqual([])
  })

  it('reports health', async () => {
    expect((await makeFakeConnector(articles).health()).ok).toBe(true)
  })
})
