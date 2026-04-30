import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createModeratorNotifierConversation,
  createDirectMessage,
  createPublicTopic,
  createUser,
  loadPartTimeWorkTranscript,
  createMessage,
  prepareMessagesForAgent
} from '../../utils/agentTestHelpers.js'

import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('moderatorNotifier')

const testTimeout = 120000

describe('moderator agent tests', () => {
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

    conversation = await createModeratorNotifierConversation(
      {
        name: 'Why your company should consider part-time work',
        description: `"No one wants to work anymore." Entrepreneur Jessica Drain believes otherwise—instead it's that businesses aren't structuring jobs to attract and retain the widest number of people possible.`,
        presenters: [
          {
            name: 'Jessica Drain',
            bio: `A career marketer and graphic designer, Jessica has helped businesses brand and market themselves for almost two decades.`
          }
        ]
      },
      user1,
      topic,
      startTime,
      testConfig.llmPlatform,
      testConfig.llmModel,
      [user2, user3]
    )

    agent = conversation.agents.find((a) => a.name === 'Moderator Notifier')
    await loadPartTimeWorkTranscript(conversation)
  })

  const assertEscalated = (responses) => {
    expect(responses.length).toBeGreaterThan(0)
    const moderatorResponse = responses.find((r) => r.channels.some((c) => c.name === 'moderator'))
    expect(moderatorResponse).toBeDefined()
    expect(moderatorResponse!.messageType).toBe('json')
    expect(moderatorResponse!.message).toHaveProperty('insights')
    const { insights } = moderatorResponse!.message
    expect(Array.isArray(insights)).toBe(true)
    expect(insights.length).toBeGreaterThan(0)
    expect(insights[0]).toHaveProperty('value')
  }

  const assertNotEscalated = (responses) => {
    expect(Array.isArray(responses)).toBe(true)
    expect(responses).toHaveLength(0)
  }

  describe('escalation behavior', () => {
    it(
      'escalates convergent private signals about the same unvoiced topic',
      async () => {
        const messages = [
          await createMessage('Great presentation!', user1, conversation, ['chat'], getMessageTime(100)),
          await createMessage('Very insightful', user2, conversation, ['chat'], getMessageTime(150)),

          // Multiple participants asking about the same regulatory topic privately
          await createDirectMessage(
            'How does this interact with the recent Department of Labor regulatory changes?',
            user1,
            conversation,
            getMessageTime(220)
          ),
          await createDirectMessage(
            'What about the new overtime rules from DOL? That affects this',
            user2,
            conversation,
            getMessageTime(240)
          ),
          await createDirectMessage(
            'Recent federal regulations seem relevant here — is the speaker aware?',
            user3,
            conversation,
            getMessageTime(260)
          ),
          await createDirectMessage(
            'The compliance landscape just shifted — how does that impact this approach?',
            user1,
            conversation,
            getMessageTime(280)
          ),

          await createMessage('Great talk', user2, conversation, ['chat'], getMessageTime(350))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.moderatorNotifier.respond.call(agent, conversationHistory)
        assertEscalated(responses)
      },
      testTimeout
    )

    it(
      'escalates emotional frustration building in public chat that the speaker is not addressing',
      async () => {
        const messages = [
          await createMessage(
            'I keep asking about how this works for hourly workers but it keeps getting skipped',
            user1,
            conversation,
            ['chat'],
            getMessageTime(100)
          ),
          await createMessage(
            'Same — every example has been salaried employees. What about the rest of us?',
            user2,
            conversation,
            ['chat'],
            getMessageTime(140)
          ),
          await createMessage(
            'This is frustrating, the question about hourly workers has been asked three times now',
            user3,
            conversation,
            ['chat'],
            getMessageTime(180)
          ),
          await createMessage(
            'Moving on without addressing it again... really disappointing',
            user1,
            conversation,
            ['chat'],
            getMessageTime(220)
          ),
          await createDirectMessage(
            'Is there a way to get the hourly worker question addressed? It feels like it keeps being ignored',
            user2,
            conversation,
            getMessageTime(240)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.moderatorNotifier.respond.call(agent, conversationHistory)
        assertEscalated(responses)
      },
      testTimeout
    )

    it(
      'does not escalate when the speaker is already visibly handling the topic in public chat',
      async () => {
        const messages = [
          await createMessage(
            'What about part-time workers and benefits eligibility?',
            user1,
            conversation,
            ['chat'],
            getMessageTime(100)
          ),
          await createMessage(
            'Great question — benefits eligibility for part-time workers is governed by the ACA threshold of 30 hours. Many of the companies I work with address this by offering prorated benefits.',
            user2,
            conversation,
            ['chat'],
            getMessageTime(140)
          ),
          await createMessage(
            'That makes sense, thanks for clarifying!',
            user3,
            conversation,
            ['chat'],
            getMessageTime(180)
          ),
          await createMessage('Very helpful answer', user1, conversation, ['chat'], getMessageTime(200)),
          await createDirectMessage('Good to know about the 30 hour threshold', user3, conversation, getMessageTime(220))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 280 * 1000)
        })

        const responses = await defaultAgentTypes.moderatorNotifier.respond.call(agent, conversationHistory)
        assertNotEscalated(responses)
      },
      testTimeout
    )

    it(
      'does not escalate when the speaker addresses the concern out loud in the transcript',
      async () => {
        const messages = [
          // Participants ask about hourly workers in chat and privately
          await createMessage(
            'What about hourly workers — does any of this apply to them?',
            user1,
            conversation,
            ['chat'],
            getMessageTime(100)
          ),
          await createDirectMessage(
            'I keep wondering about hourly workers, the talk seems focused on salaried',
            user2,
            conversation,
            getMessageTime(120)
          ),
          await createDirectMessage('Seconding the hourly worker question', user3, conversation, getMessageTime(135)),

          // Speaker picks it up and addresses it verbally — captured in transcript
          await createMessage(
            "I see some questions coming in about hourly workers — great point. Everything I've said applies equally to hourly staff. In fact, hourly part-time arrangements can be even more flexible because scheduling is already shift-based. The key difference is overtime compliance under FLSA, which you'll want to track carefully.",
            user1,
            conversation,
            ['transcript'],
            getMessageTime(160)
          ),

          // Positive acknowledgment after the verbal response
          await createMessage('Thank you, that answered it perfectly', user2, conversation, ['chat'], getMessageTime(200)),
          await createMessage('Really helpful clarification', user3, conversation, ['chat'], getMessageTime(215))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 280 * 1000)
        })

        const responses = await defaultAgentTypes.moderatorNotifier.respond.call(agent, conversationHistory)
        assertNotEscalated(responses)
      },
      testTimeout
    )

    it(
      'does not escalate on a single weak private signal with no supporting pattern',
      async () => {
        const messages = [
          await createMessage('Great presentation!', user1, conversation, ['chat'], getMessageTime(100)),
          await createMessage('Really enjoying this', user2, conversation, ['chat'], getMessageTime(130)),
          await createDirectMessage(
            'Curious about tax implications but not a big deal',
            user3,
            conversation,
            getMessageTime(160)
          ),
          await createMessage('Thanks for sharing this', user1, conversation, ['chat'], getMessageTime(200))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 250 * 1000)
        })

        const responses = await defaultAgentTypes.moderatorNotifier.respond.call(agent, conversationHistory)
        assertNotEscalated(responses)
      },
      testTimeout
    )

    it(
      'does not include /mod messages in analysis',
      async () => {
        const messages = [
          // /mod messages fast-tracked directly to moderator — should be excluded from analysis
          await createDirectMessage(
            { command: 'mod', text: 'Please escalate the hourly worker question' },
            user1,
            conversation,
            getMessageTime(100)
          ),
          await createDirectMessage(
            { command: 'mod', text: 'The speaker keeps skipping my question about regulations' },
            user2,
            conversation,
            getMessageTime(130)
          ),
          await createDirectMessage(
            { command: 'mod', text: 'Can you intervene? This topic is being ignored' },
            user3,
            conversation,
            getMessageTime(160)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 250 * 1000)
        })

        const responses = await defaultAgentTypes.moderatorNotifier.respond.call(agent, conversationHistory)
        assertNotEscalated(responses)
      },
      testTimeout
    )

    it(
      'does not escalate on scattered unrelated messages',
      async () => {
        const messages = [
          await createDirectMessage('The weather is nice today', user1, conversation, getMessageTime(150)),
          await createDirectMessage('Just joined late, trying to catch up', user2, conversation, getMessageTime(180)),
          await createMessage('Hello everyone', user3, conversation, ['chat'], getMessageTime(200))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.moderatorNotifier.respond.call(agent, conversationHistory)
        assertNotEscalated(responses)
      },
      testTimeout
    )
  })
  describe('parseOutput function', () => {
    it('handles text messages as-is', () => {
      const agentType = defaultAgentTypes.moderatorNotifier
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
      const agentType = defaultAgentTypes.moderatorNotifier
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
      expect(result.body).toContain('MODERATOR REPORT')
      expect(result.body).toContain('* Multiple questions about healthcare compliance')
      expect(result.body).toContain('* Strong interest in regulatory framework')
    })
  })
})
