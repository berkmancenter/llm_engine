import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import Conversation from '../../models/conversation.model.js'
import { findMessages } from '../../utils/messageVisibility.js'
import getConversationHistory from '../helpers/getConversationHistory.js'
import { formatMultiUserConversationHistory, formatAbsoluteDateTime } from '../helpers/llmInputFormatters.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { getModelChat, coreLLMPlatform, coreLLMModel } from '../helpers/getModelChat.js'
import {
  OPEN_THREADS_EXTRACTION_PROMPT,
  MAX_OPEN_THREADS,
  openThreadsSchema
} from '../../services/conversation.service/openThreadsCriteria.js'

const OPEN_THREADS_LIMIT = 20 // safety valve, not expected to matter for a normal-sized series
// Applies to both tiers: a tier-1 conversation must have ended this long ago, and tier-2
// never sees chat this recent — neither should resurface something still fresh in view.
const MIN_THREAD_AGE_MS = 3 * 24 * 60 * 60 * 1000 // 3 days
// Tier 2 only: without this, a long-lived community channel's entire chat history (minus the
// last MIN_THREAD_AGE_MS) would be re-sent to the extraction LLM on every tick where tier 1 has
// nothing cached, growing unbounded over the channel's lifetime. Also doubles as a relevance
// floor — a thread quiet for two months is arguably stale rather than worth resurfacing.
const MAX_THREAD_AGE_MS = 60 * 24 * 60 * 60 * 1000 // 60 days

const GROUP_CHAT_USER_TEMPLATE = `Current Time: {currentTime}\n\nGroup Chat History:\n{sharedChat}`

export interface OpenThreadsToolOptions {
  topicIds: string[]
  activeConversationId?: string
}

/**
 * `list_open_threads`: past-discussion candidates. Tier 1: cached stop-time extractions from
 * past conversations; tier 2 (fallback): the same judgment applied live to this conversation's
 * own chat history when no past conversation has any. Pairs with event_history to ground one.
 */
export default function createOpenThreadsTools(options: OpenThreadsToolOptions): StructuredToolInterface[] {
  const { topicIds, activeConversationId } = options

  const listOpenThreadsTool = tool(
    async () => {
      const recencyCutoff = new Date(Date.now() - MIN_THREAD_AGE_MS)
      const pastConversations = await Conversation.find({
        topic: { $in: topicIds },
        'postEventAnalysis.openThreads': { $exists: true, $ne: [] },
        endTime: { $lt: recencyCutoff }
      })
        .select('name startTime postEventAnalysis.openThreads')
        .sort({ startTime: -1 })
        .limit(OPEN_THREADS_LIMIT)
        .lean()

      if (pastConversations.length > 0) {
        return pastConversations
          .flatMap((conversation) =>
            (conversation.postEventAnalysis?.openThreads ?? []).map((question) => {
              const date = conversation.startTime
                ? new Date(conversation.startTime).toISOString().slice(0, 10)
                : 'unknown date'
              // id included directly so search_conversation_transcript can be called right away,
              // without a separate get_event_list round trip just to look the id up by name/date.
              return `[${conversation.name} — ${date} — id: ${conversation._id.toString()}] ${question}`
            })
          )
          .join('\n')
      }

      if (!activeConversationId) return 'No open threads are available yet.'

      const messages = await findMessages(activeConversationId, 'model', {
        channels: { $in: ['chat'] },
        createdAt: { $lt: recencyCutoff, $gte: new Date(Date.now() - MAX_THREAD_AGE_MS) }
      })
      const sortedMessages = messages.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
      const chatHistory = getConversationHistory(sortedMessages, { channels: ['chat'] })
      const sharedChat =
        formatMultiUserConversationHistory(chatHistory)
          .map((m) => (m.role === 'assistant' ? `AI Assistant: ${m.content}` : m.content))
          .join('\n') || 'No participant chat messages.'

      const llm = await getModelChat(coreLLMPlatform, coreLLMModel, { maxTokens: 2000 })
      const extraction = await getChatPromptResponse(
        llm,
        OPEN_THREADS_EXTRACTION_PROMPT,
        GROUP_CHAT_USER_TEMPLATE,
        { sharedChat, currentTime: formatAbsoluteDateTime(chatHistory.end ?? new Date()) },
        undefined,
        openThreadsSchema
      )
      const openThreads = extraction.openThreads.slice(0, MAX_OPEN_THREADS)

      if (openThreads.length === 0) return 'No open threads are available yet.'

      // The most recent message actually considered — i.e. the last point this was touched
      // before going quiet — is a more useful anchor than the oldest one for judging how
      // dormant this candidate actually is.
      const lastConsidered = sortedMessages.at(-1)?.createdAt
      const date = lastConsidered ? new Date(lastConsidered).toISOString().slice(0, 10) : 'unknown date'

      return openThreads
        .map((question) => `[Earlier in this chat — ${date} — id: ${activeConversationId}] ${question}`)
        .join('\n')
    },
    {
      name: 'list_open_threads',
      description:
        'Lists questions/ideas worth revisiting later — from past conversations in this series, or if none of ' +
        "those have any, from this conversation's own group chat history. Most recent conversation first. Pick " +
        "one not already covered by your own recent posts. An entry tagged with a PAST conversation's own id " +
        "needs grounding — pass that id directly as search_conversation_transcript's conversationId (no need to " +
        'call get_event_list first) to pull a real excerpt before using it. An entry tagged "Earlier in this ' +
        'chat" was already drawn directly from this conversation\'s real messages — chat history is not ' +
        'searchable by that tool, so no further retrieval call is needed or possible for it.',
      schema: z.object({})
    }
  )

  return [listOpenThreadsTool]
}
