import { z } from 'zod'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { IMessage } from '../../types/index.types.js'
import { VIBES_FOLLOWUP_SYSTEM_PROMPT, VIBES_FOLLOWUP_USER_TEMPLATE } from './prompt.js'
import { fetchThread } from './thread.js'
import { EventCandidate } from './eventResolution.js'
import eventDateLabel from '../../utils/eventDateLabel.js'

/**
 * Walks this message's thread (its parent plus every reply to it) for the most recent card VA
 * posted that carries stored metrics context, so a follow-up question can be answered from the
 * same numbers rather than falling through to the generic "outside what I read" reply. A thread
 * can hold more than one VA card (a recap, then later a trend), so the newest one wins: it is
 * the one the follow-up most likely means. Returns null when the message is not a threaded
 * reply, or no card in the thread carries metrics context.
 */
export async function resolveFollowUpContext(userMessage: IMessage, conversationId: string): Promise<unknown | null> {
  const thread = await fetchThread(userMessage, conversationId)
  const ancestorCard = thread.find(
    (message) =>
      message.responseKind === 'curatedVibesSummary' &&
      message.metricsContext !== undefined &&
      message.metricsContext !== null
  )
  return ancestorCard ? ancestorCard.metricsContext : null
}

/**
 * Walks this message's thread for the most recent disambiguation list VA posted (its "which one
 * did you mean?" reply), so a bare reply naming one of those options can resolve directly
 * against them. Without this, a reply like a plain event title never reaches extractEventReference
 * looking like a fresh recap request: it has no thread context of its own, so it reads as
 * unaddressed small talk on its own. Returns null when the message is not a threaded reply, or no
 * disambiguation list exists in the thread.
 */
export async function resolveDisambiguationContext(
  userMessage: IMessage,
  conversationId: string
): Promise<EventCandidate[] | null> {
  const thread = await fetchThread(userMessage, conversationId)
  const ancestorList = thread.find(
    (message) => message.responseKind === 'eventDisambiguation' && Array.isArray(message.metricsContext)
  )
  return ancestorList ? (ancestorList.metricsContext as EventCandidate[]) : null
}

const FollowUpAnswerSchema = z.object({
  answerable: z.boolean().describe('True only when every number the answer needs is present in the rows given'),
  text: z.string().nullable().describe('The plain-language answer when answerable; null otherwise')
})

/* Adds a plain-language Boston date to each row from its stored endTime, so the answerer can field
   "when was this?" without reading a raw UTC timestamp and can report the day in the same zone as
   the rest of the card. Rows without a usable endTime pass through untouched. */
function withReadableDates(metricsContext: unknown): unknown {
  if (!Array.isArray(metricsContext)) return metricsContext
  return metricsContext.map((row) => {
    if (!row || typeof row !== 'object') return row
    const { endTime } = row as Record<string, unknown>
    if (endTime === undefined || endTime === null) return row
    const date = eventDateLabel(null, new Date(endTime as string | number | Date), '')
    return date ? { ...(row as Record<string, unknown>), date } : row
  })
}

/**
 * Answers one follow-up question against the metrics context a prior card was built from. Reads
 * as a Q&A pass over the same rows the recap or trend already showed, each tagged with a readable
 * date: no live recompute, no message text, so it can only ever answer what those rows support.
 */
export async function answerFollowUp(
  question: string,
  metricsContext: unknown,
  llm
): Promise<z.infer<typeof FollowUpAnswerSchema>> {
  return (await getChatPromptResponse(
    llm,
    VIBES_FOLLOWUP_SYSTEM_PROMPT,
    VIBES_FOLLOWUP_USER_TEMPLATE,
    { question, metricsJson: JSON.stringify(withReadableDates(metricsContext)) },
    undefined,
    FollowUpAnswerSchema
  )) as z.infer<typeof FollowUpAnswerSchema>
}
