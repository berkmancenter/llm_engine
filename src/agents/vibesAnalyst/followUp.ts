import { z } from 'zod'
import Message from '../../models/message.model.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { IMessage } from '../../types/index.types.js'
import { VIBES_FOLLOWUP_SYSTEM_PROMPT, VIBES_FOLLOWUP_USER_TEMPLATE } from './prompt.js'

/**
 * Walks this message's thread (its parent plus every reply to it) for the most recent card VA
 * posted that carries stored metrics context, so a follow-up question can be answered from the
 * same numbers rather than falling through to the generic "outside what I read" reply. A thread
 * can hold more than one VA card (a recap, then later a trend), so the newest one wins: it is
 * the one the follow-up most likely means. Returns null when the message is not a threaded
 * reply, or no card in the thread carries metrics context.
 */
export async function resolveFollowUpContext(userMessage: IMessage, conversationId: string): Promise<unknown | null> {
  if (!userMessage.parentMessage) return null

  const thread = await Message.find({
    conversation: conversationId,
    $or: [{ _id: userMessage.parentMessage }, { parentMessage: userMessage.parentMessage }]
  }).sort({ createdAt: -1 })
  const ancestorCard = thread.find(
    (message) => message.responseKind === 'curatedVibesSummary' && message.metricsContext !== undefined && message.metricsContext !== null
  )
  return ancestorCard ? ancestorCard.metricsContext : null
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
