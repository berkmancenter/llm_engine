import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import Conversation from '../../models/conversation.model.js'
import { findMessages } from '../../utils/messageVisibility.js'
import getConversationHistory from '../helpers/getConversationHistory.js'
import { formatMultiUserConversationHistory } from '../helpers/llmInputFormatters.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { getModelChat, coreLLMPlatform, coreLLMModel } from '../helpers/getModelChat.js'
import {
  OPEN_THREADS_EXTRACTION_PROMPT,
  openThreadsSchema
} from '../../services/conversation.service/openThreadsCriteria.js'

const OPEN_THREADS_LIMIT = 20 // safety valve, not expected to matter for a normal-sized series
// A conversation "concluding" doesn't by itself guarantee its content has faded from view — it
// could have ended minutes ago. So this floor applies to both tiers: a tier-1 past conversation
// must have actually ENDED this long ago, and tier-2's live extraction never even sees chat
// messages this recent — in neither case should something still fresh in view get resurfaced as
// if it were a dormant thread.
const MIN_THREAD_AGE_MS = 3 * 24 * 60 * 60 * 1000 // 3 days

const GROUP_CHAT_USER_TEMPLATE = `Group Chat History:\n{sharedChat}`

export interface OpenThreadsToolOptions {
  topicIds: string[]
  activeConversationId?: string
}

/**
 * `list_open_threads`: questions/ideas worth revisiting later, searched in priority order so the
 * model only ever sees one list. First, questions each past conversation's stop-time extraction
 * already identified (see lifecycle.ts's openThreadsExtraction) across every past conversation in
 * this conversation's topic(s) — cheap, since that judgment already happened once. Only when none
 * of those are available does it fall back to applying the same judgment live, on the fly, to this
 * conversation's own group chat history — the only option for an ongoing community conversation
 * that never "stops" and so never gets a stop-time extraction of its own. Pairs with event_history,
 * which grounds a chosen one with a real excerpt from that specific conversation's transcript.
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
        createdAt: { $lt: recencyCutoff }
      })
      const sortedMessages = messages.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
      const chatHistory = getConversationHistory(sortedMessages, { channels: ['chat'] })
      const sharedChat =
        formatMultiUserConversationHistory(chatHistory)
          .map((m) => (m.role === 'assistant' ? `AI Assistant: ${m.content}` : m.content))
          .join('\n') || 'No participant chat messages.'

      const llm = await getModelChat(coreLLMPlatform, coreLLMModel, { maxTokens: 2000 })
      const { openThreads } = await getChatPromptResponse(
        llm,
        OPEN_THREADS_EXTRACTION_PROMPT,
        GROUP_CHAT_USER_TEMPLATE,
        { sharedChat },
        undefined,
        openThreadsSchema
      )

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
