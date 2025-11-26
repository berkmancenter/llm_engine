import logger from '../../config/logger.js'
import Message from '../../models/message.model.js'
import detectTimeQuery, { TimeReference } from '../../utils/detectTimeQuery.js'
import getConversationHistory from './getConversationHistory.js'
import { formatTime, formatTranscript } from './llmInputFormatters.js'
import rag, { TRANSCRIPT_COLLECTION_PREFIX } from './rag.js'
import Conversation from '../../models/conversation.model.js'

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

async function searchTranscript(conversation, question, endTime?) {
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
              message.channels?.some((c) => c === 'transcript')
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

function getTranscriptMessages(conversation, timeWindow?, endTime?) {
  return getConversationHistory(conversation.messages, {
    channels: ['transcript'],
    ...(timeWindow !== undefined && { timeWindow }),
    ...(endTime !== undefined && { endTime })
  }).messages
}

function getTranscript(conversation, timeWindow?, endTime?) {
  const transcriptMsgs = getTranscriptMessages(conversation, timeWindow, endTime)
  return formatTranscript(transcriptMsgs)
}

async function loadEventMetadataIntoVectorStore(conversation) {
  // Delete old metadata documents if they exist
  await rag.removeFromVectorStore(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`, {
    type: { $in: ['event', 'presenter', 'moderator'] }
  })
  const docs: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metadatas: Record<string, any>[] = []

  if (conversation.description) {
    docs.push(`Event (Meeting Conversation Presentation) Description: ${conversation.description}`)
    metadatas.push({
      type: 'event'
    })
  }
  if (conversation.presenters?.length) {
    conversation.presenters.forEach((presenter) => {
      const bioText = presenter.bio || 'No bio provided.'
      docs.push(`${presenter.name} is a speaker, presenter, and panelist at this event. ${bioText}`)
      metadatas.push({
        type: 'presenter',
        presenterName: presenter.name
      })
    })
  }

  // Add moderator bios if provided
  if (conversation.moderators?.length) {
    conversation.moderators.forEach((moderator) => {
      const bioText = moderator.bio || 'No bio provided.'
      docs.push(`${moderator.name} is the moderator, facilitator, and host of this event. ${bioText}`)
      metadatas.push({
        type: 'moderator',
        moderatorName: moderator.name
      })
    })
  }

  // Only add to vector store if we have documents
  if (docs.length > 0) {
    await rag.addTextsToVectorStore(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`, docs, { metadatas })
  }
}

async function loadTranscriptIntoVectorStore(messages, conversationId) {
  if (!messages || messages.length === 0) {
    logger.warn('No messages to load')
    return
  }
  // Create a simple lookup map: formatted time -> original message
  const timeToMessageMap = new Map()
  messages.forEach((msg) => {
    const formattedTime = formatTime(msg.createdAt)
    timeToMessageMap.set(formattedTime, msg)
  })

  const metadataFn = (doc) => {
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
        start: chunkTimestamps[0]?.getTime(),
        end:
          chunkTimestamps.length > 1
            ? chunkTimestamps[chunkTimestamps.length - 1]?.getTime()
            : chunkTimestamps[0]?.getTime(),
        type: 'transcript'
      }
    }
  }
  const formattedTranscript = formatTranscript(messages)

  const conversation = await Conversation.findById(conversationId).select('transcript').lean()

  await rag.addTextsToVectorStore(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversationId}`, [formattedTranscript], {
    metadataFn,
    embeddingsPlatform: conversation?.transcript?.vectorStore?.embeddingsPlatform,
    embeddingsModelName: conversation?.transcript?.vectorStore?.embeddingsModelName
  })
}

async function deleteTranscript(conversation) {
  let transcriptRAG = false
  for (const agent of conversation.agents) {
    if (agent.useTranscriptRAGCollection) {
      transcriptRAG = true
    }
  }
  if (transcriptRAG) {
    logger.info(`Deleting transcript of conversation ${conversation._id} from vector store.`)
    try {
      await rag.deleteCollection(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`)
    } catch {
      logger.warn(`Failed to delete collection from vector store: ${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`)
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

export default {
  searchTranscript,
  loadTranscriptIntoVectorStore,
  loadEventMetadataIntoVectorStore,
  deleteTranscript,
  getTranscriptMessages,
  getTranscript
}
