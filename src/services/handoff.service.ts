/*
 * Issues and validates signed handoff tokens used when an agent hands control
 * to another part of the system to complete a task.
 *
 * A handoff token is a short-lived JWT that carries a platform identifier and
 * an opaque context blob. The platform identifies which adapter minted the
 * token (e.g. 'slack', 'web'). The context is whatever the minting adapter
 * needs to resume work after the handoff resolves — the service treats it as
 * opaque data and neither reads nor validates its contents.
 *
 * Tokens are signed with HS256 and expire after HANDOFF_TOKEN_EXPIRATION_MINUTES.
 * The type claim ('handoff') prevents tokens from other flows (auth, refresh)
 * being replayed here. Each token carries a random jti so a revocation
 * blacklist can be added later without changing the token format.
 */

import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import moment from 'moment'
import config from '../config/config.js'
import tokenTypes from '../config/tokens.js'

export interface HandoffContext {
  platform: string
  context: Record<string, unknown>
}

export interface VerifiedHandoffContext extends HandoffContext {
  jti: string
}

interface HandoffPayload extends HandoffContext {
  jti: string
  type: string
  iat: number
  exp: number
}

export const mintHandoffToken = (params: HandoffContext): string => {
  const expires = moment().add(config.jwt.handoffExpirationMinutes, 'minutes')
  const payload: HandoffPayload = {
    platform: params.platform,
    context: params.context,
    jti: randomUUID(),
    type: tokenTypes.HANDOFF,
    iat: moment().unix(),
    exp: expires.unix()
  }
  /* Pin to HS256 so the algorithm can't be negotiated from the token header. */
  return jwt.sign(payload, config.jwt.secret, { algorithm: 'HS256' })
}

export const verifyHandoffToken = (token: string): VerifiedHandoffContext => {
  /* Explicit algorithm allowlist: rejects tokens signed with anything else,
     including 'none'. The type check is a second layer so tokens from other
     flows can't be replayed against this one. */
  const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as HandoffPayload
  if (payload.type !== tokenTypes.HANDOFF) {
    throw new Error('Invalid token type for handoff')
  }
  return {
    platform: payload.platform,
    context: payload.context,
    jti: payload.jti
  }
}

export default { mintHandoffToken, verifyHandoffToken }
