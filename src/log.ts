const SECRET_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'SN_CLIENT_SECRET',
  'SN_REFRESH_TOKEN',
  'SN_CLIENT_ID',
]

/** Masks a secret for logs: sk-abc123456789wxyz -> sk-ab…wxyz */
export function mask(secret: string): string {
  if (!secret || secret.length < 12) return '…'
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`
}

/** Single-line structured log. Values under known secret keys are masked. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    safe[k] = SECRET_ENV_NAMES.includes(k) && typeof v === 'string' ? mask(v) : v
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...safe }))
}
