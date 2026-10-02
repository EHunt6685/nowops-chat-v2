import type { Article } from './servicenow/types.js'
import { tokenise } from './guard.js'

/**
 * Relevance floor for knowledge search. The instance returns its nearest article however weak
 * the match, so an article reaches the model only if it shares a real word with the question.
 * The model is still told to decline when CONTEXT does not answer; this makes the empty case mechanical.
 */
export function relevant(question: string, articles: Article[]): Article[] {
  const terms = tokenise(question).filter((t) => t.length >= 4 && !STOP.has(t))
  if (!terms.length) return articles
  return articles.filter((a) => { const hay = `${a.title} ${a.body}`.toLowerCase(); return terms.some((t) => hay.includes(t)) })
}
const STOP = new Set(['what', 'when', 'where', 'which', 'this', 'that', 'there', 'with', 'from', 'have', 'does', 'many', 'much', 'about', 'please', 'tell', 'show', 'give', 'know', 'want', 'need', 'help', 'into', 'your', 'their', 'them', 'they', 'will', 'would', 'could', 'should'])
