import transcript from '../../agents/helpers/transcript.js'
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import { Conversation, Job, Message } from '../../models/index.js'
import { parseDuration } from '../../utils/detectTimeQuery.js'

const batchTranscript = async (job) => {
  const { conversationId } = job.attrs.data
  logger.debug(`batchTranscript start: ${conversationId}`)
  const progress = await Job.findOne({ name: 'batchTranscript', conversationId })
  const lastProcessedAt = progress?.lastProcessedAt || new Date()
  const messages = await Message.find({
    conversation: conversationId,
    createdAt: { $gt: lastProcessedAt },
    channels: { $in: ['transcript'] }
  }).sort({ createdAt: 1 })

  const updatedTime = new Date()
  if (messages.length) {
    await transcript.loadTranscriptIntoVectorStore(messages, conversationId)
  }
  await Job.findOneAndUpdate(
    { name: 'batchTranscript', conversationId },
    {
      $set: {
        lastProcessedAt: updatedTime
      }
    },
    { upsert: true }
  )
}
const cleanUpTranscripts = async () => {
  logger.info('Starting transcript cleanup job')

  const match = config.transcriptRetentionPeriod.match(/^(\w+)\s+(\w+)$/i)
  if (!match) {
    throw new Error(
      `Invalid duration format: "${config.transcriptRetentionPeriod}". Expected format: "{amount} {unit}" (e.g., "3 months", "2 weeks")`
    )
  }

  const [, amount, unit] = match
  const durationSeconds = parseDuration(amount, unit)
  const durationMs = durationSeconds * 1000
  const transcriptCutoff = new Date(Date.now() - durationMs)

  try {
    // Step 1: Find all messages in 'transcript' channel older than 3 months
    const oldTranscriptMessages = await Message.find({
      channels: { $in: ['transcript'] },
      createdAt: { $lt: transcriptCutoff }
    })
      .select('conversation')
      .lean()

    if (oldTranscriptMessages.length === 0) {
      logger.info('No expired transcripts found')
      return
    }

    // Step 2: Extract unique conversation IDs
    const uniqueConversationIds = [...new Set(oldTranscriptMessages.map((msg) => msg.conversation?._id?.toString()))]
    logger.info(`Found ${uniqueConversationIds.length} unique conversations with transcripts to clean up`)

    const conversations = await Conversation.find({
      _id: { $in: uniqueConversationIds }
    })
      .populate('agents') // Populate agents
      .lean()

    // Step 3: Process each conversation
    const batchSize = 10 // Process 10 conversations at a time
    for (let i = 0; i < conversations.length; i += batchSize) {
      const conversationBatch = conversations.slice(i, i + batchSize)
      await Promise.all(
        conversationBatch.map(async (conversation) => {
          try {
            await transcript.deleteTranscript(conversation)
            logger.info(`Deleted transcript for conversation ${conversation._id}`)
          } catch (error) {
            logger.error(`Error processing conversation ${conversation._id}:`, error)
          }
        })
      )
      // Small delay between batches to reduce load
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    logger.info('Transcript cleanup complete')
  } catch (error) {
    logger.error('Error during transcript cleanup job:', error)
    throw error
  }
}
const transcriptHandlers = {
  batchTranscript,
  cleanUpTranscripts
}
export default transcriptHandlers
