import { z } from 'zod'
import { getAgentStructuredResponse } from '../helpers/llmChain.js'
import logger from '../../config/logger.js'
import createVibesAnalystTools from './tools.js'
import verifyCuratedCard from './verifyCuration.js'
import { buildOnDemandQuestionMessage, VIBES_ONDEMAND_SYSTEM_PROMPT } from './prompt.js'
import { ConversationMetrics } from '../../types/index.types.js'

/* What the answering model returns. `reasoning` comes first so the arithmetic is worked out
   before `answerable` is committed to; without it a small model tends to reason its way to a
   conclusion in the text while leaving the boolean at whatever it emitted first (the same fix
   the critic's schema carries). */
const OnDemandAnswerSchema = z.object({
  reasoning: z
    .string()
    .describe('Which numbers you used and how you got to the answer, including any arithmetic, before deciding'),
  answerable: z
    .boolean()
    .describe('True only when the data given plus the tool results you actually ran answer the question'),
  text: z.string().nullable().describe('The plain-language answer when answerable; null otherwise')
})

/**
 * Answers one question about a single event by computing something new over that event's own
 * messages, for the questions its precomputed metrics cannot reach ("how many people posted
 * more than three times?", "how busy were the first ten minutes?").
 *
 * The model runs against tools bound to this one conversation, so the answer can never draw on
 * another event, and the tools return counts only, never message text, so this stays a
 * measuring pass rather than a reading one. Whatever it computes then goes through the same
 * fact-checking pass a recap card does, with the tool results attached to the metrics so a
 * cited on-demand number can be traced back to the computation that produced it. An answer the
 * fact-checker cannot back is withheld rather than sent.
 *
 * Returns null whenever no answer should be sent: the model found the question unanswerable,
 * the fact-checker rejected the answer, or the loop failed outright. The caller falls back to
 * its own honest "I couldn't work that out" reply, so a failure here never surfaces as an error.
 */
export default async function answerWithOnDemandMetrics(
  question: string,
  conversation,
  metrics: ConversationMetrics,
  llm
): Promise<string | null> {
  const { tools, computations } = createVibesAnalystTools(conversation)

  try {
    const answer = (await getAgentStructuredResponse(
      llm,
      tools,
      VIBES_ONDEMAND_SYSTEM_PROMPT,
      buildOnDemandQuestionMessage(conversation.name, JSON.stringify(metrics), question),
      OnDemandAnswerSchema
    )) as z.infer<typeof OnDemandAnswerSchema>

    if (!answer.answerable || !answer.text) return null

    const verified = await verifyCuratedCard(
      { header: `Answer about ${conversation.name}`, standouts: [{ text: answer.text }] },
      { ...metrics, onDemandComputations: computations },
      llm
    )

    if (verified.standouts.length === 0) {
      logger.warn(
        `Vibes Analyst dropped an on-demand answer for ${conversation._id} that the fact-check could not back: "${answer.text}"`
      )
      return null
    }

    return answer.text
  } catch (error: unknown) {
    logger.warn(
      `Vibes Analyst could not compute an on-demand answer for ${conversation._id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  }
}
