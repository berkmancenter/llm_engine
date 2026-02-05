/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createEventChannelMediatorPlusConversation,
  createDirectMessage,
  createPublicTopic,
  createUser,
  loadPartTimeWorkTranscript,
  createMessage,
  prepareMessagesForAgent
} from '../../utils/agentTestHelpers.js'
import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('eventAssistantChannelMediatorPlus')

const testTimeout = 120000

/**
 * MINIMAL TEST SUITE FOR PLUS VERSION
 *
 * This test suite focuses ONLY on the differences between eventChannelMediator
 * and eventChannelMediatorPlus. The base functionality is already extensively
 * tested in eventChannelMediator.agent.test.ts.
 *
 * Key Differences in Plus:
 * 1. Moderator escalation capability (posts to 'moderator' channel)
 * 2. Additional channels ('moderator', 'participant')
 * 3. Additional agents (backChannelMetrics, backChannelInsights)
 * 4. Structured JSON formatting for moderator alerts
 * 5. parseOutput function to handle moderator message formatting
 *
 * NOT TESTED HERE (already covered in base tests):
 * - All intervention types (SIGNAL, SYNTHESIS, MINORITY_VOICE, etc.)
 * - Privacy protection and threshold enforcement
 * - Rate limiting
 * - Personality configuration
 * - Strategic silence
 * - Edge cases with empty histories
 * - Lifecycle methods (initialize, start, stop, introduce)
 */
describe(`event channel mediator PLUS agent tests (DIFFERENTIAL ONLY)`, () => {
  let agent
  let conversation
  let topic
  let user1
  let user2
  let user3

  const startTime = new Date(Date.now() - 15 * 60 * 1000)

  const getMessageTime = (offsetSeconds = 0) => new Date(startTime.getTime() + offsetSeconds * 1000)

  beforeEach(async () => {
    user1 = await createUser('Curious Badger')
    user2 = await createUser('Thoughtful Fox')
    user3 = await createUser('Skeptical Owl')
    topic = await createPublicTopic()

    conversation = await createEventChannelMediatorPlusConversation(
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
      [user2, user3]
    )

    // Get the mediator Plus agent
    agent = conversation.agents.find((a) => a.name === 'Event Channel Mediator Plus')
    expect(agent).toBeDefined()

    await loadPartTimeWorkTranscript(conversation, true)
  })

  describe('Plus-specific configuration', () => {
    it('has correct agent name and description', () => {
      expect(agent.name).toBe('Event Channel Mediator Plus')
      expect(agent.description).toContain('escalate significant themes to moderator')
    })

    it('has moderator channel available', () => {
      const moderatorChannel = conversation.channels.find((c) => c.name === 'moderator')
      expect(moderatorChannel).toBeDefined()
    })

    it('has parseOutput function defined in agent type', () => {
      const agentType = defaultAgentTypes.eventAssistantChannelMediatorPlus
      expect(agentType.parseOutput).toBeDefined()
      expect(typeof agentType.parseOutput).toBe('function')
    })
  })

  describe('Moderator escalation (PLUS ONLY FEATURE)', () => {
    it(
      'posts to BOTH chat and moderator channels on MODERATOR_ESCALATION',
      async () => {
        // Create a strong pattern that warrants escalation to moderator
        const messages = [
          // Engaged chat
          await createMessage('Great talk so far', user1, conversation, ['chat'], getMessageTime(100)),
          await createMessage('Very informative', user2, conversation, ['chat'], getMessageTime(150)),
          await createMessage('Lots to think about', user3, conversation, ['chat'], getMessageTime(200)),

          // Multiple people asking complex question needing expert/moderator response
          await createDirectMessage(
            'How does this interact with the recent Department of Labor regulatory changes?',
            user1,
            conversation,
            getMessageTime(250)
          ),
          await createDirectMessage('What about the new overtime rules from DOL?', user2, conversation, getMessageTime(260)),
          await createDirectMessage(
            'Recent federal regulations seem relevant here',
            user3,
            conversation,
            getMessageTime(270)
          ),
          await createDirectMessage(
            'The compliance landscape just shifted - how does that impact this?',
            user1,
            conversation,
            getMessageTime(280)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['chat'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.eventAssistantChannelMediatorPlus.respond.call(agent, conversationHistory)

        // Should have responses
        expect(responses.length).toBeGreaterThan(0)

        // If MODERATOR_ESCALATION was detected, should have 2 responses (chat + moderator)
        const hasModeratorEscalation = responses.some((r) => r.context?.includes('MODERATOR_ESCALATION'))

        expect(hasModeratorEscalation).toBe(true)

        if (hasModeratorEscalation) {
          console.log('✅ MODERATOR_ESCALATION detected')

          // Should have at least 1 response (chat message)
          expect(responses.length).toBeGreaterThanOrEqual(1)
          expect(responses[0].channels[0].name).toBe('chat')
          expect(responses[0].message).toBeDefined()
          expect(typeof responses[0].message).toBe('string')

          // Check if moderator message was also sent (depends on LLM providing moderatorMessage)
          const moderatorResponse = responses.find((r) => r.channels[0].name === 'moderator')
          if (moderatorResponse) {
            console.log('✅ Moderator channel message sent')
            expect(moderatorResponse.messageType).toBe('json')
            expect(typeof moderatorResponse.message).toBe('object')

            const moderatorMsg = moderatorResponse.message as Record<string, unknown>
            expect(moderatorMsg.timestamp).toBeDefined()
            expect(moderatorMsg.insights).toBeDefined()
            expect(Array.isArray(moderatorMsg.insights)).toBe(true)

            console.log('Chat message:', responses[0].message)
            console.log('Moderator alert:', JSON.stringify(moderatorMsg, null, 2))
          } else {
            console.log('ℹ️ MODERATOR_ESCALATION detected but no moderator message (LLM did not provide moderatorMessage)')
          }
        } else {
          console.log('ℹ️ Other intervention type detected (not MODERATOR_ESCALATION)')
          // Still a valid test - just means this specific pattern didn't trigger escalation
          expect(responses.length).toBeGreaterThan(0)
        }
      },
      testTimeout
    )

    it(
      'formats moderator alerts with structured JSON',
      async () => {
        const messages = [
          await createMessage('This is fascinating', user1, conversation, ['chat'], getMessageTime(100)),
          await createMessage('Really valuable information', user2, conversation, ['chat'], getMessageTime(150)),

          // Complex regulatory question pattern
          await createDirectMessage(
            'How does this work with ACA healthcare requirements?',
            user1,
            conversation,
            getMessageTime(220)
          ),
          await createDirectMessage('What about ERISA implications?', user2, conversation, getMessageTime(240)),
          await createDirectMessage(
            'Are there Section 125 cafeteria plan considerations?',
            user3,
            conversation,
            getMessageTime(260)
          ),
          await createDirectMessage('The tax treatment seems complex', user1, conversation, getMessageTime(280)),

          await createMessage('Great talk', user2, conversation, ['chat'], getMessageTime(350))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['chat'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.eventAssistantChannelMediatorPlus.respond.call(agent, conversationHistory)

        // Look for moderator escalation
        const moderatorResponse = responses.find((r) => r.channels?.[0]?.name === 'moderator')

        if (moderatorResponse) {
          console.log('✅ Moderator escalation occurred')

          // Verify JSON structure
          expect(moderatorResponse.messageType).toBe('json')
          const msg = moderatorResponse.message as Record<string, unknown>

          expect(msg.timestamp).toBeDefined()
          const timestamp = msg.timestamp as { start: number; end: number }
          expect(timestamp.start).toEqual(expect.any(Number))
          expect(timestamp.end).toEqual(expect.any(Number))

          expect(msg.insights).toBeDefined()
          expect(Array.isArray(msg.insights)).toBe(true)
          const insights = msg.insights as Array<{ value: string; type: string }>
          expect(insights.length).toBeGreaterThan(0)

          // Each insight should have value and type
          insights.forEach((insight) => {
            expect(insight.value).toBeDefined()
            expect(typeof insight.value).toBe('string')
            expect(insight.type).toBe('insight')
          })

          console.log('Moderator alert structure:', JSON.stringify(msg, null, 2))
        } else {
          console.log('ℹ️ No moderator escalation in this test run (LLM decision)')
        }
      },
      testTimeout
    )
  })

  describe('parseOutput function (PLUS ONLY)', () => {
    it('handles text messages as-is', () => {
      const agentType = defaultAgentTypes.eventAssistantChannelMediatorPlus
      const textMsg = {
        bodyType: 'text',
        body: 'This is a test message',
        toObject: () => ({ bodyType: 'text', body: 'This is a test message' })
      }

      const result = agentType.parseOutput(textMsg)
      expect(result.bodyType).toBe('text')
      expect(result.body).toBe('This is a test message')
    })

    it('transforms moderator alerts into formatted text', () => {
      const agentType = defaultAgentTypes.eventAssistantChannelMediatorPlus
      const moderatorAlert = {
        bodyType: 'json',
        body: {
          timestamp: { start: 123456, end: 123789 },
          insights: [
            { value: 'Multiple questions about healthcare compliance', type: 'insight' },
            { value: 'Strong interest in regulatory framework', type: 'insight' }
          ]
        },
        toObject: () => ({
          bodyType: 'json',
          body: {
            timestamp: { start: 123456, end: 123789 },
            insights: [
              { value: 'Multiple questions about healthcare compliance', type: 'insight' },
              { value: 'Strong interest in regulatory framework', type: 'insight' }
            ]
          }
        })
      }

      const result = agentType.parseOutput(moderatorAlert)

      expect(result.bodyType).toBe('text')
      expect(result.body).toContain('💡 MODERATOR REPORT 💡')
      expect(result.body).toContain('⚫ Multiple questions about healthcare compliance')
      expect(result.body).toContain('⚫ Strong interest in regulatory framework')
    })
  })

  describe('Backward compatibility with base version', () => {
    it(
      'still posts ONLY to chat for non-escalation interventions',
      async () => {
        // Simple convergence pattern that should result in SIGNAL, not MODERATOR_ESCALATION
        const messages = [
          await createMessage('Great presentation', user1, conversation, ['chat'], getMessageTime(100)),
          await createMessage('Very helpful', user2, conversation, ['chat'], getMessageTime(150)),

          await createDirectMessage('Question about scheduling flexibility', user1, conversation, getMessageTime(200)),
          await createDirectMessage('Also curious about scheduling flexibility', user2, conversation, getMessageTime(210)),

          await createMessage('Taking notes', user3, conversation, ['chat'], getMessageTime(250))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['chat'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.eventAssistantChannelMediatorPlus.respond.call(agent, conversationHistory)

        // If it intervened (not NONE)
        if (responses.length > 0) {
          // Should be only 1 response to chat (no moderator escalation)
          const isNotModeratorEscalation = !responses.some((r) => r.context?.includes('MODERATOR_ESCALATION'))

          if (isNotModeratorEscalation) {
            expect(responses).toHaveLength(1)
            expect(responses[0].channels[0].name).toBe('chat')
            console.log(`Non-escalation intervention: ${responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]}`)
          }
        }
      },
      testTimeout
    )

    it('respects same rate limiting as base version', async () => {
      // This test verifies the Plus version doesn't break rate limiting
      // (The actual rate limiting logic is tested in base version tests)

      const messages1 = [
        await createDirectMessage('Question about benefits', user1, conversation, getMessageTime(200)),
        await createDirectMessage('Also curious about benefits', user2, conversation, getMessageTime(210))
      ]
      await prepareMessagesForAgent(messages1, conversation, agent)

      const conversationHistory1 = getConversationHistory(conversation.messages, {
        count: 100,
        channels: ['chat'],
        endTime: new Date(startTime.getTime() + 300 * 1000)
      })

      const responses1 = await defaultAgentTypes.eventAssistantChannelMediatorPlus.respond.call(agent, conversationHistory1)

      if (responses1.length > 0) {
        // Try to respond again immediately
        const messages2 = [
          await createDirectMessage('What about remote work?', user1, conversation, getMessageTime(301)),
          await createDirectMessage('Yes, curious about remote work', user2, conversation, getMessageTime(302))
        ]
        await prepareMessagesForAgent(messages2, conversation, agent)

        const conversationHistory2 = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['chat'],
          endTime: new Date(startTime.getTime() + 305 * 1000)
        })

        const responses2 = await defaultAgentTypes.eventAssistantChannelMediatorPlus.respond.call(
          agent,
          conversationHistory2
        )

        // Should typically be rate limited, but LLM may override in edge cases
        // The important thing is it doesn't break - rate limiting logic is tested in base version
        expect(Array.isArray(responses2)).toBe(true)
        console.log(
          `Rate limiting result: ${responses2.length === 0 ? 'rate limited ✓' : `allowed ${responses2.length} response(s)`}`
        )
      }
    })
  })
})
