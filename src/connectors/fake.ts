import type { Article, KnowledgeConnector } from './types.js'

/** In-memory connector for tests and for proving the seam is real. */
export function makeFakeConnector(articles: Article[]): KnowledgeConnector {
  return {
    name: 'fake',
    async search(query: string, limit: number): Promise<Article[]> {
      const q = query.toLowerCase()
      return articles
        .filter((a) => `${a.title} ${a.body}`.toLowerCase().includes(q))
        .slice(0, limit)
    },
    async health() {
      return { ok: true, detail: `fake connector, ${articles.length} articles` }
    },
  }
}
