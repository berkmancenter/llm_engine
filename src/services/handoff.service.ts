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
  /* Explicit algorithm allowlist: rejects anything other than HS256, including 'none'. */
  const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as HandoffPayload
  /* Type guard: prevents auth and refresh tokens from being replayed as handoff tokens. */
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
