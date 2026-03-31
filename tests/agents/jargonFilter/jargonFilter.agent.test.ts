import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createPublicTopic,
  createUser,
  loadTestTranscript,
  createJargonFilterConversation,
  jargonTranscript,
  plainLanguageTranscript
} from '../../utils/agentTestHelpers.js'
import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'
import User from '../../../src/models/user.model/user.model.js'
import { AgentMessageActions, IMessage } from '../../../src/types/index.types.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('jargonFilterAgent')

const testTimeout = 120000

describe('jargon filter agent tests', () => {
  let jargonFilterAgent
  let conversation
  let topic
  let userOptedIn
  let userOptedOut

  // startTime is 15 minutes in the past and the transcript starts 10 minutes into the past,
  // so all messages fit within the most recent 5-minute window.
  const startTime = new Date(Date.now() - 15 * 60 * 1000)

  beforeEach(async () => {
    userOptedIn = await createUser('Curious Badger')
    await User.findByIdAndUpdate(userOptedIn._id, { preferences: { jargonClarification: true } })

    // jargonClarification defaults to false
    userOptedOut = await createUser('Skeptical Owl')

    topic = await createPublicTopic()

    conversation = await createJargonFilterConversation(
      {
        name: 'Building Reliable Distributed Systems',
        description: 'A deep dive into distributed systems engineering practices.'
      },
      userOptedIn,
      topic,
      startTime,
      testConfig.llmPlatform,
      testConfig.llmModel,
      [userOptedOut]
    )

    jargonFilterAgent = conversation.agents.find((agent) => agent.name === 'Jargon Filter Agent')
  })

  describe('agent configuration', () => {
    it('has correct default configuration', () => {
      expect(jargonFilterAgent.name).toBe('Jargon Filter Agent')
    })

    it('uses periodic trigger on transcript with 120 second interval and 120 second time window', () => {
      expect(jargonFilterAgent.triggers.periodic).toBeDefined()
      expect(jargonFilterAgent.triggers.periodic.timerPeriod).toBe(120)
      expect(jargonFilterAgent.triggers.periodic.conversationHistorySettings.channels).toContain('transcript')
      expect(jargonFilterAgent.triggers.periodic.conversationHistorySettings.timeWindow).toBe(120)
    })

    it('uses perMessage trigger for direct messages', () => {
      expect(jargonFilterAgent.triggers.perMessage).toBeDefined()
      expect(jargonFilterAgent.triggers.perMessage.directMessages).toBe(true)
    })
  })

  describe('jargon detection', () => {
    it(
      'detects jargon and posts clarification to opted-in channels only',
      async () => {
        await loadTestTranscript(conversation, jargonTranscript)

        const conversationHistory = getConversationHistory(conversation.messages, {
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 5 * 60 * 1000) // the agent looks back 5 min from endTime, so endTime = startTime + 5min puts the test messages in that window
        })

        const responses = await defaultAgentTypes.jargonFilterAgent.respond.call(jargonFilterAgent, conversationHistory)

        // Jargon-heavy transcript — expect a clarification to be posted
        expect(responses.length).toBeGreaterThan(0)

        const response = responses[0]
        expect(response.visible).toBe(true)
        expect(response.messageType).toBe('json')
        expect(response.message.text).toBeTruthy()

        // text must begin with a summary section followed by bullet points
        expect(response.message.text).toMatch(/\*\*Summary:\*\*/)
        expect(response.message.text).toMatch(/- \*\*.+\*\*/)

        // sourceText is a verbatim quote from the transcript — assert it contains a known jargon term
        const knownJargonTerms = [
          'SLO',
          'mTLS',
          'MTTR',
          'write-ahead logging',
          'consistent hashing',
          'error budget',
          'thundering herd',
          'exponential backoff'
        ]
        expect(knownJargonTerms.some((term) => response.message.sourceText.includes(term))).toBe(true)

        // transcriptWindow reflects the conversationHistory boundaries passed to respond()
        expect(response.message.transcriptWindow.start).toBe(conversationHistory.start.getTime())
        expect(response.message.transcriptWindow.end).toBe(conversationHistory.end.getTime())

        // Only the opted-in user's direct channel should be targeted
        const channelNames = response.channels.map((c) => c.name)
        expect(channelNames).toContain(`direct-agents-${userOptedIn._id}`)
        expect(channelNames).not.toContain(`direct-agents-${userOptedOut._id}`)
      },
      testTimeout
    )

    it(
      'uses only the messages passed in conversationHistory, not the full conversation history',
      async () => {
        // Load jargon-heavy transcript into the conversation
        await loadTestTranscript(conversation, jargonTranscript)

        // Pass an empty conversationHistory — simulates the framework providing a pre-filtered
        // window with no messages (e.g. nothing new in the last 2 minutes).
        // If respond() were still calling getConversationHistory internally, it would find
        // messages in conversation.messages and produce a response. It should not.
        const emptyHistory = getConversationHistory(conversation.messages, {
          channels: ['transcript'],
          timeWindow: 0,
          endTime: startTime // before any messages were loaded
        })

        const responses = await defaultAgentTypes.jargonFilterAgent.respond.call(jargonFilterAgent, emptyHistory)

        expect(responses).toHaveLength(0)
      },
      testTimeout
    )

    it(
      'returns no response when transcript contains no jargon',
      async () => {
        await loadTestTranscript(conversation, plainLanguageTranscript)

        const conversationHistory = getConversationHistory(conversation.messages, {
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 5 * 60 * 1000) // the agent looks back 5 min from endTime, so endTime = startTime + 5min puts the test messages in that window
        })

        const responses = await defaultAgentTypes.jargonFilterAgent.respond.call(jargonFilterAgent, conversationHistory)

        expect(responses).toHaveLength(0)
      },
      testTimeout
    )

    it(
      'returns no response when jargon is found but no users have opted in',
      async () => {
        // Remove the opted-in preference
        await User.findByIdAndUpdate(userOptedIn._id, { preferences: { jargonClarification: false } })

        await loadTestTranscript(conversation, jargonTranscript)

        const conversationHistory = getConversationHistory(conversation.messages, {
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 5 * 60 * 1000) // the agent looks back 5 min from endTime, so endTime = startTime + 5min puts the test messages in that window
        })

        const responses = await defaultAgentTypes.jargonFilterAgent.respond.call(jargonFilterAgent, conversationHistory)

        expect(responses).toHaveLength(0)
      },
      testTimeout
    )
  })

  describe('posting clarification messages', () => {
    it(
      'targets direct channels where the jargon filter agent is authorized to post',
      async () => {
        await loadTestTranscript(conversation, jargonTranscript)

        const conversationHistory = getConversationHistory(conversation.messages, {
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 5 * 60 * 1000)
        })

        const responses = await defaultAgentTypes.jargonFilterAgent.respond.call(jargonFilterAgent, conversationHistory)
        expect(responses.length).toBeGreaterThan(0)

        // The jargon filter posts via newMessageHandler(response, jargonFilterAgent).
        // authChannels checks that the posting agent is a participant in each direct channel.
        // All targeted channels must include the jargon filter agent as a participant.
        for (const response of responses) {
          for (const channel of response.channels) {
            const participantIds = channel.participants?.map((p) => p._id.toString()) ?? []
            expect(participantIds).toContain(jargonFilterAgent._id.toString())
          }
        }
      },
      testTimeout
    )
  })

  describe('seen terms memory', () => {
    it(
      'includes a terms array in the response listing each jargon term explained',
      async () => {
        await loadTestTranscript(conversation, jargonTranscript)

        const conversationHistory = getConversationHistory(conversation.messages, {
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 5 * 60 * 1000)
        })

        const responses = await defaultAgentTypes.jargonFilterAgent.respond.call(jargonFilterAgent, conversationHistory)
        expect(responses.length).toBeGreaterThan(0)

        const { terms } = responses[0].message
        expect(Array.isArray(terms)).toBe(true)
        expect(terms.length).toBeGreaterThan(0)
        terms.forEach((term) => expect(typeof term).toBe('string'))
      },
      testTimeout
    )

    it(
      'skips terms already explained in a previous window',
      async () => {
        await loadTestTranscript(conversation, jargonTranscript)

        const conversationHistory = getConversationHistory(conversation.messages, {
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 5 * 60 * 1000)
        })

        // First invocation — agent sees jargon and clarifies it
        const firstResponses = await defaultAgentTypes.jargonFilterAgent.respond.call(jargonFilterAgent, conversationHistory)
        expect(firstResponses.length).toBeGreaterThan(0)

        // Simulate the agent's response being saved to the conversation so the next invocation can see it
        const firstMessage = firstResponses[0].message
        conversation.messages.push({
          body: firstMessage,
          bodyType: 'json',
          fromAgent: true,
          channels: firstResponses[0].channels.map((c) => c.name),
          pseudonym: jargonFilterAgent.pseudonyms[0].pseudonym,
          createdAt: new Date(),
          updatedAt: new Date()
        } as unknown as IMessage)

        // Second invocation with the same transcript window — all terms already seen
        const secondResponses = await defaultAgentTypes.jargonFilterAgent.respond.call(jargonFilterAgent, conversationHistory)
        expect(secondResponses).toHaveLength(0)
      },
      testTimeout
    )
  })

  describe('jargon agent on meeting start', () => {
    it('does not introduce itself', async () => {
      const [chatChannel] = conversation.channels.filter((c) => c.name === 'chat')
      const agentType = defaultAgentTypes.jargonFilterAgent
      const msgs = await agentType.introduce.call(jargonFilterAgent, chatChannel)
      expect(msgs).toEqual([])
    })
  })

  describe('interactive mode - direct message handling', () => {
    describe('evaluate()', () => {
      it('returns CONTRIBUTE for periodic trigger (no userMessage)', async () => {
        const evaluation = await defaultAgentTypes.jargonFilterAgent.evaluate.call(jargonFilterAgent, undefined)
        expect(evaluation.action).toBe(AgentMessageActions.CONTRIBUTE)
      })

      it('returns CONTRIBUTE when userMessage has parentMessage (threaded reply)', async () => {
        const userMessage = {
          _id: 'message123',
          body: 'Can you explain more about SLO?',
          parentMessage: 'parent456',
          channels: [`direct-agents-${userOptedIn._id}`],
          owner: userOptedIn._id
        }

        const evaluation = await defaultAgentTypes.jargonFilterAgent.evaluate.call(jargonFilterAgent, userMessage)
        expect(evaluation.action).toBe(AgentMessageActions.CONTRIBUTE)
      })

      it('returns OK when userMessage has no parentMessage (non-threaded DM)', async () => {
        const userMessage = {
          _id: 'message123',
          body: 'Hello, what is an API?',
          channels: [`direct-agents-${userOptedIn._id}`],
          owner: userOptedIn._id
        }

        const evaluation = await defaultAgentTypes.jargonFilterAgent.evaluate.call(jargonFilterAgent, userMessage)
        expect(evaluation.action).toBe(AgentMessageActions.OK)
      })
    })

    describe('respond() with userMessage', () => {
      it(
        'responds to on-topic jargon question with conversational answer',
        async () => {
          // Create a mock direct channel
          const directChannel = conversation.channels.find((c) => c.name === `direct-agents-${userOptedIn._id}`)

          const userMessage = {
            _id: 'message123',
            body: 'Can you explain more about SLO?',
            parentMessage: 'parent456',
            channels: [directChannel.name],
            owner: userOptedIn._id
          }

          // Create minimal conversation history
          const conversationHistory = {
            messages: [],
            start: new Date(),
            end: new Date()
          }

          const responses = await defaultAgentTypes.jargonFilterAgent.respond.call(
            jargonFilterAgent,
            conversationHistory,
            userMessage
          )

          expect(responses).toHaveLength(1)
          const response = responses[0]

          expect(response.visible).toBe(true)
          expect(response.messageType).toBe('json')
          expect(response.message.type).toBe('jargon_follow_up')
          expect(response.message.text).toBeTruthy()

          // Should be conversational, not the structured Summary + bullets format
          expect(response.message.text).not.toMatch(/\*\*Summary:\*\*/)

          // Should thread the response
          expect(response.parent).toBe(userMessage.parentMessage)

          // Should target the correct channel
          expect(response.channels.map((c) => c.name)).toContain(directChannel.name)
        },
        testTimeout
      )

      it(
        'responds to off-topic question with polite decline',
        async () => {
          const directChannel = conversation.channels.find((c) => c.name === `direct-agents-${userOptedIn._id}`)

          const userMessage = {
            _id: 'message123',
            body: 'What time does the event end?',
            parentMessage: 'parent456',
            channels: [directChannel.name],
            owner: userOptedIn._id
          }

          const conversationHistory = {
            messages: [],
            start: new Date(),
            end: new Date()
          }

          const responses = await defaultAgentTypes.jargonFilterAgent.respond.call(
            jargonFilterAgent,
            conversationHistory,
            userMessage
          )

          expect(responses).toHaveLength(1)
          const response = responses[0]

          expect(response.visible).toBe(true)
          expect(response.messageType).toBe('json')
          expect(response.message.type).toBe('jargon_follow_up')
          expect(response.message.text).toContain('I can only help clarify jargon')

          // Should thread the response
          expect(response.parent).toBe(userMessage.parentMessage)

          // Should target the correct channel
          expect(response.channels.map((c) => c.name)).toContain(directChannel.name)
        },
        testTimeout
      )

      it(
        'uses conversation history for context when answering',
        async () => {
          const directChannel = conversation.channels.find((c) => c.name === `direct-agents-${userOptedIn._id}`)

          // Simulate previous clarification in history
          const previousMessage = {
            _id: 'parent456',
            body: 'Previous clarification about SLO meaning Service Level Objective',
            pseudonym: 'Jargon Filter Agent',
            fromAgent: true,
            channels: [directChannel.name],
            createdAt: new Date(Date.now() - 2 * 60 * 1000)
          }

          const userMessage = {
            _id: 'message123',
            body: 'Can you give an example?',
            parentMessage: 'parent456',
            channels: [directChannel.name],
            owner: userOptedIn._id
          }

          const conversationHistory = {
            messages: [previousMessage],
            start: new Date(Date.now() - 5 * 60 * 1000),
            end: new Date()
          }

          const responses = await defaultAgentTypes.jargonFilterAgent.respond.call(
            jargonFilterAgent,
            conversationHistory,
            userMessage
          )

          expect(responses).toHaveLength(1)
          const response = responses[0]

          expect(response.visible).toBe(true)
          expect(response.message.text).toBeTruthy()
          // The LLM should provide a contextual answer based on conversation history
        },
        testTimeout
      )
    })
  })
})
