import { z } from 'zod'
import { getChatPromptResponse } from './llmChain.js'
import logger from '../../config/logger.js'

/**
 * Professionalism validation schema
 */
const ProfessionalismSchema = z.object({
  isAppropriate: z.boolean().describe('Whether the intervention is appropriate'),
  reasoning: z.string().describe('Internal analysis of why the intervention is or is not appropriate.'),
  category: z
    .enum(['appropriate', 'romantic_sexual', 'inappropriate_personal', 'other_unprofessional'])
    .describe('Professionalism category')
})

type ProfessionalismAnalysis = z.infer<typeof ProfessionalismSchema>

const SYSTEM_PROMPT = `You are a professionalism validator for an AI agent that facilitates professional discussions and events.

Your job is to evaluate whether a proposed agent intervention maintains appropriate professional boundaries and explain your reasoning.

PROFESSIONAL STANDARDS:
- The agent has a sarcastic-expert personality and can push boundaries with humor
- Sharp wit, provocative questions, and playful commentary are ALLOWED and encouraged
- Challenging assumptions and being intellectually provocative is APPROPRIATE

UNPROFESSIONAL CONTENT TO REJECT:
1. Romantic or sexual implications about participants (even lighthearted)
2. Personal relationship speculation (dating, attraction, compatibility)
3. Comments on physical appearance or personal attributes unrelated to the discussion
4. Overly personal questions about participants' private lives
5. Content that crosses from professional banter into personal territory

CONTEXT MATTERS:
- Consider the event topic and conversation context
- Professional roasting and intellectual provocation = OK
- Personal commentary about participants = NOT OK
- Making participants uncomfortable about personal matters = NOT OK

## Output Format
Return a JSON object:

{{
  "isAppropriate": boolean (true if the message maintains professional boundaries, false otherwise),
  "reasoning": brief internal analysis of why the intervention is or is not appropriate,
  "category": "appropriate" | "romantic_sexual" | "inappropriate_personal" | "other_unprofessional"
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`

const USER_PROMPT = `Event Topic: {topic}

Intervention Type: {interventionType}

Recent Context:
{recentContext}

Proposed Agent Message:
"{message}"

Is this message appropriate for a professional facilitation agent?`

/**
 * Validates that an intervention message maintains professional boundaries
 *
 * @param llm - LLM instance to use for validation
 * @param message - The intervention message to validate
 * @param topic - The topic of the event or discussion
 * @param interventionType - The type of intervention (e.g., signal, provocation, play)
 * @param context - Conversation context for context-aware validation
 *
 * @returns true if appropriate, false if unprofessional
 */
export default async function validateProfessionalism(llm, message, topic, interventionType?, context?) {
  try {
    // Call LLM with structured output
    const analysis = (await getChatPromptResponse(
      llm,
      SYSTEM_PROMPT,
      USER_PROMPT,
      {
        topic,
        interventionType: interventionType || 'N/A',
        recentContext: context.slice(-500) || 'No recent context available.',
        message
      },
      [], // No chat history
      ProfessionalismSchema
    )) as ProfessionalismAnalysis

    // Log rejections for monitoring and improvement
    if (!analysis.isAppropriate) {
      logger.warn(
        `[ProfessionalismGuardrail] Rejected intervention message: ${message}. Rejection category: ${analysis.category}. Reason: ${analysis.reasoning}`
      )
    }

    return analysis.isAppropriate
  } catch (error) {
    // Fail open: if validation fails, allow the message through
    // This prevents the guardrail from blocking legitimate content due to API errors
    logger.error('[ProfessionalismGuardrail] Validation error, failing open', error)
    return true
  }
}
