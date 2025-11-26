import mongoose from 'mongoose'
import { Message, Conversation, User } from '../../src/models/index.js'
import { formatTranscript } from '../../src/agents/helpers/llmInputFormatters.js'

async function saveMessage(message, pseudonym, pseudonymId, createdAt, channels, conversation) {
  const agentMessage = new Message({
    conversation,
    pseudonym,
    pseudonymId,
    body: message,
    createdAt,
    channels,
    bodyType: 'json'
  })

  await agentMessage.save()
  conversation.messages.push(agentMessage.toObject())
}

function parseTimestamp(timestampStr) {
  // Handle timestamps in the format "-1:22"
  if (timestampStr.startsWith('-')) {
    const parts = timestampStr.substring(1).split(':')
    const minutes = parseInt(parts[0], 10)
    const seconds = parseInt(parts[1], 10)
    return -(minutes * 60 + seconds)
  }
  const parts = timestampStr.split(':')
  const minutes = parseInt(parts[0], 10)
  const seconds = parseInt(parts[1], 10)
  return minutes * 60 + seconds
}

function parseChatLine(line, delimiter) {
  const parts = line.split(delimiter)
  const timestampStr = parts[0].trim()
  const timestamp = parseTimestamp(timestampStr)
  const userCommentPart = parts[1].trim()
  const colonIndex = userCommentPart.indexOf(':')
  const user = userCommentPart.substring(0, colonIndex).trim()
  const comment = userCommentPart.substring(colonIndex + 1).trim()
  return {
    timestamp,
    user,
    comment
  }
}

function parseChatTranscript(transcript, delimiter) {
  const lines = transcript.split('\n')
  const chatObjects = lines.filter((line) => line.trim() !== '').map((line) => parseChatLine(line, delimiter))
  return chatObjects
}

export async function loadTranscript(
  transcript,
  conversation,
  channels: string[] = [],
  delimiter = '-',
  startDate = new Date(Date.now()),
  bodyType = 'string'
) {
  const comments = parseChatTranscript(transcript, delimiter)
  let messageConversation = conversation
  if (typeof conversation === 'string' || conversation instanceof mongoose.Types.ObjectId) {
    messageConversation = await Conversation.findOne({ _id: conversation })
  }

  await messageConversation.populate('messages')
  // Grab a pseudonym ID from a random user. A valid one is required for message creation, but not used
  const user = await User.findOne()
  const pseudonymId = user?.pseudonyms[0]._id
  for (const comment of comments) {
    await saveMessage(
      bodyType === 'json' ? { text: comment.comment } : comment.comment,
      comment.user,
      pseudonymId,
      new Date(startDate.getTime() + comment.timestamp * 1000),
      channels,
      messageConversation
    )
  }
}

export async function generateTranscript(conversation) {
  let messageConversation = conversation
  if (typeof conversation === 'string' || conversation instanceof mongoose.Types.ObjectId) {
    messageConversation = await Conversation.findOne({ _id: conversation })
  }

  await messageConversation.populate('messages')
  const transcriptMessages = messageConversation.messages
    .filter((m) => m.channels.includes('transcript'))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  return formatTranscript(transcriptMessages)
}
