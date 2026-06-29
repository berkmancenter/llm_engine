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
    // Two bots installed in the same Slack workspace must get separate clients. The cache
    // keys on the bot token so the bots can't collide on each other's connections.
    const firstBot = slackClientPool.getClient('xoxb-first-bot-token')
    const secondBot = slackClientPool.getClient('xoxb-second-bot-token')
    expect(firstBot).not.toBe(secondBot)
  })
})
