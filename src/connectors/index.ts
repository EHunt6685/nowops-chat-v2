import type { Config } from '../config.js'
import type { KnowledgeConnector } from './types.js'
import { makeServiceNowConnector } from './servicenow/search.js'

/** The only place a concrete connector is named. Adding Jira means adding a case here. */
export function getConnector(cfg: Config): KnowledgeConnector {
  switch (cfg.connector) {
    case 'servicenow':
      return makeServiceNowConnector(cfg)
    default:
      throw new Error(`Unknown CONNECTOR '${cfg.connector}'. Implemented: servicenow.`)
  }
}
