import { z } from 'zod'
import { IAgent, PollConfig } from '../../types/index.types.js'
import { getChatPromptResponse } from './llmChain.js'
import pollService from '../../services/poll.service/index.js'
import logger from '../../config/logger.js'
import WHEN_RESULTS_VISIBLE from '../../models/poll.model/constants.js'

const pollSchema = z.object({
  title: z.string().describe('The poll question posed to participants'),
  choices: z
    .array(z.string())
    .min(2)
    .max(5)
    .describe('2-5 distinct options reflecting genuine positions participants might hold'),
  introMessage: z.string().describe('A brief 1-2 sentence message introducing the poll to the group')
})

const SYSTEM_PROMPT = `You are facilitating a live event discussion. Your job is to create a poll that captures a genuine point of tension or divergence in the conversation.`

const USER_TEMPLATE = `Focus: {focus}

Context:
{context}

Create a poll with choices that reflect distinct, genuine positions participants might hold, and write a brief intro message for the group.`

/**
 * Prompts the LLM for poll content (title, choices, intro message), then creates
 * the poll in the database and returns the full message body for embedding in chat.
 *
 * @param focus        - Short description of what to poll about (from intervention analysis).
 * @param context      - Rendered conversation context (transcript, chat history, etc.).
 * @param pollConfig   - Poll visibility/behaviour settings.
 * @param instructions - Optional additional instructions appended to the system prompt
 *                       to shape poll style or purpose (e.g. "reveal results immediately").
 */
export default async function createAgentPoll(
  this: IAgent & { getLLM: () => Promise<unknown> },
  focus: string,
  context: string,
  pollConfig: PollConfig,
  instructions?: string
): Promise<{
  type: 'poll'
  pollId: string
  text: string
  title: string
  choices: string[]
  multiSelect: boolean
  allowNewChoices: boolean
  whenResultsVisible: string
} | null> {
  const llm = await this.getLLM()
  const systemPrompt = instructions ? `${SYSTEM_PROMPT}\n\n${instructions}` : SYSTEM_PROMPT

  const result = (await getChatPromptResponse(
    llm,
    systemPrompt,
    USER_TEMPLATE,
    { focus, context },
    undefined,
    pollSchema
  )) as z.infer<typeof pollSchema>

  if (!result?.title || !result?.choices?.length || !result?.introMessage) {
    logger.warn('createAgentPoll: LLM returned incomplete poll data')
    return null
  }

  try {
    const poll = await pollService.createPoll(
      {
        title: result.title,
        choices: result.choices.map((text) => ({ text })),
        conversationId: this.conversation._id!.toString(),
        ...pollConfig
      },
      this
    )
    logger.info(`createAgentPoll: created poll "${result.title}" (${poll._id})`)
    return {
      type: 'poll' as const,
      pollId: poll._id.toString(),
      text: result.introMessage,
      title: result.title,
      choices: result.choices,
      multiSelect: pollConfig.multiSelect ?? false,
      allowNewChoices: pollConfig.allowNewChoices ?? false,
      whenResultsVisible: pollConfig.whenResultsVisible ?? WHEN_RESULTS_VISIBLE.ALWAYS
    }
  } catch (error) {
    logger.error('createAgentPoll: failed to create poll', error)
    return null
  }
}
