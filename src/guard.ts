const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','to','of','in','on','for','and','or','it','this',
  'that','with','my','we','our','not','no','be','been','has','have','do','does','did','can',
  'cannot','am','at','as','by','from','get','got','will','would','should','when','what','why',
  'how','after','into','out','up','down','me','you','your','their','there','they','many',
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

/** Two real words. Not configurable: nobody has ever wanted a different number. */
const MIN_TOKENS = 2

/**
 * Gate layer 1 (D11). Runs before any network call, so greeting-shaped noise
 * never reaches the instance or the model. This is the only free rejection
 * left — everything else costs one Claude call.
 */
export function hasEnoughTokens(s: string): boolean {
  return tokenise(s).length >= MIN_TOKENS
}
