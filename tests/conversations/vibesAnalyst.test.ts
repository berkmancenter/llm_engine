import resolveConversationType from '../../src/conversations/resolver.js'
import { getConversationType } from '../../src/conversations/index.js'

describe('vibesAnalyst conversation type', () => {
  it('is registered and bundles the vibesAnalyst agent on Slack', () => {
    const type = getConversationType('vibesAnalyst')
    expect(type).toBeDefined()
    expect(type?.platforms.some((platform) => platform.name === 'slack')).toBe(true)
    expect(type?.agents?.map((agent) => agent.name)).toEqual(['vibesAnalyst'])
  })

  it('resolves Slack properties into the adapter config', () => {
    const type = getConversationType('vibesAnalyst')!
    const result = resolveConversationType(
      {
        platforms: ['slack'],
        properties: {
          slackChannel: 'C123',
          slackWorkspace: 'T123',
          slackBotToken: 'xoxb-abc',
          slackSigningSecret: 'shhh',
          slackAppKey: 'va-dev',
          botName: 'Vibes Analyst'
        }
      },
      type
    )

    expect(result.adapters).toHaveLength(1)
    expect(result.adapters[0]).toMatchObject({
      type: 'slack',
      config: {
        channel: 'C123',
        workspace: 'T123',
        botToken: 'xoxb-abc',
        signingSecret: 'shhh',
        appKey: 'va-dev',
        botName: 'Vibes Analyst'
      }
    })
  })
})
