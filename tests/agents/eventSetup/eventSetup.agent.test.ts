import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createUser, createConversation, createPublicTopic, createMessage } from '../../utils/agentTestHelpers.js'
import { Agent, Channel } from '../../../src/models/index.js'
import { AgentMessageActions, ConversationHistory } from '../../../src/types/index.types.js'
import { verifyHandoffToken } from '../../../src/services/handoffToken.service.js'
import config from '../../../src/config/config.js'

jest.setTimeout(30000)

const testConfig = setupAgentTest('eventSetup')

const BOT_NAME = 'Event Setup Bot'

describe('eventSetup agent tests', () => {
  let agent
  let conversation
  let topic
  let user1

  async function createEventSetupConversation() {
    const conv = await createConversation({ name: 'Event Setup Test Conversation' }, user1, topic)
    const testAgent = new Agent({
      agentType: 'eventSetup',
      conversation: conv,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel,
      agentConfig: { botName: BOT_NAME }
    })
    const channels = await Channel.create([{ name: 'setup' }])
    conv.channels.push(...channels)
    await testAgent.save()
    conv.agents.push(testAgent)
    await conv.save()
    await testAgent.start()
    return { conv, testAgent }
  }

  beforeEach(async () => {
    topic = await createPublicTopic()
    user1 = await createUser('Alice')
    const result = await createEventSetupConversation()
    conversation = result.conv
    agent = result.testAgent
  })

  function buildHistory(messages): ConversationHistory {
    return {
      start: new Date(Date.now() - 60 * 60 * 1000),
      end: new Date(),
      messages
    }
  }

  async function evaluate(body, user = user1) {
    const msg = await createMessage(body, user, conversation, ['setup'])
    return defaultAgentTypes.eventSetup.evaluate.call(agent, msg)
  }

  describe('evaluate()', () => {
    it('returns CONTRIBUTE when message contains "setup"', async () => {
      const result = await evaluate('I want to setup a new event')
      expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('returns CONTRIBUTE when message contains "create event" or "create an event"', async () => {
      const withoutArticle = await evaluate('Can you create event for next Thursday?')
      expect(withoutArticle.action).toBe(AgentMessageActions.CONTRIBUTE)

      const withArticle = await evaluate('Can you create an event for next Thursday?')
      expect(withArticle.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('returns CONTRIBUTE when message contains "new event"', async () => {
      const result = await evaluate('Let us kick off a new event about AI')
      expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('returns CONTRIBUTE when message is a direct @mention', async () => {
      const result = await evaluate(`@${BOT_NAME} can you help me?`)
      expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('returns OK when message has no setup intent', async () => {
      const result = await evaluate('Good morning everyone!')
      expect(result.action).toBe(AgentMessageActions.OK)
    })
  })

  describe('respond()', () => {
    /* The DB-backed createMessage helper does not set source.type='slack',
       so to exercise the Slack-handoff branch we attach a Slack-shaped envelope
       to the message before calling respond. */
    /* eslint-disable no-param-reassign */
    function asSlackMessage(msg, { teamId = 'T123ABC', userId = 'U456DEF', channelId = 'C789GHI' } = {}) {
      msg.source = { type: 'slack', id: '1700000000.000100' }
      msg.user = { username: `${teamId}-${userId}`, pseudonym: userId }
      msg.channels = [{ name: channelId }]
      return msg
    }
    /* eslint-enable no-param-reassign */

    it('returns a Nextspace handoff URL with a verifiable token', async () => {
      const msg = await createMessage('setup a new event', user1, conversation, ['setup'])
      asSlackMessage(msg)
      const history = buildHistory([])
      const responses = await defaultAgentTypes.eventSetup.respond.call(agent, history, msg)

      expect(responses).toHaveLength(1)
      expect(responses[0].visible).toBe(true)
      expect(responses[0].messageType).toBe('text')
      /* Token lives in the URL fragment so it never reaches the server's
         access logs. See eventSetup.ts for the reasoning. */
      expect(responses[0].message).toContain(`${config.appHost}/events/new#token=`)

      const match = responses[0].message.match(/#token=([A-Za-z0-9._-]+)/)
      const token = decodeURIComponent(match[1])
      const verified = verifyHandoffToken(token)
      expect(verified.slackUserId).toBe('U456DEF')
    })

    it('routes the response to the setup channel', async () => {
      const msg = await createMessage('setup a new event', user1, conversation, ['setup'])
      asSlackMessage(msg)
      const history = buildHistory([])
      const responses = await defaultAgentTypes.eventSetup.respond.call(agent, history, msg)

      const channelNames = responses[0].channels.map((c) => c.name)
      expect(channelNames).toContain('setup')
    })
  })
})
