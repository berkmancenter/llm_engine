import * as fuzzball from 'fuzzball'
import { getChatPromptResponse } from './llmChain'
import logger from '../../config/logger'

const nameMatchThreshold = 70

/**
 * Checks if a message contains a mention of the bot, allowing for minor misspellings.
 * @param text The message text to check.
 * @param botName The name of the bot.
 * @returns True if the message contains a mention of the bot, false otherwise.
 */
export function matchBotMention(text: string, botName: string): boolean {
  // Split and scan all consecutive word pairs for "<botName>" anywhere in the message
  const words = text.trim().split(/\s+/)
  if (words.length < 2) return false

  for (let i = 0; i < words.length - 1; i++) {
    const nameToken = words[i + 1].replace(/[,!.]+$/, '').toLowerCase()
    const nameScore = fuzzball.ratio(nameToken, botName.toLowerCase())

    if (nameScore >= nameMatchThreshold) {
      return true
    }
  }

  return false
}

/**
 * Uses an LLM to determine if a user message was intended for the bot.
 * @param llm The LLM instance to use for evaluation.
 * @param userMessage The user message to evaluate.
 * @returns A boolean indicating whether the message was intended for the bot.
 */
export async function checkIntent(llm, botName: string, userMessage) {
  const intentCheckPrompt = `You are evaluating whether a message in a group chat was intended as a question or request directed at an AI assistant named {botName}, even though the bot was not explicitly mentioned by name.

  Respond with a single JSON object: {{ "intended_for_bot": true }} or {{ "intended_for_bot": false }}
  - true: the message is clearly a question or request that would benefit from an AI assistant response (e.g. asking for help, information, analysis, code, etc.)
  - false: the message is casual conversation between humans, a statement, or clearly not directed at the bot`

  try {
    const intentResponse = await getChatPromptResponse(
      llm,
      intentCheckPrompt,
      'Message: {question}',
      { question: userMessage?.body, botName },
      { intended_for_bot: 'boolean' },
    )

    const parsed = JSON.parse(intentResponse.match(/\{.*\}/s)?.[0] ?? '{}')
    return parsed.intended_for_bot === true
  } catch (error) {
    logger.error(error)
    return false
  }
}
