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
        const knownJargonTerms = ['SLO', 'mTLS', 'MTTR', 'write-ahead logging', 'consistent hashing', 'error budget', 'thundering herd', 'exponential backoff']
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

  describe('jargon agent on meeting start', () => {
    it('does not introduce itself', async () => {
      const [chatChannel] = conversation.channels.filter((c) => c.name === 'chat')
      const agentType = defaultAgentTypes.jargonFilterAgent
      const msgs = await agentType.introduce.call(jargonFilterAgent, chatChannel)
      expect(msgs).toEqual([])
    })
  })
})
