import slackClientPool from '../../src/adapters/slack/client.js'

describe('slack client cache', () => {
  beforeEach(() => {
    slackClientPool.clear()
  })

  it('returns the same WebClient instance when called twice with the same bot token', () => {
    const a = slackClientPool.getClient('xoxb-token-1')
    const b = slackClientPool.getClient('xoxb-token-1')
    expect(a).toBe(b)
  })

  it('returns distinct WebClient instances for two different bot tokens in the same workspace', () => {
    // Two bots (e.g. Berkie and VA) installed in the same Slack workspace must get
    // separate clients, since the cache key is the bot token, not the workspace.
    const berkie = slackClientPool.getClient('xoxb-berkie-token')
    const va = slackClientPool.getClient('xoxb-va-token')
    expect(berkie).not.toBe(va)
  })
})
