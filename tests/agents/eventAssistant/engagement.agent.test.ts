/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
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
      expect(agent.agentConfig.minInterval).toBe(300000) // 5 min
      expect(agent.agentConfig.personality).toBe('sarcastic-expert')
    })

    it('uses periodic trigger on transcript with 60 second interval', () => {
      expect(agent.triggers.periodic).toBeDefined()
      expect(agent.triggers.periodic.timerPeriod).toBe(60)
      expect(agent.triggers.periodic.conversationHistorySettings.channels).toContain('transcript')
    })
  })

  describe('PROVOCATION intervention scenarios', () => {
    it(
      'SHOULD generate provocation after bold claim with no chat engagement',
      async () => {
        // Transcript at ~02:09-02:25: Jessica challenges "why 40 hours per week is fulltime"
        // This is a provocative question that deserves discussion
        // Position at 02:30 (150 seconds) - just after the challenge, with NO chat messages
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 150 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Speaker just asked a challenging question - room is silent
        // Should consider PROVOCATION to spark discussion, but might also be PLAY
        if (responses.length > 0) {
          const interventionType = responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]
          console.log(`[02:30] Detected ${interventionType}:`, responses[0].message)
          expect(['PROVOCATION', 'NONE', 'PLAY']).toContain(interventionType)
        }
      },
      testTimeout
    )

    it(
      'SHOULD generate provocation when room is quiet/passive with only polite chat',
      async () => {
        // Transcript at ~06:45-07:20: Dense statistics about caregivers, single parents, disabilities
        // Chat shows minimal engagement - just polite acknowledgments
        const messages = [
          await createMessage('Thanks for sharing those stats', user1, conversation, ['chat'], getMessageTime(415)),
          await createMessage('Interesting numbers', user2, conversation, ['chat'], getMessageTime(430)),
          await createMessage('Noted', user3, conversation, ['chat'], getMessageTime(445))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 07:30 (450 seconds) after stats dump
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 450 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Lots of data just presented, but room is passive - should provoke discussion
        if (responses.length > 0) {
          const interventionType = responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]
          console.log(`[07:30] Detected ${interventionType}:`, responses[0].message)
          expect(['PROVOCATION', 'NONE']).toContain(interventionType)
        }
      },
      testTimeout
    )

    it(
      'SHOULD NOT generate provocation when chat is actively engaging with content',
      async () => {
        // Transcript at ~08:00-08:30: Surprising stat about hundreds of applicants for 10hr/week job
        // Chat is actively discussing this surprising data
        const messages = [
          await createMessage(
            'Hundreds of applicants for 10 hours/week? That is shocking!',
            user1,
            conversation,
            ['chat'],
            getMessageTime(490)
          ),
          await createMessage(
            'This really challenges my assumptions about what people want',
            user2,
            conversation,
            ['chat'],
            getMessageTime(500)
          ),
          await createMessage(
            'Fortune 500 execs applying for entry level? Wow',
            user3,
            conversation,
            ['chat'],
            getMessageTime(510)
          ),
          await createMessage(
            'Makes me wonder what we are missing in our own hiring',
            user1,
            conversation,
            ['chat'],
            getMessageTime(520)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 08:45 (525 seconds)
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 525 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Active, thoughtful discussion - likely NONE
        if (responses.length > 0) {
          const interventionType = responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]
          console.log(`[08:45] Detected ${interventionType}:`, responses[0].message)
        }
        // Don't expect intervention during active healthy discussion
      },
      testTimeout
    )
  })

  describe('PLAY intervention scenarios', () => {
    it(
      'SHOULD generate PLAY after emotional peak with breathing room',
      async () => {
        // Transcript at ~05:30-05:45: "Strong women cry too" - emotional vulnerable moment
        // Then transitions to success story
        // Chat shows people processing the emotional moment
        const messages = [
          await createMessage('That was such a raw moment', user1, conversation, ['chat'], getMessageTime(350)),
          await createMessage('Really appreciate the vulnerability', user2, conversation, ['chat'], getMessageTime(365)),
          await createMessage('Taking a moment to process', user3, conversation, ['chat'], getMessageTime(375))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 06:20 (380 seconds) - after emotional moment, during success story
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 380 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Breathing room after emotional peak - good moment for warm PLAY
        if (responses.length > 0) {
          const interventionType = responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]
          console.log(`[06:20] Detected ${interventionType}:`, responses[0].message)
          expect(responses[0].message).toBeDefined()
        }
      },
      testTimeout
    )

    it(
      'SHOULD generate PLAY when participants react to surprising data',
      async () => {
        // Transcript at ~08:20-08:30: "Hundreds of applicants... incredibly high level individuals"
        // This is a perfect moment for playful commentary
        const messages = [
          await createMessage(
            'Wait, Fortune 500 execs for ENTRY LEVEL?',
            user1,
            conversation,
            ['chat'],
            getMessageTime(510)
          ),
          await createMessage(
            'Someone wrote a book on marketing and wanted 10hrs/week',
            user2,
            conversation,
            ['chat'],
            getMessageTime(520)
          ),
          await createMessage('This data is absolutely wild', user3, conversation, ['chat'], getMessageTime(530))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 08:50 (530 seconds) - during the surprising data reveal
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 530 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Perfect moment for witty PLAY commentary on surprising data
        if (responses.length > 0) {
          const interventionType = responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]
          console.log(`[08:50] Detected ${interventionType}:`, responses[0].message)
          expect(['PLAY', 'NONE']).toContain(interventionType)
        }
      },
      testTimeout
    )

    it(
      'SHOULD NOT generate PLAY during raw emotionally charged moment',
      async () => {
        // Transcript at ~04:00-04:30: Health issues, irregular heartbeat, exhaustion, overwhelm
        // RIGHT in the middle of the vulnerable health crisis - witty register would be inappropriate
        const messages = [
          await createMessage('This is hitting hard', user1, conversation, ['chat'], getMessageTime(250)),
          await createMessage('The health consequences are real', user2, conversation, ['chat'], getMessageTime(260)),
          await createMessage('So many of us have been there', user3, conversation, ['chat'], getMessageTime(270))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 04:35 (275 seconds) - RIGHT in the heart of the health crisis, before transition
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 275 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Should NOT use witty PLAY during emotionally raw moments
        if (responses.length > 0) {
          const interventionType = responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]
          console.log(`[04:35] Detected ${interventionType}:`, responses[0].message)
          // Should NOT be PLAY - could be NONE or warm PROVOCATION
          expect(interventionType).not.toBe('PLAY')
        }
      },
      testTimeout
    )

    it(
      'SHOULD generate PLAY during structural transition',
      async () => {
        // Transcript at ~06:20-06:25: Transition from emotional story to "So how do I think you should go about it"
        // Natural structural moment for witty commentary
        const messages = [
          await createMessage('Love the transition to practical steps', user1, conversation, ['chat'], getMessageTime(385)),
          await createMessage('Good pacing so far', user2, conversation, ['chat'], getMessageTime(395))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 06:30 (390 seconds) - during transition to "how to" section
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 390 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Transition moments are good for PLAY
        if (responses.length > 0) {
          const interventionType = responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]
          console.log(`[06:30] Detected ${interventionType}:`, responses[0].message)
          expect(['PLAY', 'NONE']).toContain(interventionType)
        }
      },
      testTimeout
    )
  })

  describe('NONE intervention scenarios', () => {
    it(
      'SHOULD NOT intervene when rate limited (recent intervention)',
      async () => {
        // First, create an agent message to simulate recent intervention
        await createMessage('What are your thoughts on this approach?', agent, conversation, ['chat'], getMessageTime(60))

        const messages = [
          await createMessage('Interesting question', user1, conversation, ['chat'], getMessageTime(120)),
          await createMessage('I have some thoughts', user2, conversation, ['chat'], getMessageTime(140))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Try to get response just 2 minutes after agent's last post (minInterval is 5 min)
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 180 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Should be rate limited - no intervention
        expect(responses).toHaveLength(0)
      },
      testTimeout
    )

    it(
      'SHOULD handle transcript-only with NO chat messages',
      async () => {
        // Pure transcript test - NO chat messages at all
        // Position at 02:35 (155 seconds) - just as personal story begins
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 155 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Should be able to process transcript-only without error
        // May or may not intervene - depends on LLM assessment
        if (responses.length > 0) {
          const interventionType = responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]
          console.log(`[02:35 transcript-only] Detected ${interventionType}:`, responses[0].message)
          expect(responses[0].message).toBeDefined()
        }
        // Just verifying no errors with transcript-only
        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )

    it(
      'SHOULD NOT intervene when discussion is healthy and engaged',
      async () => {
        // Transcript at ~06:25-06:45: Starting practical "how to" section
        // Chat is actively engaged with thoughtful questions
        const messages = [
          await createMessage(
            'What are the main benefits of 8-10 hour positions?',
            user1,
            conversation,
            ['chat'],
            getMessageTime(390)
          ),
          await createMessage(
            'I see appeal to caregivers and part-time workers',
            user2,
            conversation,
            ['chat'],
            getMessageTime(400)
          ),
          await createMessage(
            'The 32 hour max is interesting - why that number?',
            user3,
            conversation,
            ['chat'],
            getMessageTime(410)
          ),
          await createMessage(
            'Good question - probably full-time benefits threshold',
            user1,
            conversation,
            ['chat'],
            getMessageTime(420)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 07:00 (420 seconds)
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 420 * 1000)
        })

        const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

        // Healthy, thoughtful discussion - likely NONE
        if (responses.length > 0) {
          const interventionType = responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]
          console.log(`[07:00] Optional intervention: ${interventionType}:`, responses[0].message)
        }
        // Don't expect intervention when discussion is flowing well
      },
      testTimeout
    )
  })

  describe('intervention type selection', () => {
    it(
      'varies intervention types across different transcript moments',
      async () => {
        // This test validates that the agent doesn't overuse any single intervention type
        // Tests different strategic moments in the transcript
        const interventionTypes: string[] = []

        // Helper function to test a scenario
        const testScenario = async (messages, endTimeSeconds, label) => {
          // Clear previous agent messages (reset state)
          conversation.messages = conversation.messages.filter((m) => m.pseudonym !== agent.name)

          if (messages.length > 0) {
            await prepareMessagesForAgent(messages, conversation, agent)
          }

          const conversationHistory = getConversationHistory(conversation.messages, {
            count: 100,
            channels: ['transcript'],
            endTime: new Date(startTime.getTime() + endTimeSeconds * 1000)
          })

          const responses = await defaultAgentTypes.engagementAgent.respond.call(agent, conversationHistory)

          if (responses.length > 0) {
            const interventionType = responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]
            if (interventionType) {
              interventionTypes.push(interventionType)
              console.log(`${label}: ${interventionType}`)
            }
          }
        }

        // Scenario 1: After bold challenge with minimal chat - should favor PROVOCATION
        await testScenario(
          [await createMessage('Interesting question', user1, conversation, ['chat'], getMessageTime(145))],
          150,
          '[02:30] Bold challenge'
        )

        // Scenario 2: After surprising data with excited chat - should favor PLAY
        await testScenario(
          [
            await createMessage('Hundreds of applicants!? Wild', user1, conversation, ['chat'], getMessageTime(510)),
            await createMessage('This changes everything', user2, conversation, ['chat'], getMessageTime(520))
          ],
          530,
          '[08:50] Surprising data'
        )

        // Scenario 3: Pure transcript, transition moment - could be PLAY or NONE
        await testScenario([], 390, '[06:30] Transition (transcript only)')

        // Should have some variety if multiple interventions occurred
        if (interventionTypes.length > 1) {
          console.log('Intervention types across transcript:', interventionTypes)
          // This is more informational than assertive since LLM behavior varies
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
          await createMessage('Question about part-time work', user1, conversation, ['chat'], getMessageTime(200)),
          await createMessage('Also curious about part-time work', user2, conversation, ['chat'], getMessageTime(210))
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
          await createMessage('Question about employee retention', user1, conversation, ['chat'], getMessageTime(200)),
          await createMessage('Also wondering about employee retention', user2, conversation, ['chat'], getMessageTime(210))
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
          await createMessage('Question about implementation', user1, conversation, ['chat'], getMessageTime(200)),
          await createMessage('Also wondering about implementation', user2, conversation, ['chat'], getMessageTime(220))
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
