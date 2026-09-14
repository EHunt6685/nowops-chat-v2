import type { Config } from '../config.js'
import { ServiceNowUnavailableError } from './types.js'
import { log } from '../log.js'

/** Refresh a minute early so a token never expires mid-request. */
const EXPIRY_SAFETY_SECONDS = 60
/** One slow search or one pathological filter must not hang a chat turn. Not configurable. */
const TIMEOUT_MS = 10_000

export interface SnClient {
  instanceUrl: string
  /** Authenticated GET. Throws ServiceNowUnavailableError for anything but a 2xx JSON body. */
  get<T>(path: string): Promise<T>
}

export function makeSnClient(cfg: Config, fetchImpl: typeof fetch = fetch): SnClient {
  let token: string | null = null
  let expiresAt = 0
  let inflight: Promise<string> | null = null

  async function refresh(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.sn.refreshToken,
      client_id: cfg.sn.clientId,
      client_secret: cfg.sn.clientSecret,
    })

    let res: Response
    try {
      res = await fetchImpl(`${cfg.sn.instanceUrl}/oauth_token.do`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      throw new ServiceNowUnavailableError(
        `Cannot reach ${cfg.sn.instanceUrl} to refresh the access token.`, e,
      )
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new ServiceNowUnavailableError(
        `ServiceNow rejected the refresh token (HTTP ${res.status}). ` +
          `Refresh tokens last ~100 days and may have expired. ` +
          `Fix: run Connect-SnOAuth -Instance abhrademo4, then Export-SnEnvFile. ${detail}`,
      )
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!json.access_token) {
      throw new ServiceNowUnavailableError('Token endpoint returned no access_token.')
    }

    token = json.access_token
    expiresAt = Date.now() + ((json.expires_in ?? 1800) - EXPIRY_SAFETY_SECONDS) * 1000
    log('sn.token.refreshed', { expiresInSec: json.expires_in ?? 1800 })
    return token
  }

  function getToken(): Promise<string> {
    if (token && Date.now() < expiresAt) return Promise.resolve(token)
    // Concurrent callers share one refresh rather than each firing their own.
    if (inflight) return inflight
    inflight = refresh().finally(() => { inflight = null })
    return inflight
  }

  return {
    instanceUrl: cfg.sn.instanceUrl,

    async get<T>(path: string): Promise<T> {
      const bearer = await getToken()
      let res: Response
      try {
        res = await fetchImpl(`${cfg.sn.instanceUrl}${path}`, {
          headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (e) {
        throw new ServiceNowUnavailableError(`Cannot reach ${cfg.sn.instanceUrl}.`, e)
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new ServiceNowUnavailableError(
          `ServiceNow request failed (HTTP ${res.status}). ${detail.slice(0, 200)}`,
        )
      }
      return (await res.json()) as T
    },
  }
}
