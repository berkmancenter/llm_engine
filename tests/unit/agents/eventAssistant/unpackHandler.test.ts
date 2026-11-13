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
const { default: Message } = await import('../../../../src/models/message.model.js')
const { default: config } = await import('../../../../src/config/config.js')
const { AgentMessageActions } = await import('../../../../src/types/index.types.js')
const { default: PLAIN_LANGUAGE_TERM_RULES } = await import('../../../../src/agents/helpers/plainLanguageRules.js')

setupIntTest()

const SECOND = 1000
const userId = new mongoose.Types.ObjectId()
const privateChat = { name: `direct-${userId}-agent`, direct: true }
const TRANSCRIPT_PASSCODE = 'transcript-code'

const summary = {
  inShort: 'Teams set a reliability target for each service. Missing it uses up their budget for mistakes.',
  whatTheyCovered: ['Every service has a reliability target', 'Missing the target uses up the error budget'],
  comingUp: 'A demo of the dashboard teams use to track this.'
}

function buildAgent({
  features = [{ name: 'unpacker', enabled: true }],
  messages = [] as unknown[],
  transcriptPasscode = TRANSCRIPT_PASSCODE as string | null
} = {}) {
  return {
    agentConfig: { botName: 'Berkie' },
    conversation: {
      _id: new mongoose.Types.ObjectId(),
      name: 'Reliability engineering',
      features,
      channels: [privateChat, { name: 'chat' }, { name: 'transcript', passcode: transcriptPasscode }],
      messages
    },
    // Catch-ups run on the Unpacker model setting, so the assistant's own model must never be asked for
    getLLM: async () => {
      throw new Error('catch-ups must not use the assistant model')
    }
  }
}

function saveMessage(agent, body: string, channel: string, endedAt: Date) {
  return Message.create({
    conversation: agent.conversation._id,
    body,
    bodyType: 'text',
    channels: [channel],
    pseudonym: 'Zoom captions',
    pseudonymId: new mongoose.Types.ObjectId(),
    visible: true,
    createdAt: endedAt
  })
}

function saveChunk(agent, body: string, secondsBefore: number, now: number) {
  return saveMessage(agent, body, 'transcript', new Date(now - secondsBefore * SECOND))
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

function earlierRequest(secondsBefore: number, now: number, owner = userId, body: Record<string, unknown> = {}) {
  return unpackMessage(body, { owner, createdAt: new Date(now - secondsBefore * SECOND) })
}

function refusalOf(request, reason: CatchUpRefused['reason'] = 'unpackFailed') {
  return {
    _id: new mongoose.Types.ObjectId(),
    bodyType: 'json',
    body: { type: 'catch_up_refused', requestMessage: request._id.toString(), reason, text: UNPACK_REPLIES[reason] },
    channels: [privateChat.name],
    createdAt: new Date()
  }
}

async function talk(agent, now: number) {
  const older = await saveChunk(agent, 'Before we start, lunch is at noon.', 5 * 60, now)
  const first = await saveChunk(agent, 'We track every service against an SLO.', 50, now)
  const chat = await saveMessage(agent, 'Group chat, not transcript.', 'chat', new Date(now - 20 * SECOND))
  const second = await saveChunk(agent, 'Missing it eats the error budget.', 10, now)
  return { older, first, chat, second }
}

async function agentWithTalk(options: Parameters<typeof buildAgent>[0] = {}, now = Date.now()) {
  const agent = buildAgent(options)
  return { agent, now, ...(await talk(agent, now)) }
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
      const { agent, now, first, second } = await agentWithTalk()
      const request = catchUpRequest([second, first, second], { createdAt: new Date(now) })

      const [reply] = await handleUnpackRequest(agent, request)

      expect(reply.messageType).toBe('json')
      expect(reply.channels).toEqual([privateChat])
      expect(reply.message).toMatchObject({
        type: 'catch_up_summary',
        requestMessage: request._id.toString(),
        chunkIds: [first._id.toString(), second._id.toString()],
        passage: { start: first.createdAt!.toISOString(), end: second.createdAt!.toISOString() },
        earlierSpeech: false,
        ...summary
      })
    })

    it('orders chunks that ended at the same moment by ID, whatever order they were sent in', async () => {
      const agent = buildAgent()
      const endedAt = new Date(Date.now() - 10 * SECOND)
      const a = await saveMessage(agent, 'First half of the thought.', 'transcript', endedAt)
      const b = await saveMessage(agent, 'Second half of the thought.', 'transcript', endedAt)

      const [reply] = await handleUnpackRequest(agent, catchUpRequest([b, a]))

      expect((reply.message as CatchUpSummary).chunkIds).toEqual([a._id.toString(), b._id.toString()])
    })

    it('includes a plain-text copy of every section for chat history and text-only clients', async () => {
      const { agent, first, second } = await agentWithTalk()

      const [reply] = await handleUnpackRequest(agent, catchUpRequest([first, second]))

      const { text } = reply.message as CatchUpSummary
      expect(text).toContain(summary.inShort)
      summary.whatTheyCovered.forEach((point) => expect(text).toContain(point))
      expect(text).toContain(summary.comingUp)
    })

    it.each([
      ['null', null],
      ['blank', '  ']
    ])('leaves "Coming up" out when the model gives a %s one', async (_name, comingUp) => {
      mockGetChatPromptResponse.mockResolvedValue({ ...summary, comingUp })
      const { agent, first, second } = await agentWithTalk()

      const [reply] = await handleUnpackRequest(agent, catchUpRequest([first, second]))

      expect((reply.message as CatchUpSummary).comingUp).toBeNull()
      expect((reply.message as CatchUpSummary).text).not.toMatch(/coming up/i)
    })

    it('keeps at most five points under "What they covered"', async () => {
      const points = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven']
      mockGetChatPromptResponse.mockResolvedValue({ ...summary, whatTheyCovered: points })
      const { agent, first, second } = await agentWithTalk()

      const [reply] = await handleUnpackRequest(agent, catchUpRequest([first, second]))

      expect((reply.message as CatchUpSummary).whatTheyCovered).toEqual(points.slice(0, 5))
    })

    it('asks the AI model for at least one non-empty point, so a bad answer is retried', async () => {
      const { agent, first } = await agentWithTalk()

      await handleUnpackRequest(agent, catchUpRequest([first]))

      const schema = mockGetChatPromptResponse.mock.calls[0][5]
      expect(schema.safeParse(summary).success).toBe(true)
      expect(schema.safeParse({ ...summary, whatTheyCovered: [] }).success).toBe(false)
      expect(schema.safeParse({ ...summary, whatTheyCovered: [''] }).success).toBe(false)
    })

    it('leaves the "What they covered" heading out of the plain-text copy when there are no points', async () => {
      mockGetChatPromptResponse.mockResolvedValue({ ...summary, whatTheyCovered: [] })
      const { agent, first } = await agentWithTalk()

      const [reply] = await handleUnpackRequest(agent, catchUpRequest([first]))

      expect((reply.message as CatchUpSummary).text).not.toMatch(/what they covered/i)
    })

    it('sends only the chosen passages, the event topic and the plain-language rules to the AI model', async () => {
      const { agent, first, second } = await agentWithTalk()

      await handleUnpackRequest(agent, catchUpRequest([first, second]))

      const [, systemPrompt, , inputs] = mockGetChatPromptResponse.mock.calls[0]
      expect(systemPrompt).toContain(PLAIN_LANGUAGE_TERM_RULES)
      expect(inputs.topic).toBe('Reliability engineering')
      expect(inputs.transcript).toContain('We track every service against an SLO.')
      expect(inputs.transcript).toContain('Missing it eats the error budget.')
      expect(inputs.transcript).not.toContain('lunch is at noon')
    })

    it('records the request against the user ID and the ID the reply will be saved under', async () => {
      const { agent, first, second } = await agentWithTalk()
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
      const { agent, first, second } = await agentWithTalk()

      const [reply] = await handleUnpackRequest(agent, catchUpRequest([first, second]))

      expect((reply.message as CatchUpSummary).type).toBe('catch_up_summary')
    })
  })

  describe('earlier speech', () => {
    async function askAfterSilence(silenceSeconds: number, requestOverrides: Record<string, unknown> = {}) {
      const now = Date.now()
      const agent = buildAgent()
      const chunk = await saveChunk(agent, 'We track every service against an SLO.', silenceSeconds, now)
      return handleUnpackRequest(agent, catchUpRequest([chunk], { createdAt: new Date(now), ...requestOverrides }))
    }

    it('is false when the newest passage ended within the last 60 seconds, and the AI model hears it is recent', async () => {
      const [reply] = await askAfterSilence(UNPACK_LAST_MINUTE_WINDOW_SECONDS - 1)

      expect((reply.message as CatchUpSummary).earlierSpeech).toBe(false)
      const [, , , inputs] = mockGetChatPromptResponse.mock.calls[0]
      expect(inputs.timing).toMatch(/last minute/i)
      expect(inputs.timing).not.toMatch(/nothing was said/i)
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

    it("doesn't claim silence when the speaker kept talking after the passages a lagging page sent", async () => {
      const now = Date.now()
      const agent = buildAgent()
      const stale = await saveChunk(agent, 'We track every service against an SLO.', 90, now)
      await saveChunk(agent, 'Said after the page stopped updating.', 10, now)

      const [reply] = await handleUnpackRequest(agent, catchUpRequest([stale], { createdAt: new Date(now) }))

      expect((reply.message as CatchUpSummary).earlierSpeech).toBe(false)
      expect((reply.message as CatchUpSummary).chunkIds).toEqual([stale._id.toString()])
    })

    it("counts from when the participant asked, not when Berkie's job runs", async () => {
      const askedAt = Date.now() - 5 * 60 * SECOND
      const agent = buildAgent()
      const chunk = await saveChunk(agent, 'Said just before the request.', 10, askedAt)

      const [reply] = await handleUnpackRequest(agent, catchUpRequest([chunk], { createdAt: new Date(askedAt) }))

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
    function expectRefusal(reply, reason: CatchUpRefused['reason'], request) {
      expect(reply).toMatchObject({
        messageType: 'json',
        channels: [privateChat],
        message: {
          type: 'catch_up_refused',
          requestMessage: request._id.toString(),
          reason,
          text: UNPACK_REPLIES[reason]
        }
      })
    }

    it('says there is nothing to catch up on when the event has no transcript, without calling the AI model', async () => {
      const request = unpackMessage()

      const [reply] = await handleUnpackRequest(buildAgent(), request)

      expectRefusal(reply, 'noTranscript', request)
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
      expect(await UnpackRequest.countDocuments()).toBe(0)
    })

    it("doesn't claim the talk is empty when the transcript has chunks but none were sent", async () => {
      const { agent } = await agentWithTalk()
      const request = unpackMessage()

      const [reply] = await handleUnpackRequest(agent, request)

      expectRefusal(reply, 'noPassagesSent', request)
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it.each([
      ['a transcript chunk from another event', () => new mongoose.Types.ObjectId().toString()],
      ['a Group Chat message from this event', (chat) => chat._id.toString()],
      ['something that is not a message ID', () => 'not-an-id']
    ])('refuses %s', async (_name, foreignId) => {
      const { agent, first, chat } = await agentWithTalk()
      const request = unpackMessage({ chunkIds: [first._id.toString(), foreignId(chat)] })

      const [reply] = await handleUnpackRequest(agent, request)

      expectRefusal(reply, 'chunkNotInTranscript', request)
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
      expect(await UnpackRequest.countDocuments()).toBe(0)
    })

    it('refuses a transcript chunk with no text body', async () => {
      const { agent, now, first } = await agentWithTalk()
      const structured = await Message.create({
        conversation: agent.conversation._id,
        body: { caption: 'Then the arguing starts.' },
        bodyType: 'json',
        channels: ['transcript'],
        pseudonym: 'Zoom captions',
        pseudonymId: new mongoose.Types.ObjectId(),
        visible: true,
        createdAt: new Date(now - 5 * SECOND)
      })
      const request = catchUpRequest([first, structured])

      const [reply] = await handleUnpackRequest(agent, request)

      expectRefusal(reply, 'chunkNotInTranscript', request)
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it('refuses, and keeps no record, when the transcript is deleted while the AI model is writing', async () => {
      const { agent, first, second } = await agentWithTalk()
      mockGetChatPromptResponse.mockImplementation(async () => {
        await Message.deleteMany({ conversation: agent.conversation._id, channels: 'transcript' })
        return summary
      })
      const request = catchUpRequest([first, second])

      const [reply] = await handleUnpackRequest(agent, request)

      expectRefusal(reply, 'chunkNotInTranscript', request)
      expect(await UnpackRequest.countDocuments()).toBe(0)
    })

    it(`refuses passages that total over ${UNPACK_CATCH_UP_MAX_CHARACTERS} characters`, async () => {
      const now = Date.now()
      const agent = buildAgent()
      const half = 'a'.repeat(UNPACK_CATCH_UP_MAX_CHARACTERS / 2)
      const chunks = [await saveChunk(agent, half, 30, now), await saveChunk(agent, half, 20, now)]
      const request = catchUpRequest(chunks)

      const [reply] = await handleUnpackRequest(agent, request)

      expectRefusal(reply, 'passageTooLong', request)
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it(`accepts a passage of exactly ${UNPACK_CATCH_UP_MAX_CHARACTERS} characters`, async () => {
      const agent = buildAgent()
      const chunk = await saveChunk(agent, 'a'.repeat(UNPACK_CATCH_UP_MAX_CHARACTERS), 20, Date.now())

      const [reply] = await handleUnpackRequest(agent, catchUpRequest([chunk]))

      expect((reply.message as CatchUpSummary).type).toBe('catch_up_summary')
    })

    describe('the per-minute limit', () => {
      it('asks the participant to wait, even before any earlier request is answered', async () => {
        const now = Date.now()
        const earlierRequests = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) => earlierRequest(5 + i, now))
        const { agent, first } = await agentWithTalk({ messages: earlierRequests }, now)
        const request = catchUpRequest([first], { createdAt: new Date(now) })

        const [reply] = await handleUnpackRequest(agent, request)

        expectRefusal(reply, 'rateLimited', request)
        expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
      })

      it('says so before anything else, even for a request that lists no passages', async () => {
        const now = Date.now()
        const earlierRequests = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) => earlierRequest(5 + i, now))
        const request = unpackMessage({}, { createdAt: new Date(now) })

        const [reply] = await handleUnpackRequest(buildAgent({ messages: earlierRequests }), request)

        expectRefusal(reply, 'rateLimited', request)
      })

      it("doesn't count earlier requests Berkie refused, so a failed try can be retried", async () => {
        const now = Date.now()
        const earlierRequests = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) => earlierRequest(5 + i, now))
        const refusals = earlierRequests.map((earlier) => refusalOf(earlier))
        const { agent, first } = await agentWithTalk({ messages: [...earlierRequests, ...refusals] }, now)

        const [reply] = await handleUnpackRequest(agent, catchUpRequest([first], { createdAt: new Date(now) }))

        expect((reply.message as CatchUpSummary).type).toBe('catch_up_summary')
      })

      it("doesn't count earlier requests too malformed to answer", async () => {
        const now = Date.now()
        const malformed = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) =>
          earlierRequest(5 + i, now, userId, { chunkIds: undefined })
        )
        const { agent, first } = await agentWithTalk({ messages: malformed }, now)

        const [reply] = await handleUnpackRequest(agent, catchUpRequest([first], { createdAt: new Date(now) }))

        expect((reply.message as CatchUpSummary).type).toBe('catch_up_summary')
      })

      it("doesn't count other people's requests or requests from over a minute ago", async () => {
        const now = Date.now()
        const messages = [
          ...Array.from({ length: UNPACK_REQUESTS_PER_MINUTE - 1 }, (_, i) => earlierRequest(5 + i, now)),
          earlierRequest(UNPACK_LAST_MINUTE_WINDOW_SECONDS + 5, now),
          earlierRequest(5, now, new mongoose.Types.ObjectId())
        ]
        const { agent, first } = await agentWithTalk({ messages }, now)
        const request = catchUpRequest([first], { createdAt: new Date(now) })
        agent.conversation.messages.push(request)

        const [reply] = await handleUnpackRequest(agent, request)

        expect((reply.message as CatchUpSummary).type).toBe('catch_up_summary')
      })

      it("doesn't count taps that arrived after this one, even within the same second", async () => {
        const now = Date.now()
        const laterTaps = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) =>
          unpackMessage({}, { createdAt: new Date(now + (i + 1) * 100) })
        )
        const { agent, first } = await agentWithTalk({ messages: laterTaps }, now)
        const request = catchUpRequest([first], { createdAt: new Date(now) })

        const [reply] = await handleUnpackRequest(agent, request)

        expect((reply.message as CatchUpSummary).type).toBe('catch_up_summary')
      })

      it('still applies when a client backdates its earlier requests', async () => {
        const now = Date.now()
        const backdatedRequests = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) =>
          unpackMessage(
            {},
            { _id: objectIdAt(new Date(now - (5 + i) * SECOND)), createdAt: new Date(now - (2 + i) * 60 * SECOND) }
          )
        )
        const { agent, first } = await agentWithTalk({ messages: backdatedRequests }, now)
        const request = catchUpRequest([first], { createdAt: new Date(now) })

        const [reply] = await handleUnpackRequest(agent, request)

        expectRefusal(reply, 'rateLimited', request)
      })

      it('still applies when a client backdates the new request', async () => {
        const now = Date.now()
        const earlierRequests = Array.from({ length: UNPACK_REQUESTS_PER_MINUTE }, (_, i) => earlierRequest(5 + i, now))
        const { agent, first } = await agentWithTalk({ messages: earlierRequests }, now)
        const backdated = catchUpRequest([first], {
          _id: objectIdAt(new Date(now)),
          createdAt: new Date(now - 10 * 60 * SECOND)
        })

        const [reply] = await handleUnpackRequest(agent, backdated)

        expectRefusal(reply, 'rateLimited', backdated)
      })
    })

    it('apologizes and records nothing when the AI model call fails', async () => {
      mockGetChatPromptResponse.mockRejectedValue(new Error('model unavailable'))
      const { agent, first, second } = await agentWithTalk()
      const request = catchUpRequest([first, second])

      const [reply] = await handleUnpackRequest(agent, request)

      expectRefusal(reply, 'unpackFailed', request)
      expect(await UnpackRequest.countDocuments()).toBe(0)
    })
  })

  describe('when it should not answer', () => {
    it.each([
      ['the switch is off', [{ name: 'unpacker', enabled: false }]],
      ['the event predates the switch', []]
    ])('stays silent when %s', async (_name, features) => {
      const { agent, first } = await agentWithTalk({ features })

      expect(await handleUnpackRequest(agent, catchUpRequest([first]))).toEqual([])
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it.each([
      ['a mode this version does not support', { mode: 'selection' }],
      ['a passage ask, which has its own endpoint', { mode: 'passage' }],
      ['a Group Chat destination, which chat messages cannot use', { destination: 'groupChat' }],
      ['a request with no chunk IDs at all', { chunkIds: undefined }],
      ['chunk IDs that are not a list', { chunkIds: 'abc' }]
    ])('stays silent for %s', async (_name, body) => {
      const { agent } = await agentWithTalk()

      expect(await handleUnpackRequest(agent, unpackMessage(body))).toEqual([])
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })

    it('stays silent when the request was not sent in a Private Chat', async () => {
      const { agent, first } = await agentWithTalk()

      expect(await handleUnpackRequest(agent, catchUpRequest([first], { channels: ['chat'] }))).toEqual([])
      expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    })
  })
})

describe('Event Assistant routing', () => {
  it('accepts an unpack request in evaluate() instead of handing a JSON body to the slash-command parser', async () => {
    const request = unpackMessage({ transcriptPasscode: TRANSCRIPT_PASSCODE })

    const evaluation = await eventAssistant.evaluate.call(buildAgent(), request)

    expect(evaluation).toMatchObject({ action: AgentMessageActions.CONTRIBUTE })
  })

  it('drops the transcript passcode from an unpack request before it is saved', async () => {
    const request = unpackMessage({ transcriptPasscode: TRANSCRIPT_PASSCODE })

    const evaluation = await eventAssistant.evaluate.call(buildAgent(), request)

    const { transcriptPasscode, ...bodyWithoutPasscode } = request.body as Record<string, unknown>
    expect(transcriptPasscode).toBe(TRANSCRIPT_PASSCODE)
    expect(evaluation.userMessage).toEqual({ ...request, body: bodyWithoutPasscode })
  })

  it.each([
    ['a wrong', { transcriptPasscode: 'not-the-code' }],
    ['no', {}]
  ])('rejects an unpack request with %s transcript passcode, like the passage endpoint', async (_name, passcode) => {
    const request = unpackMessage(passcode)

    await expect(eventAssistant.evaluate.call(buildAgent(), request)).rejects.toMatchObject({
      statusCode: 400,
      reason: 'wrongPasscode'
    })
  })

  it.each([
    ['without chunkIds', { chunkIds: undefined }],
    ['whose chunkIds is not a list', { chunkIds: 'not-a-list' }],
    ['with a mode the server does not know', { mode: 'lastHour' }]
  ])('rejects an unpack request %s before it is saved', async (_name, body) => {
    const request = unpackMessage({ transcriptPasscode: TRANSCRIPT_PASSCODE, ...body })

    await expect(eventAssistant.evaluate.call(buildAgent(), request)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('accepts an unpack request without a passcode when the transcript has none', async () => {
    const request = unpackMessage()

    const evaluation = await eventAssistant.evaluate.call(buildAgent({ transcriptPasscode: null }), request)

    expect(evaluation).toMatchObject({ action: AgentMessageActions.CONTRIBUTE })
  })

  it('answers an unpack request with a catch-up summary, not as an ordinary question', async () => {
    const { agent, first } = await agentWithTalk()

    const [reply] = await eventAssistant.respond.call(agent, { messages: [] }, catchUpRequest([first]))

    expect(reply.message.type).toBe('catch_up_summary')
    expect(mockGetAgentStructuredResponse).not.toHaveBeenCalled()
  })

  it('ignores an unpack request entirely while the switch is off', async () => {
    const { agent, first } = await agentWithTalk({ features: [] })

    expect(await eventAssistant.respond.call(agent, { messages: [] }, catchUpRequest([first]))).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    expect(mockGetAgentStructuredResponse).not.toHaveBeenCalled()
  })

  it('labels the trace of a catch-up with the full ID of the Unpacker model it actually runs on', () => {
    const configuredModel = config.unpackLLMModel
    config.unpackLLMModel = 'sonnet'
    try {
      const metadata = eventAssistant.getTraceMetadata.call(buildAgent(), { messages: [] }, unpackMessage(), [])

      expect(metadata).toMatchObject({
        llmModel: expect.stringMatching(/^us\.anthropic\.claude-sonnet/),
        llmPlatform: 'bedrock'
      })
    } finally {
      config.unpackLLMModel = configuredModel
    }
  })
})
