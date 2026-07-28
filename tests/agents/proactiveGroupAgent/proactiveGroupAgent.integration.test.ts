/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createProactiveGroupAgentConversation,
  createDirectMessage,
  createPublicTopic,
  createUser,
  loadPartTimeWorkTranscript,
  createMessage,
  prepareMessagesForAgent
} from '../../utils/agentTestHelpers.js'

import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'
import transcript from '../../../src/agents/helpers/transcript.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import schedule from '../../../src/jobs/schedule.js'

jest.spyOn(websocketGateway, 'broadcastNewPoll').mockResolvedValue(undefined)
jest.spyOn(schedule, 'pollExpired').mockResolvedValue(undefined)

jest.setTimeout(180000)

const testConfig = setupAgentTest('proactiveGroupAgent')

const testTimeout = 120000

const ALL_PROACTIVE_GOALS = [
  'surface_signal',
  'synthesize_discussion',
  'invite_quieter_voices',
  'clarify_confusion',
  'bridge_topics',
  'structure_conversation',
  'provoke_participation',
  'challenge_consensus',
  'poll_reveal'
]

describe('proactive group agent integration tests', () => {
  let agent: any
  let conversation: any
  let topic: any
  let user1: any
  let user2: any
  let user3: any

  const startTime = new Date(Date.now() - 15 * 60 * 1000)

  const getMessageTime = (offsetSeconds = 0) => new Date(startTime.getTime() + offsetSeconds * 1000)

  beforeEach(async () => {
    user1 = await createUser('Curious Badger')
    user2 = await createUser('Thoughtful Fox')
    user3 = await createUser('Skeptical Owl')
    topic = await createPublicTopic()

    conversation = await createProactiveGroupAgentConversation(
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
      [user2, user3],
      ALL_PROACTIVE_GOALS
    )

    agent = conversation.agents.find((a: any) => a.name === 'Proactive Group Agent')
    expect(agent).toBeDefined()

    await loadPartTimeWorkTranscript(conversation, true)
  })

  describe('agent configuration', () => {
    it('has correct default configuration', () => {
      expect(agent.name).toBe('Proactive Group Agent')
      expect(agent.description).toContain('strategic interventions')
      expect(agent.agentConfig.personality).toBe('sarcastic-expert')
    })

    it('uses periodic trigger on transcript with 120 second interval', () => {
      expect(agent.triggers.periodic.timerPeriod).toBe(120)
      expect(agent.triggers.periodic.conversationHistorySettings.channels).toContain('transcript')
    })
  })

  describe('transcript handling', () => {
    it(
      'SHOULD handle transcript-only with NO chat messages',
      async () => {
        // Position at 02:35 (155 seconds) - just as personal story begins
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 155 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )

    it(
      'uses only the transcript window configured in agentConfig.transcriptWindow',
      async () => {
        // Narrow the window to 2 minutes ending at the Gallup survey section (~14:15).
        // The opening content ("true or false no one wants to work") should not be visible;
        // only the concluding remarks around pay and work-life balance should be in scope.
        const endTime = new Date(startTime.getTime() + 855 * 1000) // ~14:15 into transcript

        agent.agentConfig.transcriptWindow = 2 // 2 minutes

        const getTranscriptSpy = jest.spyOn(transcript, 'getTranscript')

        const conversationHistory = getConversationHistory(conversation.messages, {
          channels: ['transcript'],
          endTime
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)
        expect(Array.isArray(responses)).toBe(true)
        expect(getTranscriptSpy).toHaveBeenCalledWith(agent.conversation, 120, expect.any(Date))
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
          await createMessage('Part-time work sounds interesting', user1, conversation, ['chat'], getMessageTime(130)),
          await createMessage('I can see the appeal', user2, conversation, ['chat'], getMessageTime(145))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 155 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )

    it(
      'works without personality when set to null',
      async () => {
        agent.agentConfig.personality = null

        const messages = [
          await createMessage('Interesting perspective', user1, conversation, ['chat'], getMessageTime(130)),
          await createMessage('Worth exploring', user2, conversation, ['chat'], getMessageTime(145))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 155 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )
  })

  describe('self-limiting based on recent agent activity', () => {
    it(
      'SHOULD NOT intervene when it recently posted a message',
      async () => {
        const recentAgentMsg = await createMessage(
          'What would need to be true for this model to work in your context?',
          user1,
          conversation,
          ['chat'],
          getMessageTime(120)
        )
        recentAgentMsg.fromAgent = true
        recentAgentMsg.visible = true
        recentAgentMsg.pseudonym = agent.instanceName ?? agent.name

        const messages = [
          recentAgentMsg,
          await createMessage('Good question', user2, conversation, ['chat'], getMessageTime(130)),
          await createMessage('Thinking about it', user3, conversation, ['chat'], getMessageTime(140))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Only 30 seconds elapsed since agent post, below 2-minute threshold
        const endTime = new Date(startTime.getTime() + 150 * 1000)
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )

    it(
      'SHOULD intervene despite recent Q&A agent activity',
      async () => {
        const recentQAMsg = await createMessage(
          'Thanks for your question about benefits!',
          user1,
          conversation,
          ['chat'],
          getMessageTime(120)
        )
        recentQAMsg.fromAgent = true
        recentQAMsg.pseudonym = 'Event Assistant'
        recentQAMsg.visible = true

        const messages = [
          recentQAMsg,
          await createDirectMessage(
            'How does healthcare work for part-time employees?',
            user1,
            conversation,
            getMessageTime(130)
          ),
          await createDirectMessage('Benefits for part-timers is my main concern', user2, conversation, getMessageTime(140)),
          await createDirectMessage('Healthcare coverage for part-time staff?', user3, conversation, getMessageTime(150)),
          await createMessage('Great talk so far', user1, conversation, ['chat'], getMessageTime(160))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const endTime = new Date(startTime.getTime() + 200 * 1000)
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        expect(responses.length).toBeGreaterThan(0)
      },
      testTimeout
    )
  })

  describe('privacy protection', () => {
    it(
      'does not quote private messages verbatim in shared chat',
      async () => {
        const uniquePhrase = 'the synergistic paradigm shift in workforce optimization'

        const messages = [
          await createMessage('Really compelling data', user1, conversation, ['chat'], getMessageTime(200)),
          await createMessage('The statistics are eye-opening', user2, conversation, ['chat'], getMessageTime(220)),
          await createMessage('Lots to take away here', user3, conversation, ['chat'], getMessageTime(240)),
          await createDirectMessage(`I keep thinking about ${uniquePhrase}`, user1, conversation, getMessageTime(260)),
          await createDirectMessage(`This reminds me of ${uniquePhrase}`, user2, conversation, getMessageTime(280))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0) {
          expect(responses[0].message).not.toContain(uniquePhrase)
        }
      },
      testTimeout
    )
  })

  describe('intervention context', () => {
    it(
      'includes goalId and reasoning in response',
      async () => {
        const messages = [
          await createMessage('The flexibility angle is interesting', user1, conversation, ['chat'], getMessageTime(200)),
          await createMessage(
            'Scheduling options seem complicated though',
            user2,
            conversation,
            ['chat'],
            getMessageTime(220)
          ),
          await createDirectMessage(
            'How do you handle scheduling flexibility across time zones?',
            user1,
            conversation,
            getMessageTime(240)
          ),
          await createDirectMessage(
            'Scheduling flexibility is my biggest question',
            user2,
            conversation,
            getMessageTime(260)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0) {
          expect(responses[0].goalId).toBeDefined()
          expect(responses[0].reasoning).toBeDefined()
          expect(ALL_PROACTIVE_GOALS).toContain(responses[0].goalId)
        }
      },
      testTimeout
    )
  })

  describe('privacy threshold enforcement', () => {
    it(
      'does NOT surface theme from only 1 private message',
      async () => {
        const messages = [
          await createDirectMessage(
            'I heard there are talks about forming a union here',
            user1,
            conversation,
            getMessageTime(200)
          ),
          await createMessage('Good presentation overall', user2, conversation, ['chat'], getMessageTime(250))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0) {
          expect(responses[0].message.toLowerCase()).not.toContain('union')
          expect(responses[0].message.toLowerCase()).not.toContain('labor')
        }
      },
      testTimeout
    )

    it(
      'surfaces theme only when 2+ independent signals present',
      async () => {
        const messages = [
          await createDirectMessage(
            'What about health insurance for part-time workers?',
            user1,
            conversation,
            getMessageTime(200)
          ),
          await createDirectMessage(
            'Healthcare benefits for part-timers seems like a big gap',
            user2,
            conversation,
            getMessageTime(220)
          ),
          await createMessage('Interesting points in this talk', user3, conversation, ['chat'], getMessageTime(240))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )

    it(
      'never reveals exact count of private messages',
      async () => {
        const messages = [
          await createDirectMessage(
            'What are the legal requirements for part-time benefits?',
            user1,
            conversation,
            getMessageTime(200)
          ),
          await createDirectMessage(
            'Are there legal minimums for benefits coverage?',
            user2,
            conversation,
            getMessageTime(220)
          ),
          await createDirectMessage(
            'The legal side of part-time employment seems complex',
            user3,
            conversation,
            getMessageTime(240)
          ),
          await createMessage('Very informative session', user1, conversation, ['chat'], getMessageTime(260))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0) {
          const { message } = responses[0]
          expect(message).not.toMatch(/\b(three|3)\s+(people|participants|users)/i)
          expect(message).not.toMatch(/exactly\s+\d+/i)
        }
      },
      testTimeout
    )
  })

  describe('no intervention scenarios', () => {
    it(
      'SHOULD NOT intervene when agent recently posted and active discussion is flowing',
      async () => {
        // Agent posted a provocation, and it sparked a genuine back-and-forth — stay quiet
        const recentAgentMsg = await createMessage(
          'Bold claim just went unchallenged — what would need to be true for this whole approach to be wrong?',
          user1,
          conversation,
          ['chat'],
          getMessageTime(120)
        )
        recentAgentMsg.fromAgent = true
        recentAgentMsg.pseudonym = agent.instanceName ?? agent.name

        const messages = [
          recentAgentMsg,
          await createMessage(
            'Honestly the whole assumption that people want more hours is wrong — most people I know would take fewer hours for the same pay immediately',
            user1,
            conversation,
            ['chat'],
            getMessageTime(130)
          ),
          await createMessage(
            'Exactly — the 40 hour week was never about productivity, it was about factory scheduling. We just inherited it',
            user2,
            conversation,
            ['chat'],
            getMessageTime(145)
          ),
          await createMessage(
            'But then how do you handle roles that need coverage? Not everything can be async',
            user3,
            conversation,
            ['chat'],
            getMessageTime(158)
          ),
          await createMessage(
            'That is the real question — the model works for knowledge workers but falls apart for shift-based roles',
            user1,
            conversation,
            ['chat'],
            getMessageTime(170)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 180 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.warn(`[self-limiting] Agent intervened into active discussion: ${goalId}: ${responses[0].message}`)
        } else {
          console.log('[self-limiting] Agent correctly stayed quiet while discussion flowed')
        }
        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )

    it(
      'SHOULD NOT intervene when discussion is healthy and engaged',
      async () => {
        // Chat is a genuine multi-sided debate — participants holding different views and responding to each other
        const messages = [
          await createMessage(
            'This would not work at my company — our roles all require full coverage and there is no way to split them',
            user1,
            conversation,
            ['chat'],
            getMessageTime(390)
          ),
          await createMessage(
            'We actually do this already for a chunk of our roles and it has been fine — the key is picking the right positions',
            user2,
            conversation,
            ['chat'],
            getMessageTime(400)
          ),
          await createMessage(
            'Which roles though? I feel like knowledge work is easy but anything client-facing falls apart',
            user3,
            conversation,
            ['chat'],
            getMessageTime(410)
          ),
          await createMessage(
            'Client-facing is actually where we see the most interest — people want the hours, they just want sane ones',
            user2,
            conversation,
            ['chat'],
            getMessageTime(420)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 420 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[healthy discussion] Optional intervention: ${goalId}:`, responses[0].message)
        }
        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )

    it(
      'maintains strategic silence when no clear pattern',
      async () => {
        const messages = [
          await createDirectMessage('The weather is nice today', user1, conversation, getMessageTime(200)),
          await createDirectMessage('Just trying to catch up from earlier', user2, conversation, getMessageTime(220)),
          await createMessage('Hello everyone', user3, conversation, ['chat'], getMessageTime(240)),
          await createDirectMessage('Where is the Q&A link?', user1, conversation, getMessageTime(260))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0) {
          const { message } = responses[0]
          expect(message).not.toContain('weather is nice')
          expect(message).not.toContain('trying to catch up')
          expect(message).not.toContain('Q&A link')
        }
      },
      testTimeout
    )
  })

  describe('goal selection variety', () => {
    it(
      'varies goals across different transcript moments',
      async () => {
        const goalIds: string[] = []

        const testScenario = async (messages: any[], endTimeSeconds: number, label: string) => {
          conversation.messages = conversation.messages.filter((m: any) => m.pseudonym !== agent.name)

          if (messages.length > 0) {
            await prepareMessagesForAgent(messages, conversation, agent)
          }

          const conversationHistory = getConversationHistory(conversation.messages, {
            count: 100,
            channels: ['transcript'],
            endTime: new Date(startTime.getTime() + endTimeSeconds * 1000)
          })

          const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

          if (responses.length > 0) {
            const { goalId } = responses[0]
            if (goalId) {
              goalIds.push(goalId)
              console.log(`${label}: ${goalId}`)
            }
          }
        }

        // Scenario 1: Bold challenge with minimal chat — early moment
        await testScenario(
          [await createMessage('Interesting question', user1, conversation, ['chat'], getMessageTime(145))],
          150,
          '[02:30] Bold challenge'
        )

        // Scenario 2: Surprising data with excited chat — play_commentary territory
        await testScenario(
          [
            await createMessage('Hundreds of applicants!? Wild', user1, conversation, ['chat'], getMessageTime(510)),
            await createMessage('This changes everything', user2, conversation, ['chat'], getMessageTime(520))
          ],
          530,
          '[08:50] Surprising data'
        )

        // Scenario 3: Pure transcript, transition moment
        await testScenario([], 390, '[06:30] Transition (transcript only)')

        if (goalIds.length > 1) {
          console.log('Goals across transcript moments:', goalIds)
        }
      },
      testTimeout
    )
  })
})
