import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createUser, createConversation, createPublicTopic, createMessage } from '../../utils/agentTestHelpers.js'
import { Agent, Channel } from '../../../src/models/index.js'
import { AgentMessageActions, ConversationHistory } from '../../../src/types/index.types.js'
import { verifyHandoffToken } from '../../../src/services/handoffToken.service.js'
import config from '../../../src/config/config.js'

type Block = Record<string, unknown>
type ActionElement = { type: string; text: { text: string }; url: string }
type ActionsBlock = { type: 'actions'; elements: ActionElement[] }

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
    /* evaluate() always returns CONTRIBUTE for any message on the setup
       channel. The "should the bot actually reply?" decision is deferred to
       checkEventSetupIntent inside respond(), which uses an LLM. This
       matches the pattern used by chatbot and eventHistorian: evaluate marks
       every message as a contribution so the agent is considered for
       respond(), then respond() decides whether to post. */
    it('returns CONTRIBUTE for any message on the setup channel', async () => {
      const setupMsg = await evaluate('I want to setup a new event')
      expect(setupMsg.action).toBe(AgentMessageActions.CONTRIBUTE)

      const casualMsg = await evaluate('Good morning everyone!')
      expect(casualMsg.action).toBe(AgentMessageActions.CONTRIBUTE)
    })
  })

  describe('respond()', () => {
    /* The DB-backed createMessage helper does not set source.type='slack',
       so to exercise the Slack-handoff branch we attach a Slack-shaped envelope
       to the message before calling respond. */
    /* eslint-disable no-param-reassign */
    function asSlackMessage(msg, { teamId = 'T123ABC', userId = 'U456DEF', channelId = 'C789GHI' } = {}) {
      /* Slack identity goes in source — that's what survives the DB
         round-trip. The adapter stores these fields there so respond()
         can read them from the persisted message. */
      msg.source = { type: 'slack', id: '1700000000.000100', userId, teamId, channelId }
      return msg
    }
    /* eslint-enable no-param-reassign */

    it("returns a Block Kit response with a Let's Go button carrying a verifiable token", async () => {
      const msg = await createMessage('setup a new event', user1, conversation, ['setup'])
      asSlackMessage(msg)
      const history = buildHistory([])
      const responses = await defaultAgentTypes.eventSetup.respond.call(agent, history, msg)

      expect(responses).toHaveLength(1)
      expect(responses[0].visible).toBe(true)
      expect(responses[0].messageType).toBe('text')

      /* The token lives in the button URL (inside blocks), not in the
         fallback message text. URL fragment keeps it out of server logs. */
      const { blocks } = responses[0]
      expect(blocks).toBeDefined()
      const actionsBlock = (blocks as Block[]).find((b): b is ActionsBlock => b.type === 'actions') as ActionsBlock
      const buttonUrl: string = actionsBlock.elements[0].url
      expect(buttonUrl).toContain(`${config.appHost}/events/new#token=`)

      const match = buttonUrl.match(/#token=([A-Za-z0-9._-]+)/)
      const token = decodeURIComponent(match![1])
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
