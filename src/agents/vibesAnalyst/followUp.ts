import { z } from 'zod'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { IMessage } from '../../types/index.types.js'
import { VIBES_FOLLOWUP_SYSTEM_PROMPT, VIBES_FOLLOWUP_USER_TEMPLATE } from './prompt.js'
import { fetchThread } from './thread.js'
import { EventCandidate } from './eventResolution.js'

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
    (message) => message.responseKind === 'curatedVibesSummary' && message.metricsContext !== undefined && message.metricsContext !== null
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
export async function resolveDisambiguationContext(userMessage: IMessage, conversationId: string): Promise<EventCandidate[] | null> {
  const thread = await fetchThread(userMessage, conversationId)
  const ancestorList = thread.find((message) => message.responseKind === 'eventDisambiguation' && Array.isArray(message.metricsContext))
  return ancestorList ? (ancestorList.metricsContext as EventCandidate[]) : null
}

const FollowUpAnswerSchema = z.object({
  answerable: z.boolean().describe('True only when every number the answer needs is present in the rows given'),
  text: z.string().nullable().describe('The plain-language answer when answerable; null otherwise')
})

/**
 * Answers one follow-up question against the metrics context a prior card was built from. Reads
 * as a Q&A pass over the same scalar rows the recap or trend already showed: no live recompute,
 * no message text, so it can only ever answer what those rows support.
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
    { question, metricsJson: JSON.stringify(metricsContext) },
    undefined,
    FollowUpAnswerSchema
  )) as z.infer<typeof FollowUpAnswerSchema>
}
