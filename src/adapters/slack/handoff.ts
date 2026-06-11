/*
 * Slack-specific handoff helpers. Wraps the platform-neutral handoff.service
 * so callers deal in concrete Slack field names (slackUserId, slackTeamId,
 * etc.) without knowing about the generic context envelope underneath.
 *
 * The verified result is deliberately flat (not wrapped in a context envelope)
 * so middleware and route handlers can read req.handoff.slackUserId directly.
 */

import { mintHandoffToken, verifyHandoffToken } from '../../services/handoff.service.js'

export interface SlackHandoffContext {
  slackUserId: string
  slackTeamId: string
  slackChannelId: string
  slackThreadTs: string
}

export type VerifiedSlackHandoff = SlackHandoffContext & { jti: string }

export const mintSlackHandoffToken = (context: SlackHandoffContext): string =>
  mintHandoffToken({ platform: 'slack', context: context as unknown as Record<string, unknown> })

export const verifySlackHandoffToken = (token: string): VerifiedSlackHandoff => {
  const verified = verifyHandoffToken(token)
  const ctx = verified.context as unknown as SlackHandoffContext
  return {
    slackUserId: ctx.slackUserId,
    slackTeamId: ctx.slackTeamId,
    slackChannelId: ctx.slackChannelId,
    slackThreadTs: ctx.slackThreadTs,
    jti: verified.jti
  }
}
