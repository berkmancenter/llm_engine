import { z } from 'zod'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { VIBES_SPIKE_SYSTEM_PROMPT, VIBES_SPIKE_USER_TEMPLATE } from './prompt.js'
import { ChatSpike, SpikeAnnotation, SpikeSource } from '../../types/index.types.js'

/* A message the spike labeler can read: who said it, the text, and when. */
interface ReadableMessage {
  body?: unknown
  pseudonym?: string
  fromAgent?: boolean
  createdAt?: Date
  channels?: string[]
}

/* At most this many spikes are sent to the model for a topic label. A recap shows
   only two or three standouts, so labeling the busiest one or two is plenty and
   keeps the number of model calls per event small. */
const MAX_ANNOTATED_SPIKES = 2

/* Collapses whitespace, trims, and lowercases so a quote and a message body can be
   compared without tripping over spacing or capitalization the model may have
   changed. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Keeps the messages whose timestamp lands inside a spike's window. The window runs
 * from startMinute (inclusive) to endMinute (exclusive) past the event start, the
 * same boundaries the activity buckets use, so a message on a window edge lands in
 * exactly one window. Messages without a real timestamp are dropped.
 */
export function messagesDuringSpike<T extends { createdAt?: Date }>(messages: T[], eventStart: Date, spike: ChatSpike): T[] {
  const windowStart = eventStart.getTime() + spike.startMinute * 60 * 1000
  const windowEnd = eventStart.getTime() + spike.endMinute * 60 * 1000

  return messages.filter((message) => {
    if (!(message.createdAt instanceof Date)) return false
    const sentAt = message.createdAt.getTime()
    return sentAt >= windowStart && sentAt < windowEnd
  })
}

/**
 * Reports whether a quote is verbatim text from one of the given messages. This is
 * the trust gate for a spike annotation: a quote only earns a place on the card if
 * it really was said in the window. Matching ignores whitespace and case but nothing
 * else, so the model cannot smuggle in words no one wrote. An empty quote never
 * matches, and non-text bodies (images, structured payloads) are skipped.
 */
export function quoteAppearsIn(quote: string, messages: { body?: unknown }[]): boolean {
  const needle = normalize(quote)
  if (needle.length === 0) return false

  return messages.some((message) => typeof message.body === 'string' && normalize(message.body).includes(needle))
}

/* Ranks two spikes for labeling, most significant first. computeSpikes returns either a
   single zero-baseline spike (null ratio) or a set of finite-ratio spikes, never a mix,
   so in practice this just sorts finite ratios highest-first. The null handling is a
   guard for if those ever meet: a finite ratio outranks a null one, because a null ratio
   is the absence of a comparison rather than an infinitely strong one, and two nulls fall
   back to raw message count. */
function compareSignificance(a: ChatSpike, b: ChatSpike): number {
  if (a.ratio === null && b.ratio === null) return b.messageCount - a.messageCount
  if (a.ratio === null) return 1
  if (b.ratio === null) return -1
  return b.ratio - a.ratio
}

/**
 * Picks the most significant spikes to label, capped so a busy event does not fan
 * out into many model calls. Returns them strongest first; the caller keeps the full
 * spike list in time order and only annotates these.
 */
export function topSpikesBySignificance(spikes: ChatSpike[], limit: number = MAX_ANNOTATED_SPIKES): ChatSpike[] {
  return [...spikes].sort(compareSignificance).slice(0, limit)
}

/**
 * The trust gate for one spike's label: a model-proposed topic and quote only become
 * an annotation when the quote is verbatim text from the window and the topic is not
 * blank. Anything the model invented is dropped, so the spike falls back to its
 * numbers rather than carrying words no one said.
 */
export function groundAnnotation(
  candidate: { topic: string; quote: string },
  windowMessages: { body?: unknown }[]
): SpikeAnnotation | null {
  const topic = candidate.topic?.trim() ?? ''
  if (topic.length === 0) return null
  if (!quoteAppearsIn(candidate.quote, windowMessages)) return null

  return { topic, quote: candidate.quote.trim() }
}

/* What the spike labeler returns: a short topic and one verbatim quote. The quote is
   checked against the window before it is trusted, so the schema only shapes the
   model's reply. */
const SpikeTopicSchema = z.object({
  topic: z.string().describe('A short, plain phrase naming what the burst of messages was about'),
  quote: z.string().describe('One message copied word for word, exactly as it appears in the provided messages')
})

/* Renders the window's messages as one "name: text" line each, the form the labeler
   reads. Only text bodies are shown, since a quote can only come from text. */
function formatWindowMessages(messages: ReadableMessage[]): string {
  return messages
    .filter((message) => typeof message.body === 'string')
    .map((message) => `${message.pseudonym ?? 'someone'}: ${message.body as string}`)
    .join('\n')
}

/* Asks the model for a topic and a verbatim quote describing one spike window. */
async function requestSpikeTopic(messages: ReadableMessage[], llm): Promise<{ topic: string; quote: string }> {
  return (await getChatPromptResponse(
    llm,
    VIBES_SPIKE_SYSTEM_PROMPT,
    VIBES_SPIKE_USER_TEMPLATE,
    { windowMessages: formatWindowMessages(messages) },
    undefined,
    SpikeTopicSchema
  )) as { topic: string; quote: string }
}

/* A message eligible to be a chat spike's quote: a participant (non-agent) line in the
   public chat, not a transcript speaker line or the moderator backchannel the reader also
   returns. */
export function isQuotableChat(message: ReadableMessage): boolean {
  return !message.fromAgent && Array.isArray(message.channels) && message.channels.includes('chat')
}

/* A message eligible to be a moderator spike's quote: a participant (non-agent) line in
   the moderator backchannel, used when the burst happened there rather than in the public
   chat. */
export function isQuotableModerator(message: ReadableMessage): boolean {
  return !message.fromAgent && Array.isArray(message.channels) && message.channels.includes('moderator')
}

/* The messages a spike may be quoted from, chosen by where the burst happened. A 'chat'
   spike quotes the public chat and a 'moderator' spike the backchannel, both channels the
   analyst is allowed to read. A 'private' spike is one-to-one messages with the bot, which
   the analyst never reads, so it has no quote pool and appears on the card by count alone. */
export function spikeQuotePool(messages: ReadableMessage[], source: SpikeSource): ReadableMessage[] {
  if (source === 'private') return []
  return messages.filter(source === 'moderator' ? isQuotableModerator : isQuotableChat)
}

/**
 * Labels the busiest spikes with what drove them. For each of the most significant
 * spikes, it reads the participant messages sent during that window, asks the model
 * for a topic and a quote, and keeps the result only when the quote is verbatim
 * window text. Every other spike, and any whose quote fails that check, comes back
 * with its numbers and no annotation. Spikes come back in their original time order,
 * and a model failure on one never aborts the rest. A spike is quoted from
 * the channel that drove it (its source): the public chat or the moderator backchannel.
 * A private spike, a burst of one-to-one messages with the bot, is never read, so it
 * keeps its numbers and no quote.
 */
export default async function annotateSpikes(
  messages: ReadableMessage[],
  eventStart: Date,
  spikes: ChatSpike[],
  llm
): Promise<ChatSpike[]> {
  if (spikes.length === 0) return spikes
  const selected = new Set(topSpikesBySignificance(spikes))

  return Promise.all(
    spikes.map(async (spike) => {
      if (!selected.has(spike)) return spike

      const windowMessages = spikeQuotePool(messagesDuringSpike(messages, eventStart, spike), spike.source)
      if (windowMessages.length === 0) return spike

      let candidate: { topic: string; quote: string }
      try {
        candidate = await requestSpikeTopic(windowMessages, llm)
      } catch {
        return spike
      }

      const annotation = groundAnnotation(candidate, windowMessages)
      return annotation ? { ...spike, annotation } : spike
    })
  )
}
