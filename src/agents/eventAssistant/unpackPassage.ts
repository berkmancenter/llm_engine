import httpStatus from 'http-status'
import mongoose from 'mongoose'
import { z } from 'zod'
import ApiError from '../../utils/ApiError.js'
import { findMessages } from '../../utils/messageVisibility.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { formatTranscript } from '../helpers/llmInputFormatters.js'
import PLAIN_LANGUAGE_TERM_RULES from '../helpers/plainLanguageRules.js'
import { UnpackPassage, UnpackPassageSections, UnpackRange, UnpackTranscriptChunk } from '../../types/index.types.js'

// Caps what one ask sends to the AI model and what one request can make the server load
export const UNPACK_PASSAGE_MAX_CHARACTERS = 2000
// "Why it matters" often depends on where the speaker goes next, so the model also sees what follows
export const UNPACK_CONTEXT_BEFORE_SECONDS = 120
export const UNPACK_CONTEXT_AFTER_SECONDS = 60
const UNPACK_MAX_TERMS = 3

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
// Intl.Segmenter ends a sentence at any period before a capital letter, so "Dr. Patel" would split in two
const ENDS_WITH_ABBREVIATION = /(?:\b(?:Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|Gen|Sen|Rep|Gov|vs)\.|\b(?:[A-Z]\.){2,})\s*$/
const isSpace = (character: string) => /\s/.test(character)

function sentenceSpans(text: string): { start: number; end: number }[] {
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

function selectionError(reason: string, message: string) {
  return new ApiError(httpStatus.BAD_REQUEST, message, { reason })
}

function sentenceStart(text: string, offset: number): number {
  return sentenceSpans(text).find(({ end }) => offset < end)?.start ?? text.length
}

function sentenceEnd(text: string, offset: number): number {
  if (offset === 0) return 0
  return sentenceSpans(text).find(({ end }) => offset <= end)?.end ?? text.length
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
    let from = 0
    let to = text.length
    if (i === 0) from = sentenceStart(text, skipSpacesForward(text, selection.startOffset, text.length))
    if (i === selected.length - 1) to = sentenceEnd(text, skipSpacesBack(text, 0, selection.endOffset))
    from = skipSpacesForward(text, from, to)
    to = skipSpacesBack(text, from, to)
    return from < to ? [{ chunk, from, to, text: text.slice(from, to) }] : []
  })
  if (pieces.length === 0) throw selectionError('selectionBackwards', 'The selection has no words in it.')

  const quote = pieces.map(({ text }) => text).join(' ')
  if (quote.length > UNPACK_PASSAGE_MAX_CHARACTERS) {
    throw selectionError('selectionTooLong', `The passage is over ${UNPACK_PASSAGE_MAX_CHARACTERS} characters.`)
  }

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
 * The transcript around a passage, for the AI model to read but not explain.
 * @param askedAt - when the participant asked; transcript after this is left out so every request
 *   for the same passage at the same moment sees the same context
 * @returns the surrounding transcript, and `until`, the latest moment it covers
 */
export async function getPassageContext(
  conversationId: mongoose.Types.ObjectId | string,
  passage: UnpackPassage,
  askedAt: Date
): Promise<{ before: string; after: string; until: Date }> {
  const firstAt = new Date(passage.pieces[0].chunk.createdAt).getTime()
  const lastAt = new Date(passage.pieces[passage.pieces.length - 1].chunk.createdAt).getTime()
  const until = new Date(Math.min(lastAt + UNPACK_CONTEXT_AFTER_SECONDS * 1000, askedAt.getTime()))
  const nearby = await findMessages(
    conversationId,
    'model',
    {
      channels: 'transcript',
      _id: { $nin: passage.pieces.map(({ chunk }) => chunk._id) },
      createdAt: {
        $gte: new Date(firstAt - UNPACK_CONTEXT_BEFORE_SECONDS * 1000),
        $lte: until
      }
    },
    { select: 'body createdAt', sort: { createdAt: 1 }, lean: true }
  )
  return {
    before: formatTranscript(nearby.filter((chunk) => chunk.createdAt.getTime() < firstAt)),
    after: formatTranscript(nearby.filter((chunk) => chunk.createdAt.getTime() > lastAt)),
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
