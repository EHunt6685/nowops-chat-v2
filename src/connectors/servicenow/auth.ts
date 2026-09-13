import type { Config } from '../../config.js'
import { PlatformUnavailableError } from '../types.js'
import { log } from '../../log.js'

/** Refresh a minute early so a token never expires mid-request. */
const EXPIRY_SAFETY_SECONDS = 60

export function makeTokenProvider(cfg: Config, fetchImpl: typeof fetch = fetch) {
  let token: string | null = null
  let expiresAt = 0

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
      })
    } catch (e) {
      throw new PlatformUnavailableError(
        `Cannot reach ${cfg.sn.instanceUrl} to refresh the access token.`,
        e,
      )
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new PlatformUnavailableError(
        `ServiceNow rejected the refresh token (HTTP ${res.status}). ` +
          `Refresh tokens last ~100 days and may have expired. ` +
          `Fix: run Connect-SnOAuth -Instance abhrademo4, then Export-SnEnvFile. ${detail}`,
      )
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!json.access_token) {
      throw new PlatformUnavailableError('Token endpoint returned no access_token.')
    }

    token = json.access_token
    expiresAt = Date.now() + ((json.expires_in ?? 1800) - EXPIRY_SAFETY_SECONDS) * 1000
    log('sn.token.refreshed', { expiresInSec: json.expires_in ?? 1800 })
    return token
  }

  return {
    async getToken(): Promise<string> {
      if (token && Date.now() < expiresAt) return token
      return refresh()
    },
  }
}
