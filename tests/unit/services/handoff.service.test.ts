import jwt from 'jsonwebtoken'
import config from '../../../src/config/config.js'
import tokenTypes from '../../../src/config/tokens.js'
import { mintHandoffToken, verifyHandoffToken } from '../../../src/services/handoff.service.js'

describe('handoff service', () => {
  const params = {
    platform: 'slack',
    context: { userId: 'U123', teamId: 'T456', extra: 'data' }
  }

  test('roundtrips platform and context through mint + verify', () => {
    const token = mintHandoffToken(params)
    const verified = verifyHandoffToken(token)

    expect(verified.platform).toBe(params.platform)
    expect(verified.context).toEqual(params.context)
  })

  test('mints a unique jti on each call', () => {
    const decoded1 = jwt.decode(mintHandoffToken(params)) as { jti?: string }
    const decoded2 = jwt.decode(mintHandoffToken(params)) as { jti?: string }

    expect(decoded1.jti).toBeTruthy()
    expect(decoded1.jti).not.toBe(decoded2.jti)
  })

  test('rejects a token signed with a different type claim (cross-context replay)', () => {
    /* A valid JWT against the same secret but with the access-token type must
       be refused — signature alone is not sufficient to accept a token. */
    const wrongTypeToken = jwt.sign(
      {
        ...params,
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
        ...params,
        type: tokenTypes.HANDOFF,
        exp: Math.floor(Date.now() / 1000) - 60
      },
      config.jwt.secret
    )

    expect(() => verifyHandoffToken(expiredToken)).toThrow()
  })

  test('rejects a tampered token', () => {
    const token = mintHandoffToken(params)
    /* Flip the final signature character to invalidate the HMAC. */
    const lastChar = token.slice(-1)
    const swap = lastChar === 'A' ? 'B' : 'A'
    const tampered = token.slice(0, -1) + swap

    expect(() => verifyHandoffToken(tampered)).toThrow()
  })
})
