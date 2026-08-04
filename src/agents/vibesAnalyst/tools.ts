import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import {
  computeMessageLengthStats,
  countMessageActivity,
  loadMessagesForOnDemandMetrics
} from '../../services/conversationAnalytics.service.js'
import { MessageMetricFilter, OnDemandComputation } from '../../types/index.types.js'

/* The filter every tool below shares. The computations themselves are fixed and run server
   side, so these arguments are the whole vocabulary a question can be asked in: a window, a
   surface, a length floor. That is deliberate. It lets one tool answer both "how busy were the
   first ten minutes" and "did anyone post after the halfway mark" while every number still
   comes out of a function here rather than out of the model. */
const MESSAGE_FILTER_FIELDS = {
  fromMinute: z
    .number()
    .optional()
    .describe('Start of the window, in minutes after the event started; inclusive. Omit to start at the event start.'),
  toMinute: z
    .number()
    .optional()
    .describe('End of the window, in minutes after the event started; exclusive. Omit to run to the end of the event.'),
  channel: z
    .enum(['public', 'private', 'all'])
    .optional()
    .describe(
      'Which surface to read: "public" is the group chat everyone sees, "private" is one-to-one messages with the bot, "all" is both. Defaults to all.'
    ),
  minWordCount: z
    .number()
    .optional()
    .describe('Count only messages of at least this many words, to exclude one-word reactions. Omit to count them all.')
}

/* The shared preamble for every tool description, so the model is told the same three limits
   whichever tool it reaches for. */
const TOOL_SCOPE =
  "Covers only this one event, only messages people sent (never the bot's own), and never returns any message text."

/**
 * Builds the set of computations the analyst can run over one event's messages when a question
 * needs a number its precomputed metrics do not hold, alongside the record of what actually ran.
 *
 * Every tool is bound to this one conversation, so a question can never pull in another event's
 * data. The messages are loaded once, on the first call, and reused across the rest.
 *
 * The returned `computations` array fills as the model calls tools. It is what the fact-checking
 * pass reads to verify a cited number against the computation that produced it, the same way it
 * verifies every other number against the metrics.
 */
export default function createVibesAnalystTools(conversation): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[]
  computations: OnDemandComputation[]
} {
  const computations: OnDemandComputation[] = []

  let loading: ReturnType<typeof loadMessagesForOnDemandMetrics> | null = null
  const loadMessages = () => {
    if (!loading) loading = loadMessagesForOnDemandMetrics(conversation._id)
    return loading
  }

  function record(name: string, args: OnDemandComputation['args'], result: OnDemandComputation['result']): string {
    computations.push({ tool: name, args, result })
    return JSON.stringify(result)
  }

  const countMessagesTool = tool(
    async ({ minMessages, ...filter }: MessageMetricFilter & { minMessages?: number }) => {
      const { messages, directNames } = await loadMessages()
      const context = { startTime: conversation.startTime, directNames }
      const result = countMessageActivity(messages, filter, minMessages ?? null, context)
      return record('count_messages', { ...filter, ...(minMessages !== undefined && { minMessages }) }, result)
    },
    {
      name: 'count_messages',
      description:
        'Counts how many messages were sent in a slice of the event, how many different people sent them, and ' +
        'optionally how many of those people cleared a message threshold. Use it for "how busy was the first ten ' +
        'minutes", "did anyone post after the halfway mark", or "how many people posted more than three times". ' +
        `Call it twice with different windows to compare two stretches. ${TOOL_SCOPE}`,
      schema: z.object({
        ...MESSAGE_FILTER_FIELDS,
        minMessages: z
          .number()
          .optional()
          .describe('Also report how many people sent at least this many messages. Omit when no threshold was asked for.')
      })
    }
  )

  const measureLengthsTool = tool(
    async (filter: MessageMetricFilter) => {
      const { messages, directNames } = await loadMessages()
      const context = { startTime: conversation.startTime, directNames }
      return record('measure_message_lengths', filter, computeMessageLengthStats(messages, filter, context))
    },
    {
      name: 'measure_message_lengths',
      description:
        'Measures how long the messages in a slice of the event were, in words: the typical length and the longest. ' +
        'Use it for "were these one-line reactions or worked-out thoughts". Word counts only, so it says how much ' +
        `people wrote, never what they wrote. ${TOOL_SCOPE}`,
      schema: z.object(MESSAGE_FILTER_FIELDS)
    }
  )

  return { tools: [countMessagesTool, measureLengthsTool], computations }
}
