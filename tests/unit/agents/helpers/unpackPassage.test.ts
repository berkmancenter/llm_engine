import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import type { UnpackRange } from '../../../../src/types/index.types.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getSinglePromptResponse: jest.fn(),
  getRAGAugmentedResponse: jest.fn(),
  getChatPromptResponse: mockGetChatPromptResponse,
  shouldUseStructuredOutput: jest.fn(),
  pingLLM: jest.fn(),
  getStructuredResponseChain: jest.fn(),
  getAgentStructuredResponse: jest.fn(),
  extractToolCallTraceFromAgentResult: jest.fn(),
  extractCompleteSentences: jest.fn(),
  streamAgentAndReportChunks: jest.fn()
}))

const {
  buildPassage,
  explainPassage,
  getPassageContext,
  UNPACK_CONTEXT_AFTER_SECONDS,
  UNPACK_CONTEXT_BEFORE_SECONDS,
  UNPACK_PASSAGE_MAX_CHARACTERS
} = await import('../../../../src/agents/helpers/unpackPassage.js')
const { default: Message } = await import('../../../../src/models/message.model.js')
const { default: PLAIN_LANGUAGE_TERM_RULES } = await import('../../../../src/agents/helpers/plainLanguageRules.js')

setupIntTest()

const SECOND = 1000
const start = Date.now() - 10 * 60 * SECOND

function chunk(body: string, secondsIn: number) {
  return {
    _id: new mongoose.Types.ObjectId(),
    body,
    channels: ['transcript'],
    createdAt: new Date(start + secondsIn * SECOND)
  }
}

const twoSentences = chunk('Teams set an SLO for each service. Missing it eats the error budget.', 0)
const middle = chunk('so feature work stops until reliability recovers', 10)
const closing = chunk('That is the whole tradeoff. Product managers hate it.', 20)
const transcript = [twoSentences, middle, closing]

function range(
  startChunk: { _id: mongoose.Types.ObjectId },
  startOffset: number,
  endChunk: { _id: mongoose.Types.ObjectId },
  endOffset: number
): UnpackRange {
  return {
    startMessageId: startChunk._id.toString(),
    startOffset,
    endMessageId: endChunk._id.toString(),
    endOffset
  }
}

function offsetOf(text: string, part: string) {
  return text.indexOf(part)
}

describe('buildPassage', () => {
  describe('widening to whole sentences', () => {
    it('widens a few highlighted words to the sentence around them', () => {
      const from = offsetOf(twoSentences.body, 'eats')

      const passage = buildPassage(transcript, range(twoSentences, from, twoSentences, from + 'eats the'.length))

      expect(passage.quote).toBe('Missing it eats the error budget.')
      expect(passage.range).toEqual(
        range(twoSentences, offsetOf(twoSentences.body, 'Missing'), twoSentences, twoSentences.body.length)
      )
    })

    it('gives two overlapping highlights in one sentence the same passage key', () => {
      const first = buildPassage(transcript, range(twoSentences, 3, twoSentences, 10))
      const second = buildPassage(transcript, range(twoSentences, 8, twoSentences, 20))

      expect(first.key).toBe(second.key)
      expect(first.quote).toBe('Teams set an SLO for each service.')
    })

    it('widens to the whole chunk when the chunk has no sentence punctuation', () => {
      const passage = buildPassage(transcript, range(middle, 5, middle, 12))

      expect(passage.quote).toBe(middle.body)
    })

    it('gives a whole-chunk highlight and a phone tap on that chunk the same key', () => {
      const withTrailingSpace = chunk('Error budgets are a shared contract. ', 30)
      const chunks = [...transcript, withTrailingSpace]

      const highlighted = buildPassage(chunks, range(withTrailingSpace, 0, withTrailingSpace, 'Error budgets are'.length))
      const tapped = buildPassage(chunks, range(withTrailingSpace, 0, withTrailingSpace, withTrailingSpace.body.length))

      expect(highlighted.key).toBe(tapped.key)
      expect(tapped.quote).toBe('Error budgets are a shared contract.')
    })

    it('does not pull in the sentence before when the highlight starts on the space after it', () => {
      const spaceAfterFirstSentence = offsetOf(twoSentences.body, ' Missing')

      const passage = buildPassage(
        transcript,
        range(twoSentences, spaceAfterFirstSentence, twoSentences, spaceAfterFirstSentence + 8)
      )

      expect(passage.quote).toBe('Missing it eats the error budget.')
    })

    it('spans chunks: the start sentence, every chunk in between, and the end sentence', () => {
      const passage = buildPassage(
        transcript,
        range(twoSentences, offsetOf(twoSentences.body, 'error'), closing, offsetOf(closing.body, 'whole'))
      )

      expect(passage.quote).toBe(
        'Missing it eats the error budget. so feature work stops until reliability recovers That is the whole tradeoff.'
      )
      expect(passage.pieces.map(({ chunk: { _id } }) => _id)).toEqual([twoSentences._id, middle._id, closing._id])
    })

    it.each([
      ['a title', 'We asked Dr. Patel about it. Then we left.', 'about it', 'We asked Dr. Patel about it.'],
      ['a dotted acronym', 'The U.S. Army ran it. Nobody objected.', 'ran it', 'The U.S. Army ran it.'],
      ['"e.g."', 'Some cities, e.g. Paris, cap rents. Others do not.', 'cap rents', 'Some cities, e.g. Paris, cap rents.'],
      ['"i.e."', 'One owner, i.e. Bob, signs off. Then it ships.', 'signs off', 'One owner, i.e. Bob, signs off.']
    ])('does not end a sentence after %s', (_name, body, words, expected) => {
      const said = chunk(body, 30)
      const from = offsetOf(body, words)

      const passage = buildPassage([said], range(said, from, said, from + words.length))

      expect(passage.quote).toBe(expected)
    })

    it('starts at the next chunk when the highlight begins at the very end of a chunk', () => {
      const passage = buildPassage(transcript, range(twoSentences, twoSentences.body.length, middle, 7))

      expect(passage.range.startMessageId).toBe(middle._id.toString())
      expect(passage.quote).toBe(middle.body)
    })
  })

  describe('rejecting selections it cannot trust', () => {
    function reasonFor(selection: UnpackRange, chunks = transcript) {
      try {
        buildPassage(chunks, selection)
      } catch (error) {
        return { status: error.statusCode, reason: error.reason, message: error.message }
      }
      throw new Error('expected buildPassage to reject the selection')
    }

    it('rejects a start chunk that is not in this event transcript', () => {
      const elsewhere = chunk('From another event.', 0)

      expect(reasonFor(range(elsewhere, 0, middle, 4))).toMatchObject({
        status: 400,
        reason: 'chunkNotInTranscript',
        message: expect.stringContaining('startMessageId')
      })
    })

    it('rejects an end chunk that is not in this event transcript', () => {
      expect(reasonFor(range(middle, 0, chunk('From another event.', 0), 4))).toMatchObject({
        reason: 'chunkNotInTranscript',
        message: expect.stringContaining('endMessageId')
      })
    })

    it.each([
      ['start', range(middle, middle.body.length + 1, closing, 4)],
      ['end', range(middle, 0, closing, closing.body.length + 1)]
    ])('rejects a %s position past the end of its chunk', (_side, selection) => {
      expect(reasonFor(selection)).toMatchObject({ status: 400, reason: 'offsetPastEnd' })
    })

    it.each([
      ['a start chunk later than the end chunk', range(closing, 0, middle, 4)],
      ['a start position after the end position in one chunk', range(middle, 10, middle, 4)],
      ['an empty selection', range(middle, 4, middle, 4)],
      ['a selection of only spaces', range(twoSentences, 34, twoSentences, 35)]
    ])('rejects %s', (_name, selection) => {
      expect(reasonFor(selection)).toMatchObject({ status: 400, reason: 'selectionBackwards' })
    })

    it('rejects a passage longer than the limit after widening', () => {
      const long = chunk(`${'word '.repeat(UNPACK_PASSAGE_MAX_CHARACTERS / 5)}end.`, 40)

      expect(reasonFor(range(long, 0, long, 4), [long])).toMatchObject({ status: 400, reason: 'selectionTooLong' })
    })
  })
})

describe('getPassageContext', () => {
  const conversationId = new mongoose.Types.ObjectId()
  const speaker = { _id: new mongoose.Types.ObjectId(), pseudonym: 'Zoom captions' }

  async function saveChunk(body: string, at: number, overrides: Record<string, unknown> = {}) {
    const saved = await Message.create({
      conversation: conversationId,
      body,
      bodyType: 'text',
      channels: ['transcript'],
      pseudonym: speaker.pseudonym,
      pseudonymId: speaker._id,
      visible: true,
      createdAt: new Date(at),
      ...overrides
    })
    return { _id: saved._id, body: saved.body as string, createdAt: saved.createdAt as Date }
  }

  it('returns the transcript from just before and just after the passage, but not the passage itself', async () => {
    const quotedAt = Date.now() - 5 * 60 * SECOND
    await saveChunk('Too early to matter.', quotedAt - (UNPACK_CONTEXT_BEFORE_SECONDS + 10) * SECOND)
    await saveChunk('Setting the scene.', quotedAt - 90 * SECOND)
    await saveChunk('Group chat, not transcript.', quotedAt - 30 * SECOND, { channels: ['chat'] })
    await saveChunk('Another event entirely.', quotedAt - 30 * SECOND, { conversation: new mongoose.Types.ObjectId() })
    const quoted = await saveChunk('The passage itself.', quotedAt)
    await saveChunk('Where the speaker was going.', quotedAt + 40 * SECOND)
    await saveChunk('Too late to matter.', quotedAt + (UNPACK_CONTEXT_AFTER_SECONDS + 10) * SECOND)
    const passage = buildPassage([quoted], {
      startMessageId: quoted._id.toString(),
      startOffset: 0,
      endMessageId: quoted._id.toString(),
      endOffset: quoted.body.length
    })

    const { before, after } = await getPassageContext(conversationId, passage, new Date())

    expect(before).toContain('Setting the scene.')
    expect(after).toContain('Where the speaker was going.')
    const everything = `${before}\n${after}`
    expect(everything).not.toMatch(/Too early|Too late|Group chat|Another event|The passage itself/)
  })

  it("includes the sentences that share the passage's chunks but fall outside it", async () => {
    const quotedAt = Date.now() - 5 * 60 * SECOND
    const quoted = await saveChunk('Setting up the point. The point itself. Where it leads.', quotedAt)
    const from = offsetOf(quoted.body, 'The point')
    const passage = buildPassage([quoted], {
      startMessageId: quoted._id.toString(),
      startOffset: from,
      endMessageId: quoted._id.toString(),
      endOffset: from + 'The point itself.'.length
    })

    const { before, after } = await getPassageContext(conversationId, passage, new Date())

    expect(before).toContain('Setting up the point.')
    expect(after).toContain('Where it leads.')
    expect(`${before}\n${after}`).not.toContain('The point itself.')
  })

  it('stops at the moment the participant asked, so a slow request gets the same context', async () => {
    const quotedAt = Date.now() - 5 * 60 * SECOND
    const quoted = await saveChunk('The passage itself.', quotedAt)
    await saveChunk('Said before they asked.', quotedAt + 10 * SECOND)
    await saveChunk('Said after they asked.', quotedAt + 30 * SECOND)
    const passage = buildPassage([quoted], {
      startMessageId: quoted._id.toString(),
      startOffset: 0,
      endMessageId: quoted._id.toString(),
      endOffset: quoted.body.length
    })

    const { after } = await getPassageContext(conversationId, passage, new Date(quotedAt + 20 * SECOND))

    expect(after).toContain('Said before they asked.')
    expect(after).not.toContain('Said after they asked.')
  })

  it('says how far past the passage the transcript it returned reaches', async () => {
    const quotedAt = Date.now() - 5 * 60 * SECOND
    const quoted = await saveChunk('The passage itself.', quotedAt)
    const passage = buildPassage([quoted], {
      startMessageId: quoted._id.toString(),
      startOffset: 0,
      endMessageId: quoted._id.toString(),
      endOffset: quoted.body.length
    })

    const early = await getPassageContext(conversationId, passage, new Date(quotedAt + 5 * SECOND))
    const late = await getPassageContext(conversationId, passage, new Date())

    expect(early.until).toEqual(new Date(quotedAt + 5 * SECOND))
    expect(late.until).toEqual(new Date(quotedAt + UNPACK_CONTEXT_AFTER_SECONDS * SECOND))
  })
})

describe('explainPassage', () => {
  const sections = {
    whatTheyreSaying: 'Missing the target uses up the budget for mistakes.',
    whyItMatters: 'It explains why feature work stops.',
    terms: [
      { term: 'SLO', text: 'A reliability target.' },
      { term: 'error budget', text: 'How much failure is allowed.' },
      { term: 'SRE', text: 'Engineers who keep services running.' },
      { term: 'toil', text: 'Repetitive manual work.' }
    ],
    headline: "What the speaker meant by 'error budget'",
    visual: null
  }

  beforeEach(() => {
    mockGetChatPromptResponse.mockReset()
    mockGetChatPromptResponse.mockResolvedValue(sections)
  })

  it('sends the topic, the passage, its surroundings, and the shared plain-language rules', async () => {
    const passage = buildPassage(transcript, range(twoSentences, 40, twoSentences, 45))

    await explainPassage(
      {},
      { topic: 'Reliability engineering', passage, before: 'Setting the scene.', after: 'Next point.' }
    )

    const [, systemPrompt, , inputs] = mockGetChatPromptResponse.mock.calls[0]
    expect(systemPrompt).toContain(PLAIN_LANGUAGE_TERM_RULES)
    expect(inputs).toMatchObject({ topic: 'Reliability engineering', before: 'Setting the scene.', after: 'Next point.' })
    expect(inputs.passage).toContain('Missing it eats the error budget.')
  })

  it('marks missing surroundings as none instead of leaving an empty section', async () => {
    const passage = buildPassage(transcript, range(middle, 0, middle, 4))

    await explainPassage({}, { topic: 'Reliability engineering', passage, before: '', after: '' })

    const [, , , inputs] = mockGetChatPromptResponse.mock.calls[0]
    expect(inputs).toMatchObject({ before: '(none)', after: '(none)' })
  })

  it('keeps at most three terms', async () => {
    const passage = buildPassage(transcript, range(middle, 0, middle, 4))

    const result = await explainPassage({}, { topic: 'Reliability engineering', passage, before: '', after: '' })

    expect(result.terms.map(({ term }) => term)).toEqual(['SLO', 'error budget', 'SRE'])
    expect(result.headline).toBe(sections.headline)
    expect(result.visual).toBeNull()
  })
})
