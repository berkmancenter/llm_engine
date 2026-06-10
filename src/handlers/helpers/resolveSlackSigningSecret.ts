import config from '../../config/config.js'
import logger from '../../config/logger.js'

/**
 * Resolve the Slack signing secret to validate a webhook against.
 *
 * Precedence: per-adapter `config.signingSecret` first, then the global
 * env-var secret (`config.slack.signingSecret`). The env-var fallback exists
 * so Berkie keeps working during the rollout. Once every Slack-backed
 * adapter has its own row-stored secret, the env var (and this fallback)
 * can be deleted. A deprecation warning fires each time we fall through so
 * the cutover progress is visible in logs.
 */
export default function resolveSlackSigningSecret(adapter: { config?: Record<string, unknown> } | null | undefined): string {
  const adapterSecret = adapter?.config?.signingSecret
  if (typeof adapterSecret === 'string' && adapterSecret) return adapterSecret

  if (config.slack.signingSecret) {
    logger.warn(
      'Falling back to global SLACK_SIGNING_SECRET env var. Set adapter.config.signingSecret per bot and remove the env var when rollout is complete.'
    )
    return config.slack.signingSecret
  }

  throw new Error('No Slack signing secret available: set adapter.config.signingSecret or the SLACK_SIGNING_SECRET env var.')
}
