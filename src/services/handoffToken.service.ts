/*
 * Issues the signed link the Slack bot sends to an organizer who asks to
 * create an event, and validates that link when the organizer clicks
 * through to the Nextspace event-creation form.
 *
 * The link looks like https://nextspace.example/events/new?token=<jwt>.
 * The token carries the originating Slack context (user, team, channel,
 * thread timestamp) so once the event is created we know which Slack
 * thread to post the confirmation back into.
 *
 * The token has to be unforgeable because the form trusts whatever it
 * says about Slack identity. We sign it with the same JWT secret used
 * elsewhere in the server, and tag every token with type='slackHandoff'
 * so a leaked auth-session JWT cannot be replayed here (and vice versa).
 * Tokens expire after HANDOFF_TOKEN_EXPIRATION_MINUTES because the link
 * is meant to be clicked within the hour, not saved for later.
 *
 * Verification is stateless: signature + type + expiry, no DB lookup.
 * Each token includes a random jti so we can add a revocation blacklist
 * later if we ever need to invalidate a token before it expires; that
 * blacklist does not exist yet.
 */

import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import moment from 'moment'
import config from '../config/config.js'
import tokenTypes from '../config/tokens.js'

export interface SlackHandoffContext {
  slackUserId: string
  slackTeamId: string
  slackChannelId: string
  slackThreadTs: string
}

export interface VerifiedHandoff extends SlackHandoffContext {
  jti: string
}

interface HandoffPayload extends SlackHandoffContext {
  jti: string
  type: string
  iat: number
  exp: number
}

export const mintHandoffToken = (context: SlackHandoffContext): string => {
  const expires = moment().add(config.jwt.handoffExpirationMinutes, 'minutes')
  const payload = {
    ...context,
    jti: randomUUID(),
    type: tokenTypes.SLACK_HANDOFF,
    iat: moment().unix(),
    exp: expires.unix()
  }
  return jwt.sign(payload, config.jwt.secret)
}

export const verifyHandoffToken = (token: string): VerifiedHandoff => {
  const payload = jwt.verify(token, config.jwt.secret) as HandoffPayload
  if (payload.type !== tokenTypes.SLACK_HANDOFF) {
    throw new Error('Invalid token type for handoff')
  }
  return {
    slackUserId: payload.slackUserId,
    slackTeamId: payload.slackTeamId,
    slackChannelId: payload.slackChannelId,
    slackThreadTs: payload.slackThreadTs,
    jti: payload.jti
  }
}

export default { mintHandoffToken, verifyHandoffToken }
