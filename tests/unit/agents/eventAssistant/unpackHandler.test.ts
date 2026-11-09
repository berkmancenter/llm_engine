import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import type { CatchUpRefused, CatchUpSummary } from '../../../../src/types/index.types.js'

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
  UNPACK_CATCH_UP_MAX_CHARACTERS,
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

const summary = {
  inShort: 'Teams set a reliability target for each service. Missing it uses up their budget for mistakes.',
  whatTheyCovered: ['Every service has a reliability target', 'Missing the target uses up the error budget'],
  comingUp: 'A demo of the dashboard teams use to track this.'
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
    // Catch-ups run on the Unpacker model setting, so the assistant's own model must never be asked for
    getLLM: async () => {
      throw new Error('catch-ups must not use the assistant model')
    }
  }
}

// A saved message's ID embeds the second the server created it, so fixtures keep the two in step
function objectIdAt(time: Date) {
  return new mongoose.Types.ObjectId(Math.floor(time.getTime() / SECOND))
}

function unpackMessage(body: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const createdAt = (overrides.createdAt as Date | undefined) ?? new Date()
  return {
    _id: objectIdAt(createdAt),
    owner: userId,
    bodyType: 'json',
    body: { type: 'unpack_request', mode: 'lastMinute', text: 'Catch me up', chunkIds: [], ...body },
    channels: [privateChat.name],
    createdAt,
    ...overrides
  }
}

function catchUpRequest(chunks: { _id: mongoose.Types.ObjectId }[], overrides: Record<string, unknown> = {}) {
  return unpackMessage({ chunkIds: chunks.map(({ _id }) => _id.toString()) }, overrides)
}

function earlierRequest(secondsBefore: number, now: number, owner = userId) {
  return unpackMessage({}, { owner, createdAt: new Date(now - secondsBefore * SECOND) })
}

function talk(now: number) {
  const older = transcriptChunk('Before we start, lunch is at noon.', 5 * 60, now)
  const first = transcriptChunk('We track every service against an SLO.', 50, now)
  const chat = { ...transcriptChunk('Group chat, not transcript.', 20, now), channels: ['chat'] }
  const second = transcriptChunk('Missing it eats the error budget.', 10, now)
  return { older, first, chat, second, messages: [older, first, chat, second] }
}

beforeEach(() => {
  mockGetChatPromptResponse.mockReset()
  mockGetAgentStructuredResponse.mockReset()
  mockGetChatPromptResponse.mockResolvedValue(summary)
})

describe('isUnpackRequest', () => {
  it('recognizes a JSON message labelled unpack_request', () => {
    expect(isUnpackRequest(unpackMessage())).toBe(true)
  })

  it.each([
    ['a text message', { bodyType: 'text', body: 'Catch me up' }],
    ['a slash command body', { bodyType: 'json', body: { command: 'unpack', text: 'x' } }],
    ['no message', undefined]
  ])('rejects %s', (_name, message) => {
    expect(isUnpackRequest(message)).toBe(false)
  })
})

describe('handleUnpackRequest', () => {
  describe('summarizing the passages the participant was shown', () => {
    it('posts a catch_up_summary of exactly the chunks it was sent, oldest first', async () => {
      const now = Date.now()
      const { first, second, messages } = talk(now)
      const request = catchUpRequest([second, first, second], { createdAt: new Date(now) })

      const [reply] = await handleUnpackRequest(buildAgent({ messages }), request)

      expect(reply.messageType).toBe('json')
      expect(reply.channels).toEqual([privateChat])
      expect(reply.message).toMatchObject({
        type: 'catch_up_summary',
        requestMessage: request._id.toString(),
        chunkIds: [first._id.toString(), second._id.toString()],
        passage: { start: first.createdAt.toISOString(), end: second.createdAt.toISOString() },
        earlierSpeech: false,
        ...summary
      })
    })

    it('includes a plain-text copy of every section for chat history and text-only clients', async () => {
      const { first, second, messages } = talk(Date.now())

      const [reply] = await handleUnpackRequest(buildAgent({ messages }), catchUpRequest([first, second]))

      const { text } = reply.message as CatchUpSummary
      expect(text).toContain(summary.inShort)
      summary.whatTheyCovered.forEach((point) => expect(text).toContain(point))
      expect(text).toContain(summary.comingUp)
    })

    it('leaves "Coming up" out when the speaker announced nothing', async () => {
      mockGetChatPromptResponse.mockResolvedValue({ ...summary, comingUp: null })
      const { first, second, messages } = talk(Date.now())

      const [reply] = await handleUnpackRequest(buildAgent({ messages }), catchUpRequest([first, second]))

      expect((reply.message as CatchUpSummary).comingUp).toBeNull()
      expect((reply.message as CatchUpSummary).text).not.toMatch(/coming up/i)
    })

    it('keeps at most five points under "What they covered"', async () => {
      const points = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven']
      mockGetChatPromptResponse.mockResolvedValue({ ...summary, whatTheyCovered: points })
      const { first, second, messages } = talk(Date.now())

      const [reply] = await handleUnpackRequest(buildAgent({ messages }), catchUpRequest([first, second]))

      expect((reply.message as CatchUpSummary).whatTheyCovered).toEqual(points.slice(0, 5))
    })

    it('sends only the chosen passages, the event topic and the plain-language rules to the AI model', async () => {
      const { first, second, messages } = talk(Date.now())

      await handleUnpackRequest(buildAgent({ messages }), catchUpRequest([first, second]))

      const [, systemPrompt, , inputs] = mockGetChatPromptResponse.mock.calls[0]
      expect(systemPrompt).toContain(PLAIN_LANGUAGE_TERM_RULES)
      expect(inputs.topic).toBe('Reliability engineering')
      expect(inputs.transcript).toContain('We track every service against an SLO.')
      expect(inputs.transcript).toContain('Missing it eats the error budget.')
      expect(inputs.transcript).not.toContain('lunch is at noon')
    })

    it('records the request against the user ID and the ID the reply will be saved under', async () => {
      const { first, second, messages } = talk(Date.now())
      const agent = buildAgent({ messages })
      const request = catchUpRequest([first, second])

      const [reply] = await handleUnpackRequest(agent, request)

      const rows = await UnpackRequest.find({ conversation: agent.conversation._id })
      expect(rows).toHaveLength(1)
      expect(rows[0].user.equals(userId)).toBe(true)
      expect(rows[0].mode).toBe('lastMinute')
      expect(rows[0].status).toBe('sent')
      expect(rows[0].requestMessage!.equals(request._id)).toBe(true)
      expect(rows[0].answerMessage!.equals(reply.messageId!)).toBe(true)
      expect(rows[0].chunkIds.map((id) => id.toString())).toEqual([first._id.toString(), second._id.toString()])
      expect(rows[0].quote).toBe('We track every service against an SLO. Missing it eats the error budget.')
    })

    it('still sends the summary when the request cannot be recorded', async () => {
      jest.spyOn(UnpackRequest, 'create').mockRejectedValueOnce(new Error('database unavailable'))
      const { first, second, messages } = talk(Date.now())

      const [reply] = await handleUnpackRequest(buildAgent({ messages }), catchUpRequest([first, second]))

      expect((reply.message as CatchUpSummary).type).toBe('catch_up_summary')
    })
  })

  describe('earlier speech', () => {
    function askAfterSilence(silenceSeconds: number, requestOverrides: Record<string, unknown> = {}) {
      const now = Date.now()
      const chunk = transcriptChunk('We track every service against an SLO.', silenceSeconds, now)
      const request = catchUpRequest([chunk], { createdAt: new Date(now), ...requestOverrides })
      return handleUnpackRequest(buildAgent({ messages: [chunk] }), request)
    }

    it('is false when the newest passage ended within the last 60 seconds', async () => {
      const [reply] = await askAfterSilence(UNPACK_LAST_MINUTE_WINDOW_SECONDS - 1)

      expect((reply.message as CatchUpSummary).earlierSpeech).toBe(false)
    })

    it('is true when the newest passage ended over 60 seconds before the request, and the AI model is told', async () => {
      const [reply] = await askAfterSilence(UNPACK_LAST_MINUTE_WINDOW_SECONDS + 1)

      expect((reply.message as CatchUpSummary).earlierSpeech).toBe(true)
      const [, , , inputs] = mockGetChatPromptResponse.mock.calls[0]
      expect(inputs.timing).toMatch(/nothing was said in the last 60 seconds/i)
    })

    it('mentions the earlier speech in the plain-text copy', async () => {
      const [reply] = await askAfterSilence(UNPACK_LAST_MINUTE_WINDOW_SECONDS + 1)

      expect((reply.message as CatchUpSummary).text).toMatch(/nothing was said in the last 60 seconds/i)
    })

    it("counts from when the participant asked, not when Berkie's job runs", async () => {
      const askedAt = Date.now() - 5 * 60 * SECOND
      const chunk = transcriptChunk('Said just before the request.', 10, askedAt)
      const request = catchUpRequest([chunk], { createdAt: new Date(askedAt) })

      const [reply] = await handleUnpackRequest(buildAgent({ messages: [chunk] }), request)

      expect((reply.message as CatchUpSummary).earlierSpeech).toBe(false)
    })

    it('ignores a backdated request time from the client', async () => {
      const now = Date.now()
      const [reply] = await askAfterSilence(10, {
        _id: objectIdAt(new Date(now)),
        createdAt: new Date(now - 10 * 60 * SECOND)
      })

      expect((reply.message as CatchUpSummary).earlierSpeech).toBe(false)
    })
  })

  describe('refusals', () => {
    function expectRefusal(reply, reason: CatchUpRefused['reason']) {
      expect(reply).toMatchObject({
        messageType: 'json',
        channels: [privateChat],
        message: { type: 'catch_up_refused', reason, text: UNPACK_REPLIES[reason] }
      })
    }

    it('says there is nothing to catch up on when no passages were sent, without calling the AI model', async () => {
      const [reply] = await handleUnpackRequest(buildAgent({ messages: talk(Date.now()).messages }), unpackMessage())

      expectRefusal(reply, 'noTranscript')
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
      expect(await UnpackRequest.countDocuments()).toBe(0)
    })

    it.each([
      ['a transcript chunk from another event', () => new mongoose.Types.ObjectId().toString()],
      ['a Group Chat message from this event', (chat) => chat._id.toString()],
      ['something that is not a message ID', () => 'not-an-id']
    ])('refuses %s', async (_name, foreignId) => {
      const { first, chat, messages } = talk(Date.now())
      const request = unpackMessage({ chunkIds: [first._id.toString(), foreignId(chat)] })

      const [reply] = await handleUnpackRequest(buildAgent({ messages }), request)

      expectRefusal(reply, 'chunkNotInTranscript')
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
      expect(await UnpackRequest.countDocuments()).toBe(0)
    })

    it(`refuses passages that total over ${UNPACK_CATCH_UP_MAX_CHARACTERS} characters`, async () => {
      const now = Date.now()
      const half = 'a'.repeat(UNPACK_CATCH_UP_MAX_CHARACTERS / 2)
      const chunks = [transcriptChunk(half, 30, now), transcriptChunk(half, 20, now)]

      const [reply] = await handleUnpackRequest(buildAgent({ messages: chunks }), catchUpRequest(chunks))

      expectRefusal(reply, 'passageTooLong')
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it(`accepts a passage of exactly ${UNPACK_CATCH_UP_MAX_CHARACTERS} characters`, async () => {
      const chunk = transcriptChunk('a'.repeat(UNPACK_CATCH_UP_MAX_CHARACTERS), 20, Date.now())

      const [reply] = await handleUnpackRequest(buildAgent({ messages: [chunk] }), catchUpRequest([chunk]))

      expect((reply.message as CatchUpSummary).type).toBe('catch_up_summary')
    })

    it('asks the participant to wait once they hit the per-minute limit, even before any earlier request is answered', async () => {
      const now = Date.now()
      const { first, messages } = talk(now)
      const earlierRequests = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) => earlierRequest(5 + i, now))
      const agent = buildAgent({ messages: [...messages, ...earlierRequests] })

      const [reply] = await handleUnpackRequest(agent, catchUpRequest([first], { createdAt: new Date(now) }))

      expectRefusal(reply, 'rateLimited')
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it("doesn't count other people's requests or requests from over a minute ago toward the limit", async () => {
      const now = Date.now()
      const { first, messages } = talk(now)
      const request = catchUpRequest([first], { createdAt: new Date(now) })
      const agent = buildAgent({
        messages: [
          ...messages,
          ...Array.from({ length: UNPACK_REQUESTS_PER_MINUTE - 1 }, (_, i) => earlierRequest(5 + i, now)),
          earlierRequest(UNPACK_LAST_MINUTE_WINDOW_SECONDS + 5, now),
          earlierRequest(5, now, new mongoose.Types.ObjectId()),
          request
        ]
      })

      const [reply] = await handleUnpackRequest(agent, request)

      expect((reply.message as CatchUpSummary).type).toBe('catch_up_summary')
    })

    it("doesn't count taps that arrived after this one, even within the same second", async () => {
      const now = Date.now()
      const { first, messages } = talk(now)
      const laterTaps = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) =>
        unpackMessage({}, { createdAt: new Date(now + (i + 1) * 100) })
      )
      const request = catchUpRequest([first], { createdAt: new Date(now) })
      const agent = buildAgent({ messages: [...messages, request, ...laterTaps] })

      const [reply] = await handleUnpackRequest(agent, request)

      expect((reply.message as CatchUpSummary).type).toBe('catch_up_summary')
    })

    it('still applies the limit when a client backdates its earlier requests', async () => {
      const now = Date.now()
      const { first, messages } = talk(now)
      const backdatedRequests = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) =>
        unpackMessage(
          {},
          { _id: objectIdAt(new Date(now - (5 + i) * SECOND)), createdAt: new Date(now - (2 + i) * 60 * SECOND) }
        )
      )
      const agent = buildAgent({ messages: [...messages, ...backdatedRequests] })

      const [reply] = await handleUnpackRequest(agent, catchUpRequest([first], { createdAt: new Date(now) }))

      expectRefusal(reply, 'rateLimited')
    })

    it('still applies the limit when a client backdates the new request', async () => {
      const now = Date.now()
      const { first, messages } = talk(now)
      const earlierRequests = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) => earlierRequest(5 + i, now))
      const agent = buildAgent({ messages: [...messages, ...earlierRequests] })
      const backdated = catchUpRequest([first], {
        _id: objectIdAt(new Date(now)),
        createdAt: new Date(now - 10 * 60 * SECOND)
      })

      const [reply] = await handleUnpackRequest(agent, backdated)

      expectRefusal(reply, 'rateLimited')
    })

    it('apologizes and records nothing when the AI model call fails', async () => {
      mockGetChatPromptResponse.mockRejectedValue(new Error('model unavailable'))
      const { first, second, messages } = talk(Date.now())

      const [reply] = await handleUnpackRequest(buildAgent({ messages }), catchUpRequest([first, second]))

      expectRefusal(reply, 'unpackFailed')
      expect(await UnpackRequest.countDocuments()).toBe(0)
    })
  })

  describe('when it should not answer', () => {
    it.each([
      ['the switch is off', [{ name: 'unpacker', enabled: false }]],
      ['the event predates the switch', []]
    ])('stays silent when %s', async (_name, features) => {
      const { first, messages } = talk(Date.now())

      expect(await handleUnpackRequest(buildAgent({ features, messages }), catchUpRequest([first]))).toEqual([])
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it.each([
      ['a mode this version does not support', { mode: 'selection' }],
      ['a passage ask, which has its own endpoint', { mode: 'passage' }],
      ['a Group Chat destination, which chat messages cannot use', { destination: 'groupChat' }],
      ['a request with no chunk IDs at all', { chunkIds: undefined }],
      ['chunk IDs that are not a list', { chunkIds: 'abc' }]
    ])('stays silent for %s', async (_name, body) => {
      const { messages } = talk(Date.now())

      expect(await handleUnpackRequest(buildAgent({ messages }), unpackMessage(body))).toEqual([])
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it('stays silent when the request was not sent in a Private Chat', async () => {
      const { first, messages } = talk(Date.now())

      expect(await handleUnpackRequest(buildAgent({ messages }), catchUpRequest([first], { channels: ['chat'] }))).toEqual(
        []
      )
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })
  })
})

describe('Event Assistant routing', () => {
  it('accepts an unpack request in evaluate() instead of handing a JSON body to the slash-command parser', async () => {
    const request = unpackMessage()

    const evaluation = await eventAssistant.evaluate.call(buildAgent(), request)

    expect(evaluation).toMatchObject({ action: AgentMessageActions.CONTRIBUTE, userMessage: request })
  })

  it('answers an unpack request with a catch-up summary, not as an ordinary question', async () => {
    const { first, messages } = talk(Date.now())

    const [reply] = await eventAssistant.respond.call(buildAgent({ messages }), { messages: [] }, catchUpRequest([first]))

    expect(reply.message.type).toBe('catch_up_summary')
    expect(mockGetAgentStructuredResponse).not.toHaveBeenCalled()
  })

  it('ignores an unpack request entirely while the switch is off', async () => {
    const { first, messages } = talk(Date.now())
    const agent = buildAgent({ features: [], messages })

    expect(await eventAssistant.respond.call(agent, { messages: [] }, catchUpRequest([first]))).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    expect(mockGetAgentStructuredResponse).not.toHaveBeenCalled()
  })
})
