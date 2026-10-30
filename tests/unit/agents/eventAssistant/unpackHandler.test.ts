import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import type { UnpackExplanation } from '../../../../src/types/index.types.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAgentStructuredResponse = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getSinglePromptResponse: jest.fn(),
  getRAGAugmentedResponse: jest.fn(),
  getChatPromptResponse: mockGetChatPromptResponse,
  shouldUseStructuredOutput: jest.fn(),
  pingLLM: jest.fn(),
  getStructuredResponseChain: jest.fn(),
  getAgentStructuredResponse: mockGetAgentStructuredResponse,
  extractToolCallTraceFromAgentResult: jest.fn(),
  extractCompleteSentences: jest.fn(),
  streamAgentAndReportChunks: jest.fn()
}))

const {
  default: handleUnpackRequest,
  isUnpackRequest,
  UNPACK_LAST_MINUTE_WINDOW_SECONDS,
  UNPACK_REQUESTS_PER_MINUTE,
  UNPACK_REPLIES
} = await import('../../../../src/agents/eventAssistant/unpackHandler.js')
const { default: eventAssistant } = await import('../../../../src/agents/eventAssistant/eventAssistant.js')
const { default: UnpackRequest } = await import('../../../../src/models/unpackRequest.model.js')
const { AgentMessageActions } = await import('../../../../src/types/index.types.js')
const { default: PLAIN_LANGUAGE_TERM_RULES } = await import('../../../../src/agents/helpers/plainLanguageRules.js')

setupIntTest()

const SECOND = 1000
const userId = new mongoose.Types.ObjectId()
const privateChat = { name: `direct-${userId}-agent`, direct: true }

const explanation = {
  whatTheyreSaying: 'The speaker says teams set a reliability target and track it.',
  whyItMatters: 'It sets up the talk about how outages get prioritized.',
  terms: [{ term: 'SLO', text: 'A target for how reliable a service should be.' }]
}

function transcriptChunk(body: string, secondsBefore: number, now: number) {
  return {
    _id: new mongoose.Types.ObjectId(),
    body,
    channels: ['transcript'],
    createdAt: new Date(now - secondsBefore * SECOND)
  }
}

function buildAgent({ features = [{ name: 'unpacker', enabled: true }], messages = [] as unknown[] } = {}) {
  return {
    agentConfig: { botName: 'Berkie' },
    conversation: {
      _id: new mongoose.Types.ObjectId(),
      name: 'Reliability engineering',
      features,
      channels: [privateChat, { name: 'chat' }, { name: 'transcript' }],
      messages
    },
    getLLM: async () => ({})
  }
}

function unpackMessage(body: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    owner: userId,
    bodyType: 'json',
    body: { type: 'unpack_request', mode: 'lastMinute', text: 'Unpack 10:43 AM', ...body },
    channels: [privateChat.name],
    createdAt: new Date(),
    ...overrides
  }
}

function earlierRequest(secondsBefore: number, now: number, owner = userId) {
  return unpackMessage({}, { owner, createdAt: new Date(now - secondsBefore * SECOND) })
}

function lastMinuteTranscript(now: number) {
  return [
    transcriptChunk('Too old to include.', UNPACK_LAST_MINUTE_WINDOW_SECONDS + 30, now),
    transcriptChunk('We track every service against an SLO.', 50, now),
    { ...transcriptChunk('Group chat, not transcript.', 20, now), channels: ['chat'] },
    transcriptChunk('Missing it eats the error budget.', 10, now)
  ]
}

beforeEach(() => {
  mockGetChatPromptResponse.mockReset()
  mockGetAgentStructuredResponse.mockReset()
  mockGetChatPromptResponse.mockResolvedValue(explanation)
})

describe('isUnpackRequest', () => {
  it('recognizes a JSON message labelled unpack_request', () => {
    expect(isUnpackRequest(unpackMessage())).toBe(true)
  })

  it.each([
    ['a text message', { bodyType: 'text', body: 'Unpack the last minute' }],
    ['a slash command body', { bodyType: 'json', body: { command: 'unpack', text: 'x' } }],
    ['no message', undefined]
  ])('rejects %s', (_name, message) => {
    expect(isUnpackRequest(message)).toBe(false)
  })
})

describe('handleUnpackRequest', () => {
  describe('with the unpacker switch on and transcript in the last minute', () => {
    it('replies in Private Chat with an unpack_explanation built from the last minute only', async () => {
      const now = Date.now()
      const messages = lastMinuteTranscript(now)
      const agent = buildAgent({ messages })
      const request = unpackMessage({}, { createdAt: new Date(now) })

      const [reply] = await handleUnpackRequest(agent, request)

      expect(reply.messageType).toBe('json')
      expect(reply.channels).toEqual([privateChat])
      expect(reply.message).toMatchObject({
        type: 'unpack_explanation',
        mode: 'lastMinute',
        destination: 'privateChat',
        requestMessage: request._id.toString(),
        chunkIds: [messages[1]._id.toString(), messages[3]._id.toString()],
        passage: { start: messages[1].createdAt.toISOString(), end: messages[3].createdAt.toISOString() },
        quote: 'We track every service against an SLO. Missing it eats the error budget.',
        ...explanation
      })
    })

    it('includes a plain-text copy of every section for chat history and text-only clients', async () => {
      const now = Date.now()
      const [reply] = await handleUnpackRequest(buildAgent({ messages: lastMinuteTranscript(now) }), unpackMessage())

      expect((reply.message as UnpackExplanation).text).toContain(explanation.whatTheyreSaying)
      expect((reply.message as UnpackExplanation).text).toContain(explanation.whyItMatters)
      expect((reply.message as UnpackExplanation).text).toContain('SLO: A target for how reliable a service should be.')
    })

    it('records the request against the user ID and the ID the reply will be saved under', async () => {
      const now = Date.now()
      const agent = buildAgent({ messages: lastMinuteTranscript(now) })
      const request = unpackMessage()

      const [reply] = await handleUnpackRequest(agent, request)

      const rows = await UnpackRequest.find({ conversation: agent.conversation._id })
      expect(rows).toHaveLength(1)
      expect(rows[0].user.equals(userId)).toBe(true)
      expect(rows[0].requestMessage!.equals(request._id)).toBe(true)
      expect(rows[0].answerMessage.equals(reply.messageId!)).toBe(true)
      expect(rows[0].chunkIds).toHaveLength(2)
    })

    it('still sends the explanation when the request cannot be recorded', async () => {
      jest.spyOn(UnpackRequest, 'create').mockRejectedValueOnce(new Error('database unavailable'))

      const [reply] = await handleUnpackRequest(buildAgent({ messages: lastMinuteTranscript(Date.now()) }), unpackMessage())

      expect((reply.message as UnpackExplanation).type).toBe('unpack_explanation')
    })

    it("counts back from when the participant asked, not when Berkie's job runs", async () => {
      const askedAt = Date.now() - 5 * 60 * SECOND
      const messages = [
        transcriptChunk('Said five minutes ago.', 10, askedAt),
        transcriptChunk('Said just now.', 5, Date.now())
      ]
      const request = unpackMessage({}, { createdAt: new Date(askedAt) })

      const [reply] = await handleUnpackRequest(buildAgent({ messages }), request)

      expect((reply.message as UnpackExplanation).chunkIds).toEqual([messages[0]._id.toString()])
    })

    it('sends the passage and the shared plain-language rules to the AI model', async () => {
      await handleUnpackRequest(buildAgent({ messages: lastMinuteTranscript(Date.now()) }), unpackMessage())

      const [, systemPrompt, , inputs] = mockGetChatPromptResponse.mock.calls[0]
      expect(systemPrompt).toContain(PLAIN_LANGUAGE_TERM_RULES)
      expect(inputs.transcript).toContain('We track every service against an SLO.')
      expect(inputs.transcript).not.toContain('Too old to include.')
    })
  })

  describe('when it should not answer', () => {
    it.each([
      ['the switch is off', [{ name: 'unpacker', enabled: false }]],
      ['the event predates the switch', []]
    ])('stays silent when %s', async (_name, features) => {
      const agent = buildAgent({ features, messages: lastMinuteTranscript(Date.now()) })

      expect(await handleUnpackRequest(agent, unpackMessage())).toEqual([])
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it('stays silent for a mode this version does not support', async () => {
      const agent = buildAgent({ messages: lastMinuteTranscript(Date.now()) })

      expect(await handleUnpackRequest(agent, unpackMessage({ mode: 'selection' }))).toEqual([])
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it('stays silent when the request was not sent in a Private Chat', async () => {
      const agent = buildAgent({ messages: lastMinuteTranscript(Date.now()) })

      expect(await handleUnpackRequest(agent, unpackMessage({}, { channels: ['chat'] }))).toEqual([])
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })
  })

  describe('short text replies', () => {
    it('says so when no transcript arrived in the last minute, without calling the AI model', async () => {
      const now = Date.now()
      const agent = buildAgent({ messages: [transcriptChunk('Long ago.', 600, now)] })

      const [reply] = await handleUnpackRequest(agent, unpackMessage())

      expect(reply).toMatchObject({ messageType: 'text', message: UNPACK_REPLIES.noTranscript, channels: [privateChat] })
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
      expect(await UnpackRequest.countDocuments()).toBe(0)
    })

    it('asks the participant to wait once they hit the per-minute limit, even before any earlier request is answered', async () => {
      const now = Date.now()
      const earlierRequests = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) => earlierRequest(5 + i, now))
      const agent = buildAgent({ messages: [...lastMinuteTranscript(now), ...earlierRequests] })

      const [reply] = await handleUnpackRequest(agent, unpackMessage({}, { createdAt: new Date(now) }))

      expect(reply).toMatchObject({ messageType: 'text', message: UNPACK_REPLIES.rateLimited })
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it("doesn't count other people's requests or requests from over a minute ago toward the limit", async () => {
      const now = Date.now()
      const messages = [
        ...lastMinuteTranscript(now),
        ...Array.from({ length: UNPACK_REQUESTS_PER_MINUTE - 1 }, (_, i) => earlierRequest(5 + i, now)),
        earlierRequest(UNPACK_LAST_MINUTE_WINDOW_SECONDS + 5, now),
        earlierRequest(5, now, new mongoose.Types.ObjectId())
      ]
      const request = unpackMessage({}, { createdAt: new Date(now) })

      const [reply] = await handleUnpackRequest(buildAgent({ messages: [...messages, request] }), request)

      expect((reply.message as UnpackExplanation).type).toBe('unpack_explanation')
    })

    it('apologizes and records nothing when the AI model call fails', async () => {
      mockGetChatPromptResponse.mockRejectedValue(new Error('model unavailable'))
      const agent = buildAgent({ messages: lastMinuteTranscript(Date.now()) })

      const [reply] = await handleUnpackRequest(agent, unpackMessage())

      expect(reply).toMatchObject({ messageType: 'text', message: UNPACK_REPLIES.failed })
      expect(await UnpackRequest.countDocuments()).toBe(0)
    })
  })
})

describe('Event Assistant routing', () => {
  it('accepts an unpack request in evaluate() instead of handing a JSON body to the slash-command parser', async () => {
    const request = unpackMessage()

    const evaluation = await eventAssistant.evaluate.call(buildAgent(), request)

    expect(evaluation).toMatchObject({ action: AgentMessageActions.CONTRIBUTE, userMessage: request })
  })

  it('answers an unpack request with an explanation, not as an ordinary question', async () => {
    const agent = buildAgent({ messages: lastMinuteTranscript(Date.now()) })

    const [reply] = await eventAssistant.respond.call(agent, { messages: [] }, unpackMessage())

    expect(reply.message.type).toBe('unpack_explanation')
    expect(mockGetAgentStructuredResponse).not.toHaveBeenCalled()
  })

  it('ignores an unpack request entirely while the switch is off', async () => {
    const agent = buildAgent({ features: [], messages: lastMinuteTranscript(Date.now()) })

    expect(await eventAssistant.respond.call(agent, { messages: [] }, unpackMessage())).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    expect(mockGetAgentStructuredResponse).not.toHaveBeenCalled()
  })
})
