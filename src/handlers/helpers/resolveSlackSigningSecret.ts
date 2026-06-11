import config from '../../config/config.js'
import logger from '../../config/logger.js'

/**
 * Pick the Slack signing secret used to validate a bot's webhook signature.
 *
 * Each bot can store its own secret on its database row. If a bot doesn't
 * have one, this falls back to the global env-var secret and logs a warning
 * so the gap is visible. Once every bot has its own secret stored, the
 * env-var fallback can be removed.
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
