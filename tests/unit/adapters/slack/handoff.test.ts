import jwt from 'jsonwebtoken'
import config from '../../../../src/config/config.js'
import tokenTypes from '../../../../src/config/tokens.js'
import { mintSlackHandoffToken, verifySlackHandoffToken } from '../../../../src/adapters/slack/handoff.js'

describe('Slack handoff adapter', () => {
  const slackContext = {
    slackUserId: 'U123ABC',
    slackTeamId: 'T456DEF',
    slackChannelId: 'C789GHI',
    slackThreadTs: '1700000000.000100'
  }

  test('roundtrips Slack context through mint + verify', () => {
    const token = mintSlackHandoffToken(slackContext)
    const verified = verifySlackHandoffToken(token)

    expect(verified.slackUserId).toBe(slackContext.slackUserId)
    expect(verified.slackTeamId).toBe(slackContext.slackTeamId)
    expect(verified.slackChannelId).toBe(slackContext.slackChannelId)
    expect(verified.slackThreadTs).toBe(slackContext.slackThreadTs)
  })

  test('verified result is flat (no nested context field)', () => {
    const token = mintSlackHandoffToken(slackContext)
    const verified = verifySlackHandoffToken(token)

    /* Callers reading req.handoff.slackUserId depend on these fields being
       at the top level, not wrapped inside a context object. */
    expect('context' in verified).toBe(false)
  })

  test('jti is present in the verified result', () => {
    const token = mintSlackHandoffToken(slackContext)
    const verified = verifySlackHandoffToken(token)

    expect(verified.jti).toBeTruthy()
  })

  test('underlying JWT carries platform: slack', () => {
    const token = mintSlackHandoffToken(slackContext)
    const decoded = jwt.decode(token) as Record<string, unknown>

    expect(decoded.platform).toBe('slack')
  })

  test('rejects a token signed with the wrong type claim (cross-context replay)', () => {
    const wrongTypeToken = jwt.sign(
      { ...slackContext, type: tokenTypes.ACCESS, exp: Math.floor(Date.now() / 1000) + 3600 },
      config.jwt.secret
    )

    expect(() => verifySlackHandoffToken(wrongTypeToken)).toThrow()
  })
})
