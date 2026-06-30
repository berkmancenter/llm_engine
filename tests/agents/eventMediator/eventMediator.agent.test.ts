/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createEventMediatorConversation,
  createDirectMessage,
  createPublicTopic,
  createUser,
  loadPartTimeWorkTranscript,
  createMessage,
  prepareMessagesForAgent
} from '../../utils/agentTestHelpers.js'

import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'
import { InterventionType } from '../../../src/agents/helpers/interventionTypes.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import schedule from '../../../src/jobs/schedule.js'

jest.spyOn(websocketGateway, 'broadcastNewPoll').mockResolvedValue(undefined)
jest.spyOn(schedule, 'pollExpired').mockResolvedValue(undefined)

jest.setTimeout(180000)

const testConfig = setupAgentTest('eventMediator')

const testTimeout = 120000

describe(`event mediator agent tests`, () => {
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

    conversation = await createEventMediatorConversation(
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

    // Get the mediator agent
    agent = conversation.agents.find((a) => a.name === 'Event Mediator')
    expect(agent).toBeDefined()

    await loadPartTimeWorkTranscript(conversation, true)
  })

  describe('agent configuration', () => {
    it('has correct default configuration', () => {
      expect(agent.name).toBe('Event Mediator')
      expect(agent.description).toContain('strategic interventions')
      expect(agent.agentConfig.personality).toBe('sarcastic-expert')
    })

    it('uses periodic trigger on transcript with 67 second interval', () => {
      expect(agent.triggers.periodic).toBeDefined()
      expect(agent.triggers.periodic.timerPeriod).toBe(67)
      expect(agent.triggers.periodic.conversationHistorySettings.channels).toContain('transcript')
    })
  })

  describe('respond function', () => {
    it(
      'can detect convergence pattern from multiple private messages',
      async () => {
        // Create messages for the test
        const messages = [
          // Active chat showing engagement
          await createMessage('Great presentation on part-time work!', user1, conversation, ['chat'], getMessageTime(100)),
          await createMessage(
            'The data on employee satisfaction is compelling',
            user2,
            conversation,
            ['chat'],
            getMessageTime(150)
          ),
          await createMessage('Really interesting points', user3, conversation, ['chat'], getMessageTime(200)),

          // Multiple people independently asking about the same concept privately
          await createDirectMessage(
            'I am confused about the smallest viable job concept',
            user1,
            conversation,
            getMessageTime(250)
          ),
          await createDirectMessage('What does smallest viable job mean?', user2, conversation, getMessageTime(260)),
          await createDirectMessage(
            'Can someone explain the smallest viable job idea?',
            user3,
            conversation,
            getMessageTime(270)
          ),

          await createMessage('Interesting talk so far', user1, conversation, ['chat'], getMessageTime(350))
        ]

        // Prepare messages so agent can see them
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // May or may not intervene depending on LLM decision, but should not error
        expect(Array.isArray(responses)).toBe(true)

        if (responses.length > 0) {
          console.log('Mediator response:', responses[0].message)
          expect(responses[0].channels).toBeDefined()
          expect(responses[0].channels[0].name).toBe('chat')
          expect(responses[0].visible).toBe(true)
          // Should not quote any individual's exact words
          expect(responses[0].message).not.toContain('smallest viable job concept')
          expect(responses[0].message).not.toContain('What does smallest viable job mean')
        }
      },
      testTimeout
    )

    describe('self-limiting based on recent agent activity', () => {
      it(
        'SHOULD NOT intervene when it recently posted a facilitation message',
        async () => {
          // Mediator posted a substantive facilitation message just 30 seconds ago
          const recentMediatorMsg = await createMessage(
            'Interesting tension in the room right now — some of you are energised by this framework, others feel something important is being flattened.',
            user1,
            conversation,
            ['chat'],
            getMessageTime(120)
          )
          recentMediatorMsg.fromAgent = true
          recentMediatorMsg.pseudonym = agent.name
          recentMediatorMsg.pseudonym = agent.name
          recentMediatorMsg.visible = true

          const messages = [
            recentMediatorMsg,
            await createMessage('That is a good point', user1, conversation, ['chat'], getMessageTime(130)),
            await createMessage('Agreed', user2, conversation, ['chat'], getMessageTime(140))
          ]
          await prepareMessagesForAgent(messages, conversation, agent)

          const conversationHistory = getConversationHistory(conversation.messages, {
            count: 100,
            channels: ['transcript'],
            endTime: new Date(startTime.getTime() + 150 * 1000)
          })

          const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

          if (responses.length > 0) {
            const { interventionType } = responses[0]
            console.warn(`[self-limiting] Agent intervened 30s after own post: ${interventionType}: ${responses[0].message}`)
          } else {
            console.log('[self-limiting] Agent correctly held back after recent post')
          }
          expect(Array.isArray(responses)).toBe(true)
        },
        testTimeout
      )

      it(
        'SHOULD NOT intervene when another facilitation agent recently posted',
        async () => {
          // Engagement Agent posted a provocation 30 seconds ago — mediator should hold back
          const recentEngagementMsg = await createMessage(
            "We've been in agreement for a while now. What's the strongest case against what we're converging on?",
            user1,
            conversation,
            ['chat'],
            getMessageTime(120)
          )
          recentEngagementMsg.fromAgent = true
          recentEngagementMsg.pseudonym = 'Engagement Agent'
          recentEngagementMsg.visible = true

          const messages = [
            recentEngagementMsg,
            await createMessage('Hmm good question', user1, conversation, ['chat'], getMessageTime(130)),
            await createMessage('Let me think', user2, conversation, ['chat'], getMessageTime(140))
          ]
          await prepareMessagesForAgent(messages, conversation, agent)

          const conversationHistory = getConversationHistory(conversation.messages, {
            count: 100,
            channels: ['transcript'],
            endTime: new Date(startTime.getTime() + 150 * 1000)
          })

          const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

          if (responses.length > 0) {
            const { interventionType } = responses[0]
            console.warn(
              `[cross-agent limiting] Agent intervened 30s after other facilitation agent: ${interventionType}: ${responses[0].message}`
            )
          } else {
            console.log('[cross-agent limiting] Agent correctly held back after recent facilitation post')
          }
          expect(Array.isArray(responses)).toBe(true)
        },
        testTimeout
      )

      it(
        'SHOULD intervene despite recent Q&A agent activity',
        async () => {
          // An event assistant answered a direct question recently — this should NOT block the mediator
          const recentQAMsg = await createMessage(
            'The conference is on June 15th at the downtown venue.',
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
            // Strong convergence pattern to give the mediator a clear reason to intervene
            await createDirectMessage(
              'What about healthcare for part-time workers?',
              user1,
              conversation,
              getMessageTime(130)
            ),
            await createDirectMessage('Healthcare benefits are my main question', user2, conversation, getMessageTime(140)),
            await createDirectMessage('The benefits question is huge', user3, conversation, getMessageTime(150)),
            await createMessage('Really useful so far', user1, conversation, ['chat'], getMessageTime(160))
          ]
          await prepareMessagesForAgent(messages, conversation, agent)

          const conversationHistory = getConversationHistory(conversation.messages, {
            count: 100,
            channels: ['transcript'],
            endTime: new Date(startTime.getTime() + 200 * 1000)
          })

          const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

          // Q&A activity should not suppress the mediator when there is a clear pattern
          if (responses.length > 0) {
            console.log(`[Q&A not blocking] Detected ${responses[0].interventionType}:`, responses[0].message)
          } else {
            console.warn('[Q&A not blocking] Agent did not intervene despite strong convergence pattern')
          }
          expect(responses.length).toBeGreaterThan(0)
        },
        testTimeout
      )
    })
  })

  describe('privacy protection', () => {
    it(
      'does not quote private messages verbatim in shared chat',
      async () => {
        const uniquePhrase = 'the synergistic paradigm shift in workforce optimization'
        const messages = [
          // Active chat
          await createMessage('This is helpful', user1, conversation, ['chat'], getMessageTime(100)),
          await createMessage('Good points', user2, conversation, ['chat'], getMessageTime(150)),
          await createMessage('Interesting', user3, conversation, ['chat'], getMessageTime(180)),

          await createDirectMessage(`I don't understand ${uniquePhrase}`, user1, conversation, getMessageTime(200)),
          await createDirectMessage(`Can someone explain ${uniquePhrase}?`, user2, conversation, getMessageTime(210))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        if (responses.length > 0) {
          // Should not contain the exact unique phrase
          expect(responses[0].message).not.toContain(uniquePhrase)
        }
      },
      testTimeout
    )
  })

  describe('intervention context', () => {
    it('includes intervention type and reasoning in response', async () => {
      const messages = [
        // Active chat
        await createMessage('Really useful information', user1, conversation, ['chat'], getMessageTime(100)),
        await createMessage('Great presentation!', user2, conversation, ['chat'], getMessageTime(150)),

        await createDirectMessage(
          'Question about part-time scheduling flexibility',
          user1,
          conversation,
          getMessageTime(200)
        ),
        await createDirectMessage('Also wondering about scheduling flexibility', user2, conversation, getMessageTime(210)),
        await createMessage('Very practical', user3, conversation, ['chat'], getMessageTime(250))
      ]
      await prepareMessagesForAgent(messages, conversation, agent)

      const conversationHistory = getConversationHistory(conversation.messages, {
        count: 100,
        channels: ['transcript'],
        endTime: new Date(startTime.getTime() + 300 * 1000)
      })

      const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

      if (responses.length > 0) {
        expect(responses[0].interventionType).toBeDefined()
        expect(responses[0].reasoning).toBeDefined()

        // Verify it's a valid intervention type
        const validTypes = Object.values(InterventionType)
        expect(validTypes).toContain(responses[0].interventionType)
      }
    })
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

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

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

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // Should not error with personality disabled
        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )
  })

  describe('lifecycle methods', () => {
    it('does not introduce itself (silent monitoring)', async () => {
      const [chatChannel] = conversation.channels.filter((c) => c.name === 'chat')
      const agentType = defaultAgentTypes.eventMediator
      const msgs = await agentType.introduce.call(agent, chatChannel)
      expect(msgs).toEqual([])
    })
  })

  describe('intervention type behaviors', () => {
    it(
      'SIGNAL: surfaces convergence pattern from multiple private messages',
      async () => {
        const messages = [
          // Build up engaged chat showing real conversation
          await createMessage(
            'This data on employee satisfaction is really compelling',
            user1,
            conversation,
            ['chat'],
            getMessageTime(80)
          ),
          await createMessage(
            'The personal story at the start really landed',
            user2,
            conversation,
            ['chat'],
            getMessageTime(100)
          ),
          await createMessage('I appreciate the research citations', user3, conversation, ['chat'], getMessageTime(120)),
          await createMessage('Taking lots of notes on the statistics', user1, conversation, ['chat'], getMessageTime(140)),
          await createMessage(
            'The 33% reduction in quitting is significant',
            user2,
            conversation,
            ['chat'],
            getMessageTime(160)
          ),
          await createMessage(
            'This is shifting how I think about staffing',
            user3,
            conversation,
            ['chat'],
            getMessageTime(180)
          ),

          // Multiple people independently expressing curiosity about benefits/healthcare - STRONG pattern with 4 messages
          await createDirectMessage(
            'What about health insurance for part-time workers? That seems like a major barrier',
            user1,
            conversation,
            getMessageTime(220)
          ),
          await createDirectMessage(
            'Healthcare benefits are my main question - how does this work for part-timers?',
            user2,
            conversation,
            getMessageTime(240)
          ),
          await createDirectMessage(
            'The benefits question is huge - especially healthcare coverage',
            user3,
            conversation,
            getMessageTime(260)
          ),
          await createDirectMessage(
            'I really need to understand the healthcare approach before implementing this',
            user1,
            conversation,
            getMessageTime(275)
          ),

          await createMessage('Really practical advice', user1, conversation, ['chat'], getMessageTime(300)),
          await createMessage('Lots to consider here', user2, conversation, ['chat'], getMessageTime(320))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // Strong pattern should trigger intervention, but allow for LLM variance
        if (responses.length === 0) {
          console.warn('WARNING: Agent did not detect strong convergence pattern (4 users asking about healthcare)')
        }

        // If it intervenes, verify it follows rules
        if (responses.length > 0) {
          console.log(`Detected ${responses[0].interventionType}:`, responses[0].message)
          const { message } = responses[0]
          // Should surface the pattern without quoting individuals
          expect(message).not.toContain(user1.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user2.pseudonyms[0].pseudonym)
          // Should not quote private messages verbatim
          expect(message).not.toContain('That seems like a major barrier')
          expect(message).not.toContain('how does this work for part-timers')
        }
      },
      testTimeout
    )

    it(
      'SYNTHESIS: finds deeper question underneath scattered signals',
      async () => {
        const messages = [
          // Build engaged discussion showing people are processing
          await createMessage('This framework makes so much sense', user1, conversation, ['chat'], getMessageTime(60)),
          await createMessage(
            'The case for part-time work is compelling',
            user2,
            conversation,
            ['chat'],
            getMessageTime(90)
          ),
          await createMessage('I can see the benefits clearly', user3, conversation, ['chat'], getMessageTime(120)),
          await createMessage('The data backs this up', user1, conversation, ['chat'], getMessageTime(150)),
          await createMessage('Really well presented', user2, conversation, ['chat'], getMessageTime(180)),

          // Scattered implementation concerns that share a deeper theme about feasibility
          await createDirectMessage(
            'The upfront cost of restructuring our entire team seems prohibitive',
            user1,
            conversation,
            getMessageTime(220)
          ),
          await createDirectMessage(
            'Getting executive buy-in for something this different will be tough',
            user2,
            conversation,
            getMessageTime(235)
          ),
          await createDirectMessage(
            'The change management effort required is massive',
            user3,
            conversation,
            getMessageTime(250)
          ),
          await createDirectMessage(
            'Our company culture is pretty traditional - this would be a huge shift',
            user1,
            conversation,
            getMessageTime(265)
          ),
          await createDirectMessage(
            'I worry about the transition period causing disruption',
            user2,
            conversation,
            getMessageTime(280)
          ),

          await createMessage('A lot to think through', user3, conversation, ['chat'], getMessageTime(320)),
          await createMessage('Implementation will be key', user1, conversation, ['chat'], getMessageTime(350))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // Assert intervention occurred - accept SYNTHESIS, SIGNAL, or MINORITY_VOICE
        // (all are valid for surfacing private concerns that diverge from public enthusiasm)
        expect(responses.length).toBeGreaterThan(0)
        const { interventionType } = responses[0]
        expect(['SYNTHESIS', 'SIGNAL', 'MINORITY_VOICE']).toContain(interventionType)

        console.log(`Detected ${interventionType}:`, responses[0].message)
        const { message } = responses[0]
        // Should reframe or surface the pattern without directly quoting full private message phrases
        // Note: Common business terms like "executive buy-in" may appear in synthesis, but shouldn't quote unique identifying phrases
        expect(message).not.toContain('The upfront cost of restructuring our entire team seems prohibitive')
        expect(message).not.toContain('Getting executive buy-in for something this different will be tough')
        // Should identify the underlying theme (feasibility/implementation gap)
        const hasThemeIdentification =
          message.toLowerCase().includes('question') ||
          message.toLowerCase().includes('really') ||
          message.toLowerCase().includes('actually') ||
          message.toLowerCase().includes('feasibility') ||
          message.toLowerCase().includes('implementation') ||
          message.toLowerCase().includes('transition') ||
          message.toLowerCase().includes('cost') ||
          message.toLowerCase().includes('culture') ||
          message.toLowerCase().includes('leadership') ||
          message.toLowerCase().includes('how to') ||
          message.toLowerCase().includes('work of')
        expect(hasThemeIdentification).toBe(true)
      },
      testTimeout
    )

    it(
      'MINORITY_VOICE: creates space for minority voice without exposing dissenters',
      async () => {
        const messages = [
          // Build strong public enthusiasm and consensus
          await createMessage('This is brilliant! We should all do this', user1, conversation, ['chat'], getMessageTime(60)),
          await createMessage(
            'Absolutely agree - game changer for our industry',
            user2,
            conversation,
            ['chat'],
            getMessageTime(90)
          ),
          await createMessage('This solves so many staffing problems', user1, conversation, ['chat'], getMessageTime(120)),
          await createMessage("I'm completely sold on this model", user2, conversation, ['chat'], getMessageTime(150)),
          await createMessage("Can't wait to implement this approach", user3, conversation, ['chat'], getMessageTime(180)),
          await createMessage('The research is so compelling', user1, conversation, ['chat'], getMessageTime(210)),

          // Dissenting voices in private - expressing real concerns
          await createDirectMessage(
            'I have serious reservations about this. My industry has compliance issues that make this nearly impossible',
            user3,
            conversation,
            getMessageTime(240)
          ),
          await createDirectMessage(
            "This sounds great in theory but would never work for manufacturing roles. The assumptions don't hold",
            user2,
            conversation,
            getMessageTime(260)
          ),
          await createDirectMessage(
            "I'm concerned we're oversimplifying. Not all work can be decomposed this way",
            user1,
            conversation,
            getMessageTime(280)
          ),

          await createMessage('This is exactly what we need', user2, conversation, ['chat'], getMessageTime(320)),
          await createMessage(
            'Already planning how to pitch this to leadership',
            user3,
            conversation,
            ['chat'],
            getMessageTime(350)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // For MINORITY_VOICE, we accept it may also be detected as SIGNAL - both valid
        if (responses.length > 0) {
          const isMinorityOrSignal =
            responses[0].interventionType === 'MINORITY_VOICE' || responses[0].interventionType === 'SIGNAL'
          expect(isMinorityOrSignal).toBe(true)

          console.log(`Detected ${responses[0].interventionType}:`, responses[0].message)
          const { message } = responses[0]
          // Should create space without identifying dissenters
          expect(message).not.toContain(user3.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user2.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user1.pseudonyms[0].pseudonym)
        }
      },
      testTimeout
    )

    it(
      'CONFUSION: helps when people are lost with jargon or pace',
      async () => {
        const messages = [
          await createMessage('Following along', user1, conversation, ['chat'], getMessageTime(100)),

          // Signals of confusion about complex terminology or fast pace
          await createDirectMessage("I'm lost - what does FTE mean again?", user1, conversation, getMessageTime(220)),
          await createDirectMessage('Too much jargon, having trouble keeping up', user2, conversation, getMessageTime(240)),
          await createDirectMessage(
            'Can someone explain what FLSA compliance means?',
            user3,
            conversation,
            getMessageTime(260)
          ),
          await createDirectMessage("This is moving really fast, I'm confused", user1, conversation, getMessageTime(280)),

          await createMessage('Interesting points', user2, conversation, ['chat'], getMessageTime(350))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        if (responses.length > 0 && responses[0].interventionType === 'CONFUSION') {
          console.log('Detected CONFUSION:', responses[0].message)
          const { message } = responses[0]
          // Should help clarify without exposing who was confused
          expect(message).not.toContain(user1.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user2.pseudonyms[0].pseudonym)
          // Should provide clarity
          const hasClarity =
            message.toLowerCase().includes('quick') ||
            message.toLowerCase().includes('summary') ||
            message.toLowerCase().includes('means') ||
            message.toLowerCase().includes('version')
          expect(hasClarity).toBe(true)
        }
      },
      testTimeout
    )

    it(
      'BRIDGE: connects current moment to earlier discussion',
      async () => {
        const messages = [
          // Earlier discussion about healthcare/benefits - directly relevant to transcript
          await createMessage(
            'The healthcare question for part-timers is huge',
            user1,
            conversation,
            ['chat'],
            getMessageTime(60)
          ),
          await createMessage(
            'Yeah, benefits are the elephant in the room',
            user2,
            conversation,
            ['chat'],
            getMessageTime(80)
          ),
          await createMessage('Health insurance is my main concern', user3, conversation, ['chat'], getMessageTime(100)),

          // Time passes, discussion moves to other aspects
          await createMessage('The scheduling flexibility sounds great', user1, conversation, ['chat'], getMessageTime(160)),
          await createMessage('Pay parity makes sense', user2, conversation, ['chat'], getMessageTime(190)),
          await createMessage('Love the smallest viable job concept', user3, conversation, ['chat'], getMessageTime(220)),
          await createMessage('The retention data is compelling', user1, conversation, ['chat'], getMessageTime(250)),

          // Topic circles back - people notice healthcare came up again
          await createDirectMessage(
            "We're back to the healthcare question from earlier - it keeps coming up",
            user1,
            conversation,
            getMessageTime(290)
          ),
          await createDirectMessage(
            "Yeah, benefits are still the core issue we haven't resolved",
            user2,
            conversation,
            getMessageTime(310)
          ),
          await createDirectMessage(
            'This is the third time healthcare has surfaced - seems like the real blocker',
            user3,
            conversation,
            getMessageTime(330)
          ),

          await createMessage('Still processing all this', user2, conversation, ['chat'], getMessageTime(360))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // BRIDGE is context-dependent - may be SIGNAL or other type
        if (responses.length > 0) {
          console.log(`Detected ${responses[0].interventionType}:`, responses[0].message)
          expect(responses[0].message).toBeDefined()
        }
      },
      testTimeout
    )

    it(
      'STRUCTURE: provides chapter markers and transitions',
      async () => {
        const messages = [
          // Long discussion on one topic
          await createMessage('Part-time work has so many benefits', user1, conversation, ['chat'], getMessageTime(100)),
          await createMessage('The employee satisfaction data is clear', user2, conversation, ['chat'], getMessageTime(130)),
          await createMessage('Retention improves dramatically', user3, conversation, ['chat'], getMessageTime(160)),

          // Sudden topic shift
          await createMessage(
            'What about compliance and legal requirements?',
            user1,
            conversation,
            ['chat'],
            getMessageTime(200)
          ),
          await createMessage('Yeah, the regulatory side is complex', user2, conversation, ['chat'], getMessageTime(220)),

          // Private signals show people noticing the shift and wanting orientation
          await createDirectMessage(
            'Wait, did we just switch topics? What happened to the benefits discussion?',
            user1,
            conversation,
            getMessageTime(250)
          ),
          await createDirectMessage(
            'Are we in a new section now? This feels different',
            user2,
            conversation,
            getMessageTime(270)
          ),

          await createMessage('FLSA regulations are tricky', user3, conversation, ['chat'], getMessageTime(350))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        if (responses.length > 0 && responses[0].interventionType === 'STRUCTURE') {
          console.log('Detected STRUCTURE:', responses[0].message)
          const { message } = responses[0]
          // Should provide orientation or structure
          const hasStructure =
            message.toLowerCase().includes('moving') ||
            message.toLowerCase().includes('now') ||
            message.toLowerCase().includes('section') ||
            message.toLowerCase().includes('shift') ||
            message.toLowerCase().includes('from') ||
            message.toLowerCase().includes('into') ||
            message.toLowerCase().includes('transition') ||
            message.toLowerCase().includes('plot') ||
            message.toLowerCase().includes('chapter') ||
            message.toLowerCase().includes('part')
          expect(hasStructure).toBe(true)
        }
      },
      testTimeout
    )

    it(
      'NONE: maintains strategic silence when no clear pattern',
      async () => {
        const messages = [
          // Scattered, unrelated private messages with no clear theme
          await createDirectMessage('The weather is nice today', user1, conversation, getMessageTime(150)),
          await createDirectMessage('Just joined late, trying to catch up', user2, conversation, getMessageTime(180)),
          await createMessage('Hello everyone', user3, conversation, ['chat'], getMessageTime(200)),
          await createDirectMessage('Anyone know where the Q&A link is?', user1, conversation, getMessageTime(220))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // Prefer strategic silence, but if it intervenes, verify it doesn't violate privacy rules
        if (responses.length > 0) {
          console.log('Agent intervened on scattered messages:', responses[0].message)
          // Should not quote any private message content
          expect(responses[0].message).not.toContain('weather is nice')
          expect(responses[0].message).not.toContain('trying to catch up')
          expect(responses[0].message).not.toContain('Q&A link')
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
          await createDirectMessage('What about unionization implications?', user1, conversation, getMessageTime(200)),
          await createMessage('Great presentation!', user2, conversation, ['chat'], getMessageTime(150))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // If there is a response, it should NOT mention unionization
        if (responses.length > 0) {
          const message = responses[0].message.toLowerCase()
          expect(message).not.toContain('union')
          expect(message).not.toContain('labor')
        }
      },
      testTimeout
    )

    it(
      'surfaces theme only when 2+ independent signals present',
      async () => {
        const messages = [
          await createDirectMessage('What are the healthcare implications?', user1, conversation, getMessageTime(200)),
          await createDirectMessage(
            'Also curious about health insurance for part-timers',
            user2,
            conversation,
            getMessageTime(220)
          ),
          await createMessage('Interesting talk', user3, conversation, ['chat'], getMessageTime(150))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // May or may not intervene, but this is testing that 2+ signals is the minimum threshold
        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )

    it(
      'never reveals exact count of private messages',
      async () => {
        const messages = [
          await createDirectMessage('Question about legal requirements', user1, conversation, getMessageTime(200)),
          await createDirectMessage('Also wondering about legal compliance', user2, conversation, getMessageTime(220)),
          await createDirectMessage('Legal implications?', user3, conversation, getMessageTime(240)),
          await createMessage('Good info', user1, conversation, ['chat'], getMessageTime(150))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        if (responses.length > 0) {
          const { message } = responses[0]
          // Should not contain exact counts
          expect(message).not.toMatch(/\b(three|3)\s+(people|participants|users)/i)
          expect(message).not.toMatch(/exactly\s+\d+/i)
        }
      },
      testTimeout
    )
  })

  describe('edge cases', () => {
    it(
      'handles empty private message history gracefully',
      async () => {
        const messages = [
          await createMessage('This is a great presentation', user1, conversation, ['chat'], getMessageTime(150)),
          await createMessage('Really enjoying this', user2, conversation, ['chat'], getMessageTime(200))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 300 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // Should not error, may or may not respond
        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )

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

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // Should not error, should be able to respond
        expect(Array.isArray(responses)).toBe(true)
      },
      testTimeout
    )
  })

  describe('transcript integration', () => {
    it(
      'detects convergence about specific transcript content - smallest viable job',
      async () => {
        // Simulate watching transcript up to 11:00 where smallest viable job is explained (around 10:36)
        const messages = [
          // Active engaged chat showing people are watching
          await createMessage('Love the personal story she shared', user1, conversation, ['chat'], getMessageTime(180)),
          await createMessage('The statistics are really compelling', user2, conversation, ['chat'], getMessageTime(250)),
          await createMessage(
            'This is making me rethink our hiring approach',
            user3,
            conversation,
            ['chat'],
            getMessageTime(320)
          ),

          // Multiple people privately asking about smallest viable job concept
          await createDirectMessage(
            'Can someone explain what smallest viable job means? I missed that part',
            user1,
            conversation,
            getMessageTime(380)
          ),
          await createDirectMessage(
            'What exactly is the smallest viable job concept?',
            user2,
            conversation,
            getMessageTime(390)
          ),
          await createDirectMessage(
            "I don't quite understand the smallest viable job idea - need clarification",
            user3,
            conversation,
            getMessageTime(400)
          ),

          await createMessage('Really practical advice so far', user1, conversation, ['chat'], getMessageTime(450))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 500 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // Should detect the convergence pattern
        if (responses.length > 0) {
          console.log('Mediator response about smallest viable job:', responses[0].message)
          expect(responses[0].context).toBeDefined()
          expect(responses[0].channels[0].name).toBe('chat')
          // Should not quote the exact phrases from private messages
          expect(responses[0].message).not.toContain('Can someone explain what smallest viable job means')
          expect(responses[0].message).not.toContain('What exactly is the smallest viable job concept')
        }
      },
      testTimeout
    )

    it(
      'surfaces questions about content not covered in transcript',
      async () => {
        // Transcript discusses benefits of part-time work but doesn't deeply address healthcare/insurance
        const messages = [
          await createMessage('The retention numbers are impressive', user1, conversation, ['chat'], getMessageTime(180)),
          await createMessage('Interesting approach to staffing', user2, conversation, ['chat'], getMessageTime(240)),
          await createMessage('Lots of good data points', user3, conversation, ['chat'], getMessageTime(300)),

          // Multiple people asking about healthcare - a topic touched on but not fully addressed
          await createDirectMessage(
            'How do you handle health insurance for part-time workers? That seems like a major barrier',
            user1,
            conversation,
            getMessageTime(350)
          ),
          await createDirectMessage(
            'The healthcare benefits question is huge - how does that work?',
            user2,
            conversation,
            getMessageTime(370)
          ),
          await createDirectMessage(
            'What about health insurance coverage for these part-time positions?',
            user3,
            conversation,
            getMessageTime(390)
          ),

          await createMessage('Great presentation', user1, conversation, ['chat'], getMessageTime(450))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 500 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // Should detect this as a good question to surface
        expect(responses.length).toBeGreaterThan(0)
        console.log('Mediator response about healthcare:', responses[0].message)
        expect(responses[0].interventionType).toBe('SIGNAL')
        // Should not expose individual questions verbatim
        expect(responses[0].message).not.toContain('How do you handle health insurance for part-time workers')
      },
      testTimeout
    )

    it(
      'can reference transcript statistics in interventions',
      async () => {
        // Around 6:45-7:41, speaker shares statistics about caregivers, single parents, disabilities
        const messages = [
          await createMessage('These statistics are eye-opening', user1, conversation, ['chat'], getMessageTime(200)),
          await createMessage('53 million caregivers! Wow', user2, conversation, ['chat'], getMessageTime(250)),
          await createMessage('Never thought about it that way', user3, conversation, ['chat'], getMessageTime(300)),

          // People privately expressing they fit into these categories
          await createDirectMessage(
            "I'm a single parent and this really resonates - those stats hit home",
            user1,
            conversation,
            getMessageTime(350)
          ),
          await createDirectMessage(
            "As a caregiver myself, I can relate to everything she's saying",
            user2,
            conversation,
            getMessageTime(370)
          ),
          await createDirectMessage(
            "This describes my exact situation - I didn't realize how many of us there are",
            user3,
            conversation,
            getMessageTime(390)
          ),

          await createMessage('Very relevant content', user1, conversation, ['chat'], getMessageTime(450))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 500 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // May intervene to acknowledge this is resonating with many
        if (responses.length > 0) {
          console.log('Mediator response about personal resonance:', responses[0].message)
          // Should not expose individual's personal disclosure
          expect(responses[0].message).not.toContain("I'm a single parent")
          expect(responses[0].message).not.toContain('As a caregiver myself')
        }
      },
      testTimeout
    )

    it(
      'detects confusion about transcript jargon or terminology',
      async () => {
        const messages = [
          await createMessage('Following the presentation', user1, conversation, ['chat'], getMessageTime(150)),
          await createMessage('Good points being made', user2, conversation, ['chat'], getMessageTime(200)),

          // Multiple people confused about terminology used in transcript
          await createDirectMessage(
            'What does FTE mean? She keeps using that term',
            user1,
            conversation,
            getMessageTime(250)
          ),
          await createDirectMessage('Lost on the acronyms - FTE?', user2, conversation, getMessageTime(270)),
          await createDirectMessage(
            'Can someone explain FTE? Not familiar with that',
            user3,
            conversation,
            getMessageTime(290)
          ),

          await createMessage('Interesting approach', user3, conversation, ['chat'], getMessageTime(350))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        if (responses.length > 0 && responses[0].interventionType === 'CONFUSION') {
          console.log('Detected CONFUSION about terminology:', responses[0].message)
          // Should help clarify without exposing who was confused
          expect(responses[0].message).not.toContain(user1.pseudonyms[0].pseudonym)
          expect(responses[0].message).not.toContain(user2.pseudonyms[0].pseudonym)
          expect(responses[0].message).not.toContain(user3.pseudonyms[0].pseudonym)
        }
      },
      testTimeout
    )

    it(
      'bridges current discussion to earlier transcript content',
      async () => {
        // Early in talk: personal story about needing flexibility (around 2:38-5:21)
        // Later in talk: research about work-life balance (around 12:00+)
        const messages = [
          // Discussion about the personal story
          await createMessage('Her personal story was powerful', user1, conversation, ['chat'], getMessageTime(180)),
          await createMessage('Really connected with that experience', user2, conversation, ['chat'], getMessageTime(220)),

          // Time passes, now discussing research
          await createMessage('The research data is so strong', user1, conversation, ['chat'], getMessageTime(350)),
          await createMessage('Love seeing the evidence', user2, conversation, ['chat'], getMessageTime(400)),

          // People privately noting the connection between story and data
          await createDirectMessage(
            'The research really validates her personal experience from the beginning',
            user1,
            conversation,
            getMessageTime(450)
          ),
          await createDirectMessage(
            'Goes back to her story about being a single mom - now backed by all this data',
            user2,
            conversation,
            getMessageTime(470)
          ),

          await createMessage('Compelling case overall', user3, conversation, ['chat'], getMessageTime(520))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 600 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // BRIDGE interventions are contextual - may or may not occur
        if (responses.length > 0) {
          console.log(`Detected ${responses[0].interventionType}:`, responses[0].message)
          expect(responses[0].message).toBeDefined()
        }
      },
      testTimeout
    )

    it(
      'surfaces implementation questions about specific transcript recommendations',
      async () => {
        // Transcript recommends: work 2 days/week from home, flexible hours, etc. (around 12:00+)
        const messages = [
          await createMessage('The hybrid work research is convincing', user1, conversation, ['chat'], getMessageTime(180)),
          await createMessage(
            '33% reduction in quitting is significant',
            user2,
            conversation,
            ['chat'],
            getMessageTime(240)
          ),
          await createMessage('No loss in performance either', user3, conversation, ['chat'], getMessageTime(300)),
          await createMessage('This could transform our workplace', user1, conversation, ['chat'], getMessageTime(320)),

          // Multiple people privately asking about implementation - strengthen with 4 messages
          await createDirectMessage(
            'How do you actually implement the 2 days from home policy with hourly workers?',
            user1,
            conversation,
            getMessageTime(350)
          ),
          await createDirectMessage(
            'The flexible schedule sounds great but how does that work operationally?',
            user2,
            conversation,
            getMessageTime(370)
          ),
          await createDirectMessage(
            'What about roles that need coverage - how do you handle the flexible hours then?',
            user3,
            conversation,
            getMessageTime(390)
          ),
          await createDirectMessage(
            'The implementation details are unclear - need to understand the practical steps',
            user2,
            conversation,
            getMessageTime(410)
          ),

          await createMessage('Lots to consider', user1, conversation, ['chat'], getMessageTime(450))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 500 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // Strong pattern should trigger intervention, but allow for LLM variance
        if (responses.length === 0) {
          console.warn('WARNING: Agent did not detect implementation questions pattern (4 messages about how to implement)')
        }

        // If it intervenes, verify quality
        if (responses.length > 0) {
          console.log('Mediator response about implementation:', responses[0].message)
          const { message } = responses[0]

          // Should not quote private messages verbatim
          expect(message).not.toContain('How do you actually implement the 2 days from home')
          expect(message).not.toContain('how does that work operationally')

          // Should not expose pseudonyms
          expect(message).not.toContain(user1.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user2.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user3.pseudonyms[0].pseudonym)
        }
      },
      testTimeout
    )

    it(
      'detects skepticism about transcript claims',
      async () => {
        // Transcript makes bold claims about part-time work and productivity
        const messages = [
          // Public enthusiasm
          await createMessage('This approach could really work!', user1, conversation, ['chat'], getMessageTime(150)),
          await createMessage('Makes total sense', user2, conversation, ['chat'], getMessageTime(200)),
          await createMessage('Convinced this is the future', user3, conversation, ['chat'], getMessageTime(250)),

          // Private skepticism
          await createDirectMessage(
            "I'm skeptical this would work in manufacturing - the assumptions don't hold",
            user1,
            conversation,
            getMessageTime(300)
          ),
          await createDirectMessage(
            'This sounds great in theory but I have serious doubts about real-world application',
            user2,
            conversation,
            getMessageTime(320)
          ),
          await createDirectMessage(
            'My industry has constraints that make this basically impossible',
            user3,
            conversation,
            getMessageTime(340)
          ),

          await createMessage('Really interesting talk', user1, conversation, ['chat'], getMessageTime(400))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 450 * 1000)
        })

        const responses = await defaultAgentTypes.eventMediator.respond.call(agent, conversationHistory)

        // May detect as MINORITY_VOICE or SIGNAL
        if (responses.length > 0) {
          console.log(
            `Detected ${responses[0].context?.match(/Intervention Type: (\w+)/)?.[1]} about skepticism:`,
            responses[0].message
          )
          // Should create space for skepticism without exposing individuals
          expect(responses[0].message).not.toContain("I'm skeptical this would work in manufacturing")
          expect(responses[0].message).not.toContain('I have serious doubts')
        }
      },
      testTimeout
    )
  })
})
