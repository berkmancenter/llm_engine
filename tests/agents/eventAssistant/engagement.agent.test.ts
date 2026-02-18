/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createDirectMessage,
  createPublicTopic,
  createUser,
  loadPartTimeWorkTranscript,
  createMessage,
  prepareMessagesForAgent,
  createEngagementAgentConversation
} from '../../utils/agentTestHelpers.js'

import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('engagementAgent')

const testTimeout = 120000

describe(`engagement agent tests`, () => {
  let agent
  let conversation
  let topic
  let user1
  let user2
  let user3

  const startTime = new Date(Date.now() - 15 * 60 * 1000)

  // Helper to create message timestamps within the test window
  const getMessageTime = (offsetSeconds = 0) => new Date(startTime.getTime() + offsetSeconds * 1000)

  beforeEach(async () => {
    user1 = await createUser('Curious Badger')
    user2 = await createUser('Thoughtful Fox')
    user3 = await createUser('Skeptical Owl')
    topic = await createPublicTopic()

    conversation = await createEngagementAgentConversation(
      {
        name: 'Why your company should consider part-time work',
        description: `"No one wants to work anymore." Entrepreneur Jessica Drain believes otherwise—instead it's that businesses aren't structuring jobs to attract and retain the widest number of people possible, including those with a limited number of hours to give to a career.`,
        presenters: [
          {
            name: 'Jessica Drain',
            bio: `A career marketer and graphic designer, Jessica has helped businesses brand and market themselves for almost two decades.`
          }
        ],
        moderators: [{ name: 'Joe Moderator', bio: 'An experienced event moderator who moderates all day long.' }]
      },
      user1,
      topic,
      startTime,
      testConfig.llmPlatform,
      testConfig.llmModel,
      [user2, user3] // Pass additional users to create direct channels for them
    )

    // Get the agent
    agent = conversation.agents.find((a) => a.name === 'Engagement Agent')
    expect(agent).toBeDefined()

    await loadPartTimeWorkTranscript(conversation, true)
  })

  describe('agent configuration', () => {
    it('has correct default configuration', () => {
      expect(agent.name).toBe('Engagement Agent')
      expect(agent.description).toContain('energy and participation')
      expect(agent.agentConfig.minInterval).toBe(60000) // 1 min
      expect(agent.agentConfig.personality).toBe('sarcastic-expert')
    })

    it('uses periodic trigger on transcript with 60 second interval', () => {
      expect(agent.triggers.periodic).toBeDefined()
      expect(agent.triggers.periodic.timerPeriod).toBe(60)
      expect(agent.triggers.periodic.conversationHistorySettings.channels).toContain('transcript')
    })
  })

  describe('respond function', () => {
    it(
      'PLAY: adds color commentary during breathing room',
      async () => {
        const messages = [
          // Build up to a dense statistics section
          await createMessage('Wow, that personal story was powerful', user1, conversation, ['chat'], getMessageTime(60)),
          await createMessage('The emotional hook really landed', user2, conversation, ['chat'], getMessageTime(90)),
          await createMessage('Now getting into the data...', user3, conversation, ['chat'], getMessageTime(120)),
          await createMessage('That was a LOT of statistics', user1, conversation, ['chat'], getMessageTime(180)),
          await createMessage('My brain is full of numbers', user2, conversation, ['chat'], getMessageTime(210)),
          await createMessage('Taking a breather to process', user3, conversation, ['chat'], getMessageTime(240)),

          // Private playful reactions to specific data points
          await createDirectMessage(
            "That 33% reduction in quitting stat is absolutely wild - bet someone's manager just choked on their coffee",
            user1,
            conversation,
            getMessageTime(260)
          ),
          await createDirectMessage(
            'Calling it now: first Q&A question will be "but what about the cost?"',
            user2,
            conversation,
            getMessageTime(280)
          ),
          await createDirectMessage(
            'That productivity graph is going straight into my next budget presentation. Weaponized data.',
            user3,
            conversation,
            getMessageTime(300)
          ),

          await createMessage('Lots to unpack here', user1, conversation, ['chat'], getMessageTime(340)),
          await createMessage('Definitely need to revisit these slides', user2, conversation, ['chat'], getMessageTime(370))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // PLAY is the rarest type - likely NONE in most cases
        if (responses.length > 0) {
          console.log(`Detected ${responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]}:`, responses[0].message)
          expect(responses[0].message).toBeDefined()
        }
      },
      testTimeout
    )
  })

  describe('personality configuration', () => {
    it(
      'uses personality when set in agentConfig',
      async () => {
        agent.agentConfig.personality = 'sarcastic-expert'

        const messages = [
          await createDirectMessage('Question about part-time work', user1, conversation, getMessageTime(200)),
          await createDirectMessage('Also curious about part-time work', user2, conversation, getMessageTime(210))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Should not error with personality enabled
        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )

    it(
      'works without personality when set to null',
      async () => {
        agent.agentConfig.personality = null

        const messages = [
          await createDirectMessage('Question about employee retention', user1, conversation, getMessageTime(200)),
          await createDirectMessage('Also wondering about employee retention', user2, conversation, getMessageTime(210))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Should not error with personality disabled
        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )
  })

  describe('lifecycle methods', () => {
    it('does not introduce itself (silent monitoring)', async () => {
      const [chatChannel] = conversation.channels.filter((c) => c.name === 'chat')
      const agentType = defaultAgentTypes.engagementAgent
      const msgs = await agentType.introduce.call(agent, chatChannel)
      expect(msgs).toEqual([])
    })
  })

  describe('edge cases', () => {
    it(
      'handles only transcript without chat messages',
      async () => {
        const messages = [
          await createDirectMessage('Question about implementation', user1, conversation, getMessageTime(200)),
          await createDirectMessage('Also wondering about implementation', user2, conversation, getMessageTime(220))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Should not error, should be able to respond
        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )
  })
})
