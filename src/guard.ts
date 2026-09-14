/**
 * Lowercase, strip punctuation, drop 1-2 character tokens.
 * `$`, `.`, `-` and `_` survive so error codes stay intact.
 *
 * No stopword list. One was tried and it declined "how many incidents" for free,
 * because every word but one was a stopword. The guard exists for one-word noise
 * ("Hi Team,", "nan"); judging whether three real words are a question is the
 * model's job (D11 layer 2), not this function's.
 */
export function tokenise(s: string): string[] {
  if (!s) return []
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$._\- ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
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
