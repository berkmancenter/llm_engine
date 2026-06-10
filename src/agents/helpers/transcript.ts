import logger from '../../config/logger.js'
import Message from '../../models/message.model.js'
import detectTimeQuery, { TimeReference } from '../../utils/detectTimeQuery.js'
import getConversationHistory from './getConversationHistory.js'
import { formatTime, formatTranscript } from './llmInputFormatters.js'
import rag, { TRANSCRIPT_COLLECTION_PREFIX } from './rag.js'
import Conversation from '../../models/conversation.model.js'
import Topic from '../../models/topic.model.js'
import { getTranscriptHistoryChannelNames } from './agentChannels.js'

export const TOPIC_TRANSCRIPT_COLLECTION_PREFIX = 'topic-transcript'

/**
 * Convert time string into a Date object, inferring from the startTime
 */
function toDate(timeString, startTime) {
  const [hour, minute = 0, second = 0] = timeString.split(':').map(Number)
  const resultDate = new Date(startTime.getTime())
  // If hour is in 12-hour format (1-12), infer AM/PM from startTime
  let adjustedHour = hour
  if (hour >= 1 && hour <= 12) {
    const startHour = startTime.getHours()

    // If start time is in PM (12-23), assume input is also PM
    if (startHour >= 12) {
      adjustedHour = hour === 12 ? 12 : hour + 12
    }
    // If start time is in AM (0-11), assume input is AM unless it's 12 (noon)
    else {
      adjustedHour = hour === 12 ? 12 : hour
    }
  }
  // If hour is already in 24-hour format (0-23), use as-is
  resultDate.setHours(adjustedHour, minute, second, 0)
  return resultDate
}

async function buildTimeQuery(timeQuery: TimeReference, startTime: Date, endTime?: Date) {
  let end
  let timeWindow
  if (timeQuery.type === 'relative') {
    timeWindow = timeQuery.duration! * 1000
    if (timeQuery.direction === 'first') {
      end = new Date(startTime.getTime() + timeWindow)
    } else {
      end = endTime || new Date()
    }
  } else if (timeQuery.type === 'absolute') {
    const time = toDate(timeQuery.time!, startTime)
    const buffer = 2.5 * 60 // +/- 2.5 minutes
    timeWindow = buffer * 2 * 1000
    end = new Date(time.getTime() + buffer * 1000)
  } else if (timeQuery.type === 'range') {
    const start = toDate(timeQuery.startTime!, startTime)
    end = toDate(timeQuery.endTime!, startTime)
    timeWindow = end.getTime() - start.getTime()
  } else {
    throw new Error('Unsupported time query type')
  }
  return {
    startTime: new Date(end.getTime() - timeWindow),
    endTime: end,
    timeWindow
  }
}

async function searchTranscript(agent, question, endTime?) {
  const { conversation } = agent
  const transcriptChannels = getTranscriptHistoryChannelNames(agent)
  const timeQuery = detectTimeQuery(question, conversation.startTime, endTime)
  const k = 10
  if (timeQuery) {
    try {
      const timeFilter = await buildTimeQuery(timeQuery, conversation.startTime, endTime)
      return {
        chunks: formatTranscript(
          conversation.messages.filter(
            (message) =>
              message.createdAt >= timeFilter.startTime &&
              message.createdAt <= timeFilter.endTime &&
              message.channels?.some((c) => transcriptChannels.includes(c))
          )
        ),
        timeWindow: true
      }
    } catch (e) {
      logger.warn(`Error building time query: ${e.message}. Ignoring...`)
    }
  }
  const filter = endTime
    ? {
        $or: [
          { start: { $lte: endTime.getTime() } }, // Transcript chunks within time range
          { type: { $in: ['event', 'presenter', 'moderator'] } } // Always include metadata
        ]
      }
    : undefined
  const { chunks } = await rag.getContextChunksForQuestion(
    `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`,
    question,
    undefined,
    filter,
    k,
    conversation.transcript?.vectorStore?.embeddingsPlatform,
    conversation.transcript?.vectorStore?.embeddingsModelName,
    0.8
  )

  return { chunks, timeWindow: false }
}

function getTranscriptMessages(agent, timeWindow?, endTime?) {
  const transcriptChannels = getTranscriptHistoryChannelNames(agent)
  return getConversationHistory(agent.conversation.messages, {
    channels: transcriptChannels,
    ...(timeWindow !== undefined && { timeWindow }),
    ...(endTime !== undefined && { endTime })
  }).messages
}

function getTranscript(agent, timeWindow?, endTime?) {
  return formatTranscript(getTranscriptMessages(agent, timeWindow, endTime))
}

async function loadEventMetadataIntoVectorStore(conversation) {
  const conversationId = conversation._id.toString()
  const topicId = conversation.topic?._id?.toString() ?? conversation.topic?.toString()
  const metadataTypeFilter = { type: { $in: ['event', 'presenter', 'moderator'] } }

  // Remove stale metadata from per-conversation collection
  try {
    await rag.removeFromVectorStore(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversationId}`, metadataTypeFilter)
  } catch (error) {
    // Collection might not exist yet, which is fine
    logger.debug(`Could not remove old metadata (collection may not exist): ${error.message}`)
  }

  // Remove stale metadata for this conversation from the topic collection
  if (topicId) {
    try {
      await rag.removeFromVectorStore(`${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`, {
        $and: [{ conversationId }, metadataTypeFilter]
      })
    } catch (error) {
      logger.debug(`Could not remove old topic metadata (collection may not exist): ${error.message}`)
    }
  }

  const docs: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metadatas: Record<string, any>[] = []

  const eventDoc = conversation.description
    ? `Event: ${conversation.name}. ${conversation.description}`
    : `Event: ${conversation.name}`
  docs.push(eventDoc)
  metadatas.push({ type: 'event' })

  if (conversation.presenters?.length) {
    conversation.presenters.forEach((presenter) => {
      const bioText = presenter.bio || 'No bio provided.'
      const altText = presenter.alternateName ? ` (also known as "${presenter.alternateName}")` : ''
      docs.push(`${presenter.name}${altText} is a speaker, presenter, and panelist at this event. ${bioText}`)
      metadatas.push({ type: 'presenter', presenterName: presenter.name })
    })
  }
  if (conversation.moderators?.length) {
    conversation.moderators.forEach((moderator) => {
      const bioText = moderator.bio || 'No bio provided.'
      const altText = moderator.alternateName ? ` (also known as "${moderator.alternateName}")` : ''
      docs.push(`${moderator.name}${altText} is the moderator, facilitator, and host of this event. ${bioText}`)
      metadatas.push({ type: 'moderator', moderatorName: moderator.name })
    })
  }

  const conversationIdentifierMetadatas = metadatas.map((m) => ({
    ...m,
    conversationId,
    conversationName: conversation.name
  }))

  await rag.addTextsToVectorStore(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversationId}`, docs, {
    metadatas: conversationIdentifierMetadatas
  })

  if (topicId) {
    await rag.addTextsToVectorStore(`${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`, docs, {
      metadatas: conversationIdentifierMetadatas
    })
  }
}

async function loadTranscriptIntoVectorStore(messages, conversationId) {
  if (!messages || messages.length === 0) {
    logger.warn('No messages to load')
    return
  }
  const conversation = await Conversation.findById(conversationId).select('name topic transcript').lean()

  // Create a simple lookup map: formatted time -> original message
  const timeToMessageMap = new Map()
  messages.forEach((msg) => {
    const formattedTime = formatTime(msg.createdAt)
    timeToMessageMap.set(formattedTime, msg)
  })

  const formattedTranscript = formatTranscript(messages)
  const embeddingsPlatform = conversation?.transcript?.vectorStore?.embeddingsPlatform
  const embeddingsModelName = conversation?.transcript?.vectorStore?.embeddingsModelName

  const makeMetadataFn =
    (extraMetadata: Record<string, unknown> = {}) =>
    (doc) => {
      const chunkLines = doc.pageContent.split('\n').filter((line) => line.trim())
      // Extract timestamps from this chunk and map back to original ISO timestamps
      const chunkTimestamps = chunkLines
        .map((line) => {
          const timeMatch = line.match(/^\[(.*?)\]/)
          if (timeMatch) {
            const formattedTime = timeMatch[1] // e.g., "14:30:25"
            const originalMsg = timeToMessageMap.get(formattedTime)
            return originalMsg ? originalMsg.createdAt : null
          }
          return null
        })
        .filter(Boolean)
        .sort((a, b) => a.getTime() - b.getTime())
      return {
        ...doc,
        metadata: {
          ...extraMetadata,
          start: chunkTimestamps[0]?.getTime(),
          end:
            chunkTimestamps.length > 1
              ? chunkTimestamps[chunkTimestamps.length - 1]?.getTime()
              : chunkTimestamps[0]?.getTime(),
          type: 'transcript'
        }
      }
    }

  const conversationIdentifierMetadata = { conversationId: conversationId.toString(), conversationName: conversation?.name }

  // Always write to the per-conversation collection
  await rag.addTextsToVectorStore(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversationId}`, [formattedTranscript], {
    metadataFn: makeMetadataFn(conversationIdentifierMetadata),
    embeddingsPlatform,
    embeddingsModelName
  })

  // Also write to the topic collection if the conversation belongs to one.
  // Always use default embeddings for the topic collection so all conversations
  // in a topic are embedded consistently, regardless of per-conversation overrides.
  if (conversation?.topic) {
    const topicId = conversation.topic._id?.toString() ?? conversation.topic.toString()
    await rag.addTextsToVectorStore(`${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`, [formattedTranscript], {
      metadataFn: makeMetadataFn(conversationIdentifierMetadata)
    })
  }
}

async function loadTopicMetadataIntoVectorStore(topic) {
  const topicId = topic._id.toString()
  const collectionName = `${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`
  const doc = topic.description ? `Series: ${topic.name}. ${topic.description}` : `Series: ${topic.name}`

  try {
    await rag.removeFromVectorStore(collectionName, { type: 'series' })
  } catch (error) {
    logger.debug(`Could not remove old series metadata (collection may not exist): ${error.message}`)
  }

  await rag.addTextsToVectorStore(collectionName, [doc], {
    metadatas: [{ type: 'series', topicId }]
  })
}

async function loadTopicTranscriptsIntoVectorStore(topicId) {
  const topic = await Topic.findById(topicId).select('_id name description').lean()
  if (topic) {
    await loadTopicMetadataIntoVectorStore(topic)
  }

  const conversations = await Conversation.find({ topic: topicId })
    .select('_id name description presenters moderators transcript')
    .lean()

  let loaded = 0
  let skipped = 0
  const collectionName = `${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`

  for (const conversation of conversations) {
    // Check if this conversation is already present in the topic collection
    try {
      const collection = await rag.getCollection(collectionName)
      const existing = await collection.get({ where: { conversationId: conversation._id.toString() }, limit: 1 })
      if (existing.ids.length > 0) {
        logger.debug(`Topic transcript: skipping already-loaded conversation ${conversation._id}`)
        skipped++
        continue
      }
    } catch {
      // Collection doesn't exist yet — proceed to load
    }

    const messages = await Message.find({
      conversation: conversation._id,
      channels: { $in: ['transcript'] }
    })
      .sort({ createdAt: 1 })
      .lean()

    await loadEventMetadataIntoVectorStore({ ...conversation, topic: topicId })

    // loadTranscriptIntoVectorStore writes to both the per-conversation and topic collections
    if (messages.length > 0) {
      await loadTranscriptIntoVectorStore(messages, conversation._id)
    } else {
      logger.warn(`Topic transcript: no transcript messages found for conversation ${conversation._id}`)
    }

    logger.info(`Topic transcript: loaded conversation ${conversation._id} (${conversation.name}) into topic ${topicId}`)
    loaded++
  }

  return { loaded, skipped }
}

async function clearTranscript(conversation) {
  logger.info(`Clearing transcript content from vector store for conversation ${conversation._id}`)
  const conversationId = conversation._id.toString()
  const transcriptTypeFilter = { type: 'transcript' }
  try {
    // Remove only transcript-type documents, preserve event/speaker/moderator metadata
    await rag.removeFromVectorStore(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversationId}`, transcriptTypeFilter)
  } catch {
    logger.warn(`Failed to clear transcript from vector store: ${TRANSCRIPT_COLLECTION_PREFIX}-${conversationId}`)
  }

  const topicId = conversation.topic?._id?.toString() ?? conversation.topic?.toString()
  if (topicId) {
    try {
      await rag.removeFromVectorStore(`${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`, {
        $and: [{ conversationId }, transcriptTypeFilter]
      })
    } catch {
      logger.warn(`Failed to clear transcript from topic collection ${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`)
    }
  }
  // Find all messages for this conversation in transcript channel
  const messagesToDelete = await Message.find({
    conversation,
    channels: { $in: ['transcript'] }
  })
    .select('_id')
    .lean()

  // Delete transcript messages from Mongo
  await Message.deleteMany({
    _id: { $in: messagesToDelete }
  })
}

async function deleteTranscript(conversation) {
  logger.info(`Deleting transcript collection from vector store for conversation ${conversation._id}`)
  try {
    // Delete the entire per-conversation collection including all metadata
    await rag.deleteCollection(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`)
  } catch {
    logger.warn(`Failed to delete collection from vector store: ${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`)
  }

  // Remove this conversation's documents from the topic collection
  const topicId = conversation.topic?._id?.toString() ?? conversation.topic?.toString()
  if (topicId) {
    try {
      await rag.removeFromVectorStore(`${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`, {
        conversationId: conversation._id.toString()
      })
    } catch {
      logger.warn(
        `Failed to remove conversation ${conversation._id} from topic collection ${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`
      )
    }
  }
  // Find all messages for this conversation in transcript channel
  const messagesToDelete = await Message.find({
    conversation,
    channels: { $in: ['transcript'] }
  })
    .select('_id')
    .lean()

  // Delete transcript messages from Mongo
  await Message.deleteMany({
    _id: { $in: messagesToDelete }
  })
}

async function deleteTopicCollection(topic) {
  const topicId = topic._id.toString()
  const collectionName = `${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`
  try {
    await rag.deleteCollection(collectionName)
    logger.info(`Deleted RAG collection for topic ${topicId}`)
  } catch (error) {
    logger.warn(`Failed to delete RAG collection for topic ${topicId}: ${error.message}`)
  }
}

export default {
  searchTranscript,
  loadTranscriptIntoVectorStore,
  loadTopicTranscriptsIntoVectorStore,
  loadTopicMetadataIntoVectorStore,
  loadEventMetadataIntoVectorStore,
  clearTranscript,
  deleteTranscript,
  deleteTopicCollection,
  getTranscriptMessages,
  getTranscript
}
