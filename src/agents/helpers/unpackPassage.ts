import httpStatus from 'http-status'
import mongoose from 'mongoose'
import { z } from 'zod'
import ApiError from '../../utils/ApiError.js'
import { findMessages } from '../../utils/messageVisibility.js'
import { getChatPromptResponse } from './llmChain.js'
import { formatTranscript } from './llmInputFormatters.js'
import PLAIN_LANGUAGE_TERM_RULES from './plainLanguageRules.js'
import {
  TRANSCRIPT_CHANNEL,
  UnpackPassage,
  UnpackPassageSections,
  UnpackRange,
  UnpackTranscriptChunk
} from '../../types/index.types.js'

// Caps what one ask sends to the AI model and what one request can make the server load
export const UNPACK_PASSAGE_MAX_CHARACTERS = 2000
// "Why it matters" often depends on where the speaker goes next, so the model also sees what follows
export const UNPACK_CONTEXT_BEFORE_SECONDS = 120
export const UNPACK_CONTEXT_AFTER_SECONDS = 60
const UNPACK_MAX_TERMS = 3

// Transcript chunks the Unpacker can quote; a chunk saved with a structured body has no text to select
export const TRANSCRIPT_TEXT_CHUNKS = { channels: TRANSCRIPT_CHANNEL, body: { $type: 'string' } }

export const UNPACK_PASSAGE_SYSTEM_PROMPT = `You help a participant at a live event understand a passage they picked from the live transcript. You get the event topic, the passage, and the transcript from just before and just after it. Transcription is automatic, so expect missing words and misheard terms, and work out what the speaker most likely meant.

Write these, in this order:
- whatTheyreSaying: at most three sentences restating the passage in plain language. Make the first sentence make sense on its own, since it may be shown alone as a preview.
- whyItMatters: one or two sentences on how the passage connects to the event topic or the speaker's larger point. The transcript after the passage often shows where the speaker was going.
- terms: at most three specialist terms, acronyms, or named concepts from the passage that a general audience would not know, each with a one or two sentence explanation. Use an empty list when there are none. Skip common words and the names of people, companies, and products.
- headline: a title under 12 words for sharing the explanation with the room, for example: What the speaker meant by "doctrinal half-life".
- visual: null, unless a simple chart or diagram would clearly help someone follow the passage, such as a trend over time, a process with steps, a comparison, or a structure. Use null for a definition or an argument. When you include one, give a description an illustrator could draw from, altText describing the finished image for someone who can't see it, and a short caption. Only use numbers the speaker gave.

Explain only the passage. Use the surrounding transcript to understand it, not as more material to explain. Don't add claims the speaker didn't make.

## Writing rules
${PLAIN_LANGUAGE_TERM_RULES}`

const UNPACK_PASSAGE_USER_TEMPLATE = `## Event topic:
{topic}

## Transcript before the passage:
{before}

## Passage to explain:
{passage}

## Transcript after the passage:
{after}`

const unpackPassageSectionsSchema = z.object({
  whatTheyreSaying: z.string(),
  whyItMatters: z.string(),
  terms: z.array(z.object({ term: z.string(), text: z.string() })),
  headline: z.string(),
  visual: z.object({ description: z.string(), altText: z.string(), caption: z.string() }).nullable()
})

const sentences = new Intl.Segmenter('en', { granularity: 'sentence' })
// Intl.Segmenter ends a sentence at any period before a capital letter, so "Dr. Patel" would split in two.
// "etc." and "No." are left out because speakers often end a sentence with them.
const ENDS_WITH_ABBREVIATION =
  /(?:\b(?:Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|Gen|Sen|Rep|Gov|vs|cf)\.|\b(?:e\.g|i\.e)\.|\b(?:[A-Z]\.){2,})\s*$/
const isSpace = (character: string) => /\s/.test(character)

// An event saved before the switch existed has no entry for it, which means off
export function isUnpackerEnabled(conversation): boolean {
  const feature = conversation.features?.find((f) => f.name === 'unpacker')
  return feature ? feature.enabled !== false : false
}

export function toPlainText({
  whatTheyreSaying,
  whyItMatters,
  terms
}: Pick<UnpackPassageSections, 'whatTheyreSaying' | 'whyItMatters' | 'terms'>): string {
  const sections = [`What they're saying: ${whatTheyreSaying}`, `Why it matters here: ${whyItMatters}`]
  if (terms.length > 0) {
    sections.push(`Terms in this passage:\n${terms.map(({ term, text }) => `- ${term}: ${text}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

function sentenceSpans(text: string) {
  const spans: { start: number; end: number }[] = []
  for (const { index, segment } of sentences.segment(text)) {
    const previous = spans[spans.length - 1]
    if (previous && ENDS_WITH_ABBREVIATION.test(text.slice(previous.start, previous.end))) {
      previous.end = index + segment.length
    } else {
      spans.push({ start: index, end: index + segment.length })
    }
  }
  return spans
}

/** A refusal with a `reason` the client can match on, since several refusals share a status code. */
export async function chunksStillSaved(
  conversationId: mongoose.Types.ObjectId,
  chunkIds: mongoose.Types.ObjectId[]
): Promise<boolean> {
  const saved = await findMessages(
    conversationId,
    'model',
    { _id: { $in: chunkIds }, channels: TRANSCRIPT_CHANNEL },
    { select: '_id', lean: true }
  )
  return saved.length === chunkIds.length
}

export function unpackError(status: number, reason: string, message: string) {
  return new ApiError(status, message, { reason })
}

function selectionError(reason: string, message: string) {
  return unpackError(httpStatus.BAD_REQUEST, reason, message)
}

export const selectionTooLong = () =>
  selectionError('selectionTooLong', `The passage is over ${UNPACK_PASSAGE_MAX_CHARACTERS} characters.`)

function sentenceStart(spans: ReturnType<typeof sentenceSpans>, text: string, offset: number): number {
  return spans.find(({ end }) => offset < end)?.start ?? text.length
}

function sentenceEnd(spans: ReturnType<typeof sentenceSpans>, text: string, offset: number): number {
  if (offset === 0) return 0
  return spans.find(({ end }) => offset <= end)?.end ?? text.length
}

function skipSpacesForward(text: string, from: number, to: number): number {
  let offset = from
  while (offset < to && isSpace(text[offset])) offset += 1
  return offset
}

function skipSpacesBack(text: string, from: number, to: number): number {
  let offset = to
  while (offset > from && isSpace(text[offset - 1])) offset -= 1
  return offset
}

function findChunk(transcript: UnpackTranscriptChunk[], id: string, field: string): number {
  const index = transcript.findIndex((chunk) => chunk._id.toString() === id)
  if (index === -1) throw selectionError('chunkNotInTranscript', `${field} is not a transcript chunk in this event.`)
  return index
}

function checkOffset(chunk: UnpackTranscriptChunk, offset: number, field: string) {
  if (offset > chunk.body.length) throw selectionError('offsetPastEnd', `${field} is past the end of its chunk.`)
}

function passageKey({ startMessageId, startOffset, endMessageId, endOffset }: UnpackRange): string {
  return `${startMessageId}:${startOffset}-${endMessageId}:${endOffset}`
}

/**
 * Rebuilds a participant's selection from the saved transcript and widens it to whole sentences, so
 * people who select roughly the same words share one explanation. Each end only widens inside its own chunk.
 * @param transcript - this event's transcript chunks in spoken order, covering at least the selected ones
 * @param selection - the chunk IDs and character positions the browser sent
 * @returns the widened passage, or throws a 400 ApiError whose `reason` says what was wrong
 */
export function buildPassage(transcript: UnpackTranscriptChunk[], selection: UnpackRange): UnpackPassage {
  const startIndex = findChunk(transcript, selection.startMessageId, 'startMessageId')
  const endIndex = findChunk(transcript, selection.endMessageId, 'endMessageId')
  checkOffset(transcript[startIndex], selection.startOffset, 'startOffset')
  checkOffset(transcript[endIndex], selection.endOffset, 'endOffset')
  if (startIndex > endIndex || (startIndex === endIndex && selection.startOffset >= selection.endOffset)) {
    throw selectionError('selectionBackwards', 'The selection must start before it ends.')
  }

  const pieces = transcript.slice(startIndex, endIndex + 1).flatMap((chunk, i, selected) => {
    const text = chunk.body
    const isFirst = i === 0
    const isLast = i === selected.length - 1
    const spans = isFirst || isLast ? sentenceSpans(text) : []
    let from = 0
    let to = text.length
    if (isFirst) from = sentenceStart(spans, text, skipSpacesForward(text, selection.startOffset, text.length))
    if (isLast) to = sentenceEnd(spans, text, skipSpacesBack(text, 0, selection.endOffset))
    from = skipSpacesForward(text, from, to)
    to = skipSpacesBack(text, from, to)
    return from < to ? [{ chunk, from, to, text: text.slice(from, to) }] : []
  })
  if (pieces.length === 0) throw selectionError('selectionBackwards', 'The selection has no words in it.')

  const quote = pieces.map(({ text }) => text).join(' ')
  if (quote.length > UNPACK_PASSAGE_MAX_CHARACTERS) throw selectionTooLong()

  const first = pieces[0]
  const last = pieces[pieces.length - 1]
  const range = {
    startMessageId: first.chunk._id.toString(),
    startOffset: first.from,
    endMessageId: last.chunk._id.toString(),
    endOffset: last.to
  }
  return { key: passageKey(range), range, pieces: pieces.map(({ chunk, text }) => ({ chunk, text })), quote }
}

/**
 * The transcript around a passage, for the AI model to read but not explain. That includes the sentences
 * in the passage's own first and last chunks that fall outside it.
 * @param askedAt - when the participant asked; transcript after this is left out so every request
 *   for the same passage at the same moment sees the same context
 * @returns the surrounding transcript, and `until`, the latest moment it covers
 */
export async function getPassageContext(
  conversationId: mongoose.Types.ObjectId | string,
  passage: UnpackPassage,
  askedAt: Date
): Promise<{ before: string; after: string; until: Date }> {
  const first = passage.pieces[0].chunk
  const last = passage.pieces[passage.pieces.length - 1].chunk
  const firstAt = new Date(first.createdAt).getTime()
  const lastAt = new Date(last.createdAt).getTime()
  const until = new Date(Math.min(lastAt + UNPACK_CONTEXT_AFTER_SECONDS * 1000, askedAt.getTime()))
  const nearby = await findMessages(
    conversationId,
    'model',
    {
      ...TRANSCRIPT_TEXT_CHUNKS,
      _id: { $nin: passage.pieces.map(({ chunk }) => chunk._id) },
      createdAt: {
        $gte: new Date(firstAt - UNPACK_CONTEXT_BEFORE_SECONDS * 1000),
        $lte: until
      }
    },
    { select: 'body createdAt', sort: { createdAt: 1, _id: 1 }, lean: true }
  )
  const leadIn = first.body.slice(0, passage.range.startOffset).trim()
  const followOn = last.body.slice(passage.range.endOffset).trim()
  return {
    before: formatTranscript([
      ...nearby.filter((chunk) => chunk.createdAt.getTime() < firstAt),
      ...(leadIn ? [{ createdAt: first.createdAt, body: leadIn }] : [])
    ]),
    after: formatTranscript([
      ...(followOn ? [{ createdAt: last.createdAt, body: followOn }] : []),
      ...nearby.filter((chunk) => chunk.createdAt.getTime() > lastAt)
    ]),
    until
  }
}

/**
 * Asks the AI model to explain a passage. The model writes fields in schema order, and whatTheyreSaying is
 * first because the preview shows its opening sentences.
 */
export async function explainPassage(
  llm,
  { topic, passage, before, after }: { topic: string; passage: UnpackPassage; before: string; after: string }
): Promise<UnpackPassageSections> {
  const passageLines = formatTranscript(
    passage.pieces.map(({ chunk, text }) => ({ createdAt: chunk.createdAt, body: text }))
  )
  const sections = await getChatPromptResponse(
    llm,
    UNPACK_PASSAGE_SYSTEM_PROMPT,
    UNPACK_PASSAGE_USER_TEMPLATE,
    { topic, passage: passageLines, before: before || '(none)', after: after || '(none)' },
    [],
    unpackPassageSectionsSchema
  )
  return { ...sections, terms: sections.terms.slice(0, UNPACK_MAX_TERMS) }
}
