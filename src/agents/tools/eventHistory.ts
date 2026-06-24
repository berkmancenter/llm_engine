import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import mongoose from 'mongoose'
import { IncludeEnum } from 'chromadb'
import Conversation from '../../models/conversation.model.js'
import rag, { TRANSCRIPT_COLLECTION_PREFIX } from '../helpers/rag.js'
import { TOPIC_TRANSCRIPT_COLLECTION_PREFIX } from '../helpers/transcript.js'
import logger from '../../config/logger.js'

export interface TopicRef {
  id: string
  name: string
  description?: string
}

export interface EventHistoryToolOptions {
  /**
   * When set, results exclude this conversation — used by the eventAssistant so its
   * series-history search returns only *other* past events, not the current live event
   * (whose transcript is already in the assistant's normal context).
   */
  excludeConversationId?: string
}

async function getIndexedConversationIds(topicIds: string[]): Promise<Set<string>> {
  const ids = new Set<string>()
  await Promise.all(
    topicIds.map(async (topicId) => {
      try {
        const collection = await rag.getCollection(`${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`)
        const result = await collection.get({ include: [IncludeEnum.Metadatas] })
        for (const meta of result.metadatas ?? []) {
          const convId = meta?.conversationId
          if (typeof convId === 'string') ids.add(convId)
        }
      } catch (e) {
        logger.warn(`getIndexedConversationIds: could not query topic collection for ${topicId}: ${e.message}`)
      }
    })
  )
  return ids
}

export default function createEventHistoryTools(topics: TopicRef[], options: EventHistoryToolOptions = {}) {
  const topicIds = topics.map((t) => t.id)
  const { excludeConversationId } = options

  // Only honor a caller-supplied topicId if it is one of the configured series — otherwise a
  // hallucinated/invalid id (e.g. the series name) would point at a non-existent collection.
  const resolveSearchTopicIds = (topicId?: string) =>
    topicId && topicIds.includes(topicId) ? [topicId] : topicIds

  const getEventListTool = tool(
    async ({ since, until, topicId }) => {
      const searchTopicIds = resolveSearchTopicIds(topicId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const query: Record<string, any> = { topic: { $in: searchTopicIds.map((id) => new mongoose.Types.ObjectId(id)) } }

      // Filter to only conversations that have actual transcript data indexed in Chroma.
      // We query the topic-level collection (scoped to this series) and extract distinct
      // conversationId values from chunk metadata — no cross-series data is fetched.
      const indexedIds = await getIndexedConversationIds(searchTopicIds)
      const objectIds = [...indexedIds].map((id) => new mongoose.Types.ObjectId(id))
      if (objectIds.length > 0) {
        query._id = excludeConversationId
          ? { $in: objectIds, $ne: new mongoose.Types.ObjectId(excludeConversationId) }
          : { $in: objectIds }
      } else if (excludeConversationId) {
        query._id = { $ne: new mongoose.Types.ObjectId(excludeConversationId) }
      }
      if (since || until) {
        query.startTime = {}
        if (since) query.startTime.$gte = new Date(since)
        if (until) query.startTime.$lte = new Date(until)
      }
      const conversations = await Conversation.find(query)
        .select('_id name description startTime endTime topic')
        .populate('topic', 'name description')
        .sort({ startTime: -1 })
        .lean()

      const results = conversations.map((c) => {
        const topic = c.topic as unknown as { name: string; description?: string } | null
        return {
          id: c._id.toString(),
          name: c.name,
          series: topic?.name || null,
          seriesDescription: topic?.description || null,
          description: c.description || null,
          startTime: c.startTime?.toISOString() || null,
          endTime: c.endTime?.toISOString() || null
        }
      })
      logger.debug(`get_event_list: ${results.length} events across ${searchTopicIds.length} topic(s)`)
      return JSON.stringify(results)
    },
    {
      name: 'get_event_list',
      description:
        'List past events in this series that have searchable transcript data, sorted most-recent-first. ' +
        'The current event is already excluded — every result is a PRIOR session, not the current one. ' +
        'If you get 1 result, that IS the previous session. ' +
        'Use this to identify a specific event by name or date before drilling into its transcript, ' +
        'or to answer questions about when events occurred. ' +
        'For questions about what past events covered, prefer search_topic_transcripts (searches all at once) ' +
        'rather than listing events first. ' +
        'Optionally filter by a specific series topicId or a date range.',
      schema: z.object({
        since: z
          .string()
          .optional()
          .describe('ISO date string — return events starting on or after this date, e.g. "2025-01-01"'),
        until: z
          .string()
          .optional()
          .describe('ISO date string — return events starting on or before this date, e.g. "2025-12-31"'),
        topicId: z
          .string()
          .optional()
          .describe('Limit results to a specific event series by its ID. Omit to search all series.')
      })
    }
  )

  const formatChunk = (doc) => {
    const label = doc.metadata?.conversationName ? `[Past Event: ${doc.metadata.conversationName}]` : '[Past Event]'
    return `${label}\n${doc.pageContent}`
  }

  const searchTopicTranscriptsTool = tool(
    async ({ query, topicId }) => {
      const searchTopicIds = resolveSearchTopicIds(topicId)

      // Exclude the current event's own chunks so series history returns only other events.
      const chunkFilter = excludeConversationId ? { conversationId: { $ne: excludeConversationId } } : undefined

      const allChunks: string[] = []
      await Promise.all(
        searchTopicIds.map(async (id) => {
          const collectionName = `${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${id}`
          try {
            // No score threshold — this tool is for discovery; always return the best matches
            // so the LLM can see what past events covered even for broad/meta queries.
            const { chunks } = await rag.getContextChunksForQuestion(
              collectionName,
              query,
              formatChunk,
              chunkFilter,
              10
            )
            if (chunks) allChunks.push(chunks)
          } catch (error) {
            logger.warn(`search_topic_transcripts: no data for topic ${id}: ${error.message}`)
          }
        })
      )

      if (allChunks.length === 0) return 'No relevant content found.'
      return allChunks.join('\n\n---\n\n')
    },
    {
      name: 'search_topic_transcripts',
      description:
        "Semantic search across all event transcripts in this channel's event series. Use this to find what was " +
        'discussed across events, identify speakers by subject area, or determine which events ' +
        'covered a particular topic. Each result chunk is prefixed with the event name it came from. ' +
        'Optionally filter to a specific series by topicId.',
      schema: z.object({
        query: z
          .string()
          .describe('The search query, e.g. "AI regulation", "speaker who discussed cartoons", "breakfast cereals"'),
        topicId: z
          .string()
          .optional()
          .describe('Limit search to a specific event series by its ID. Omit to search all series.')
      })
    }
  )

  const searchConversationTranscriptTool = tool(
    async ({ conversationId, query }) => {
      if (!mongoose.Types.ObjectId.isValid(conversationId)) {
        return `Invalid conversationId "${conversationId}". You must pass the "id" field from get_event_list results, not the event name.`
      }
      if (excludeConversationId && conversationId === excludeConversationId) {
        return 'That is the current event — its transcript is already in your context. Use this tool only for other past events in the series.'
      }
      const collectionName = `${TRANSCRIPT_COLLECTION_PREFIX}-${conversationId}`
      try {
        const conversation = await Conversation.findById(conversationId).select('transcript').lean()
        if (!conversation) {
          return `Conversation with id ${conversationId} not found. Please ensure you are passing a valid conversationId from get_event_list results.`
        }
        const embeddingsPlatform = conversation.transcript?.vectorStore?.embeddingsPlatform
        const embeddingsModelName = conversation.transcript?.vectorStore?.embeddingsModelName
        const { chunks } = await rag.getContextChunksForQuestion(
          collectionName,
          query,
          formatChunk,
          undefined,
          10,
          embeddingsPlatform,
          embeddingsModelName,
          0.8
        )
        if (!chunks) return 'No relevant content found in that event.'
        return chunks
      } catch (error) {
        logger.warn(`search_conversation_transcript failed for ${conversationId}: ${error.message}`)
        return 'No transcript data available for that event.'
      }
    },
    {
      name: 'search_conversation_transcript',
      description:
        "Semantic search within a specific event's transcript. Use this after identifying the right " +
        'event via get_event_list or search_topic_transcripts to retrieve exact quotes or details of ' +
        'what a specific person said. ' +
        'IMPORTANT: conversationId must be the "id" field (a hex string like "507f1f77bcf86cd799439011") ' +
        'from get_event_list results — never the event name.',
      schema: z.object({
        conversationId: z
          .string()
          .describe('The "id" hex string from get_event_list results. Do NOT pass the event name here.'),
        query: z.string().describe("The specific content to search for within this event's transcript")
      })
    }
  )

  return [getEventListTool, searchTopicTranscriptsTool, searchConversationTranscriptTool]
}
