/** Masks a secret for logs: sk-abcdefghijklmnop -> sk-ab…mnop */
export function mask(secret: string): string {
  if (!secret || secret.length < 12) return '…'
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`
}

/** One-line JSON log. Callers never pass a secret; anything that must appear goes through mask(). */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
}
