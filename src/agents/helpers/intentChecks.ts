import * as fuzzball from 'fuzzball'
import { z } from 'zod'
import { getChatPromptResponse } from './llmChain.js'
import logger from '../../config/logger.js'

const intentCheckSchema = z.object({
  intended_for_bot: z.boolean()
})

const nameMatchThreshold = 70

/**
 * Checks if a message contains a mention of the bot, allowing for minor misspellings.
 * @param text The message text to check.
 * @param botName The name of the bot.
 * @returns True if the message contains a mention of the bot, false otherwise.
 */
export function matchBotMention(text: string[], botName: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const nameToken = text[i]
      .replace(/^@/, '')
      .replace(/[,!.]+$/, '')
      .toLowerCase()
    const nameScore = fuzzball.ratio(nameToken, botName.toLowerCase())

    if (nameScore >= nameMatchThreshold) {
      return true
    }
  }

  return false
}

/**
 * Determines if a user message was intended for the bot.
 * First checks for a fuzzy bot name mention; if found, returns true immediately.
 * Otherwise, uses an LLM to evaluate intent.
 * @param llm The LLM instance to use for evaluation.
 * @param botName The name of the bot.
 * @param userMessage The user message to evaluate.
 * @returns A boolean indicating whether the message was intended for the bot.
 */
export async function checkBotIntent(llm, botName: string, userMessage) {
  const words = userMessage?.body?.trim().split(/\s+/) ?? []
  if (matchBotMention(words, botName)) return true

  const intentCheckPrompt = `You are evaluating whether a message in a group chat was intended as a question or request directed at an AI assistant named {botName}, even though the bot was not explicitly mentioned by name.

  Examples of this might include:
  - "What did I miss?"
  - "Catch me up"
  - "Who is speaking?"
  - "Can you help me?"
  - "What is the agenda?"
  - "What does this do?"

  Essentially, you are looking for phrases that indicate a question or request directed at the bot, but where the user has forgotten to tag the bot by name. When in doubt, you should default to false.

  Respond with a single JSON object: {{ "intended_for_bot": true }} or {{ "intended_for_bot": false }}
  - true: the message is clearly a question or request that would benefit from an AI assistant response (e.g. asking for help, information, analysis, code, etc.)
  - false: the message is casual conversation between humans, a statement, or clearly not directed at the bot`

  try {
    const intentResponse = await getChatPromptResponse(
      llm,
      intentCheckPrompt,
      'Message: {question}',
      { question: userMessage?.body, botName },
      [],
      intentCheckSchema
    )

    return intentResponse.intended_for_bot === true
  } catch (error) {
    logger.error(error)
    return false
  }
}
