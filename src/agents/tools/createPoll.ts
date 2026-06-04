import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import logger from '../../config/logger.js'
import pollService from '../../services/poll.service/index.js'

export interface PollConfig {
  multiSelect?: boolean
  allowNewChoices?: boolean
  choicesVisible?: boolean
  responseCountsVisible?: boolean
  onlyOwnChoicesVisible?: boolean
  whenResultsVisible?: string
  responsesVisible?: boolean
  responsesVisibleToNonParticipants?: boolean
  threshold?: number
  defaultExpirationMinutes?: number
}

export function createPollTool(
  conversationId: string,
  agent: object,
  pollConfig: PollConfig = {},
  description: string,
  onPollCreated?: (pollId: string) => void
) {
  const { defaultExpirationMinutes = 3, ...defaults } = pollConfig

  return tool(
    async ({ title, pollDescription, choices, expirationMinutes }) => {
      const expirationDate = new Date(Date.now() + (expirationMinutes ?? defaultExpirationMinutes) * 60 * 1000)
      try {
        const poll = await pollService.createPoll(
          {
            title,
            description: pollDescription,
            choices: choices.map((text) => ({ text })),
            conversationId,
            ...defaults,
            expirationDate
          },
          agent
        )
        logger.info(`create_poll tool: created poll "${title}" (${poll._id})`)
        onPollCreated?.(poll._id.toString())
        return `Poll created successfully: "${title}" (id: ${poll._id})`
      } catch (error) {
        logger.error('create_poll tool: failed to create poll', error)
        return `Failed to create poll: ${error instanceof Error ? error.message : String(error)}`
      }
    },
    {
      name: 'create_poll',
      description,
      schema: z.object({
        title: z.string().describe('The poll question posed to participants'),
        pollDescription: z.string().optional().describe('Optional context or framing shown with the poll'),
        choices: z
          .array(z.string())
          .min(2)
          .max(5)
          .describe('Poll choices as plain strings, 2–5 options reflecting distinct genuine positions'),
        expirationMinutes: z
          .number()
          .min(1)
          .max(10)
          .optional()
          .describe(`Minutes until the poll closes. Default: ${defaultExpirationMinutes}`)
      })
    }
  )
}
