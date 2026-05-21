import jwt from 'jsonwebtoken'
import config from '../../../src/config/config.js'
import tokenTypes from '../../../src/config/tokens.js'
import { mintHandoffToken, verifyHandoffToken } from '../../../src/services/handoffToken.service.js'

describe('handoffToken service', () => {
  const context = {
    slackUserId: 'U123ABC',
    slackTeamId: 'T456DEF',
    slackChannelId: 'C789GHI',
    slackThreadTs: '1700000000.000100'
  }

  test('roundtrips Slack context through mint + verify', () => {
    const token = mintHandoffToken(context)
    const verified = verifyHandoffToken(token)

    expect(verified.slackUserId).toBe(context.slackUserId)
    expect(verified.slackTeamId).toBe(context.slackTeamId)
    expect(verified.slackChannelId).toBe(context.slackChannelId)
    expect(verified.slackThreadTs).toBe(context.slackThreadTs)
  })

  test('mints a unique jti on each call', () => {
    const decoded1 = jwt.decode(mintHandoffToken(context)) as { jti?: string }
    const decoded2 = jwt.decode(mintHandoffToken(context)) as { jti?: string }

    expect(decoded1.jti).toBeTruthy()
    expect(decoded1.jti).not.toBe(decoded2.jti)
  })

  test('rejects a token signed with a different type claim (cross-context replay)', () => {
    /* Sign a valid JWT against the same secret but with the access-token
       type. Verifier must refuse: signature alone is not sufficient. */
    const wrongTypeToken = jwt.sign(
      {
        ...context,
        type: tokenTypes.ACCESS,
        exp: Math.floor(Date.now() / 1000) + 3600
      },
      config.jwt.secret
    )

    expect(() => verifyHandoffToken(wrongTypeToken)).toThrow(/type/i)
  })

  test('rejects an expired token', () => {
    const expiredToken = jwt.sign(
      {
        ...context,
        type: tokenTypes.SLACK_HANDOFF,
        exp: Math.floor(Date.now() / 1000) - 60
      },
      config.jwt.secret
    )

    expect(() => verifyHandoffToken(expiredToken)).toThrow()
  })

  test('rejects a tampered token', () => {
    const token = mintHandoffToken(context)
    /* Flip the final signature character to invalidate the HMAC. */
    const lastChar = token.slice(-1)
    const swap = lastChar === 'A' ? 'B' : 'A'
    const tampered = token.slice(0, -1) + swap

    expect(() => verifyHandoffToken(tampered)).toThrow()
  })
})
