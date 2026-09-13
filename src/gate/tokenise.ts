const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','to','of','in','on','for','and','or','it','this',
  'that','with','my','we','our','not','no','be','been','has','have','do','does','did','can',
  'cannot','am','at','as','by','from','get','got','will','would','should','when','what','why',
  'how','after','into','out','up','down','me','you','your','their','there','they',
])

/**
 * Lowercase, strip punctuation, drop stopwords and 1-2 character tokens.
 * `$`, `.`, `-` and `_` survive so error codes stay intact.
 */
export function tokenise(s: string): string[] {
  if (!s) return []
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$._\- ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

/** Fraction of the query's distinct meaningful terms that appear in the document. */
export function coverage(query: string, doc: string): number {
  const terms = [...new Set(tokenise(query))]
  if (terms.length === 0) return 0
  const haystack = doc.toLowerCase()
  const hits = terms.filter((t) => haystack.includes(t)).length
  return Math.round((hits / terms.length) * 100) / 100
}
