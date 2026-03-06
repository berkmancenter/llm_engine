import httpStatus from 'http-status'
import fs from 'fs/promises'
import path from 'path'
import handlebars from 'handlebars'
import { Message, Conversation, Channel } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import logger from '../config/logger.js'
import { IConversation } from '../types/index.types.js'

interface FeedbackReport {
  type: 'rating' | 'text'
  value: string
}

interface CommentReport {
  user: string
  text: string
  timestamp?: Date
  fromAgent?: boolean
  feedback?: FeedbackReport[]
  messageType?: string
}

interface MessageReport {
  timestamp?: { start: Date; end?: Date }
  comments: CommentReport[]
  responses?: Record<string, unknown> | Record<string, unknown>[]
  hasResponses: boolean
}

interface DirectMessageReport {
  comments: CommentReport[]
  username: string
  userMsgCount: number
}

interface PeriodicAgentReport {
  name: string
  messages: MessageReport[]
}

interface AdditionalChannelReport {
  channelName: string
  messages: CommentReport[]
  totalUsers: number
}

interface DirectMessageAgentReport {
  name: string
  messages: DirectMessageReport[]
  participantCount: number
  minEngagements: number
  maxEngagements: number
  avgEngagements: number
  userCount: number
  additionalChannels?: AdditionalChannelReport[]
  aggregateMetrics: {
    feedbackRatings: Record<string, number>
    directMessagesPerUser: Record<string, number>
    additionalChannelMessagesPerUser?: Record<string, Record<string, number>>
  }
}

interface ReportMetadata {
  name?: string
  description?: string
  executedAt?: Date
  baseConversationId?: string
}

async function findComments(createdAtQuery, conversationId) {
  const matchQuery = {
    createdAt: createdAtQuery,
    fromAgent: false,
    channels: { $ne: 'transcript' }
  }
  const conversation = await Conversation.findById(conversationId)
    .populate({
      path: 'messages',
      match: matchQuery,
      options: { sort: { createdAt: 1 } }
    })
    .exec()

  const comments = conversation!.messages.map((m) => {
    const text: string =
      m.bodyType === 'json' || m.bodyType === 'multimodal'
        ? ((m.body as Record<string, unknown>).text as string)
        : (m.body as string)
    return {
      user: m.pseudonym,
      text,
      timestamp: m.createdAt
    }
  })
  return comments
}

async function generateUserMetricsData(
  conversation,
  agentType: string,
  metadata?: ReportMetadata,
  additionalChannelNames: string[] = []
) {
  await conversation.populate('agents')

  // Find the specific agent by type
  const agent = conversation.agents.find((a) => a.agentType === agentType)
  if (!agent) {
    throw new ApiError(httpStatus.NOT_FOUND, `Agent '${agentType}' not found in conversation`)
  }

  // Only process agents that have perMessage triggers
  if (!agent.triggers?.perMessage) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Agent '${agentType}' does not have perMessage triggers`)
  }

  // Find all the channels in which this agent participates
  const directChannels = await Channel.find({
    direct: true,
    participants: agent._id
  })

  // Collect all unique pseudonyms from all direct channels using participant IDs
  const allPseudonyms = new Set<string>()
  for (const channel of directChannels) {
    // Populate participants to get User objects
    await channel.populate('participants')
    // Filter to get non-agent participants (users)
    for (const participant of channel.participants!) {
      // Check if this participant is not the agent
      if (participant._id!.toString() !== agent._id.toString()) {
        // Get the active pseudonym from the User
        const { activePseudonym } = participant
        if (activePseudonym) {
          allPseudonyms.add(activePseudonym.pseudonym)
        }
      }
    }
  }

  // Also collect from additional channels (using messages since they don't have participants)
  for (const channelName of additionalChannelNames) {
    const channelMessages = await Message.find({
      channels: channelName,
      conversation: conversation._id
    })
    for (const msg of channelMessages) {
      if (msg.pseudonym && !msg.fromAgent) {
        allPseudonyms.add(msg.pseudonym)
      }
    }
  }

  // Calculate direct messages per user
  const directMessagesPerUser: Record<string, number> = {}
  // Initialize all pseudonyms with 0
  for (const pseudonym of allPseudonyms) {
    directMessagesPerUser[pseudonym] = 0
  }

  // Count messages in direct channels
  for (const channel of directChannels) {
    const directMessages = await Message.find({
      channels: channel.name,
      conversation: conversation._id,
      fromAgent: false
    })

    for (const msg of directMessages) {
      if (msg.pseudonym) {
        directMessagesPerUser[msg.pseudonym] = (directMessagesPerUser[msg.pseudonym] || 0) + 1
      }
    }
  }

  // 3. Messages on additional channels per user per channel
  const additionalChannelMessagesPerUser: Record<string, Record<string, number>> = {}
  if (additionalChannelNames.length > 0) {
    for (const channelName of additionalChannelNames) {
      if (!additionalChannelMessagesPerUser[channelName]) {
        additionalChannelMessagesPerUser[channelName] = {}
        // Initialize all pseudonyms with 0 for this channel
        for (const pseudonym of allPseudonyms) {
          additionalChannelMessagesPerUser[channelName][pseudonym] = 0
        }
      }

      const channelMessages = await Message.find({
        channels: channelName,
        conversation: conversation._id,
        fromAgent: false
      })

      for (const msg of channelMessages) {
        if (msg.pseudonym) {
          additionalChannelMessagesPerUser[channelName][msg.pseudonym] =
            (additionalChannelMessagesPerUser[channelName][msg.pseudonym] || 0) + 1
        }
      }
    }
  }

  const aggregateMetrics = {
    directMessagesPerUser,
    ...(Object.keys(additionalChannelMessagesPerUser).length > 0 && { additionalChannelMessagesPerUser })
  }

  return {
    ...(metadata && { experiment: { ...metadata, _id: conversation._id } }),
    resultConversation: conversation._id.toString(),
    baseConversation: metadata?.baseConversationId || conversation._id.toString(),
    agentName: agent.name,
    aggregateMetrics
  }
}

async function generateDirectMessageAgentsData(
  conversation,
  metadata?: ReportMetadata,
  additionalChannelNames: string[] = []
) {
  await conversation.populate('agents')

  const agents: DirectMessageAgentReport[] = []

  for (const agent of conversation.agents) {
    // Only process agents that have perMessage triggers
    if (!agent.triggers?.perMessage) {
      continue
    }

    const messages: DirectMessageReport[] = []
    // Find all the channels in which this agent participates
    const directChannels = await Channel.find({
      direct: true,
      participants: agent._id
    })
    const totalUsers = directChannels.length
    for (const channel of directChannels) {
      const directMessages = await Message.find({
        channels: channel.name,
        conversation: conversation._id
      }).sort({ createdAt: 1 })

      // Fetch all feedback messages for this conversation
      const feedbackMessages = await Message.find({
        channels: 'feedback',
        conversation: conversation._id
      })

      // Create a map of messageId -> feedback[] for quick lookup
      const feedbackMap = new Map<string, FeedbackReport[]>()
      for (const feedbackMsg of feedbackMessages) {
        if (feedbackMsg.bodyType === 'json' && typeof feedbackMsg.body === 'object') {
          const feedbackBody = feedbackMsg.body as Record<string, unknown>
          if (feedbackBody.messageId && feedbackBody.type && feedbackBody.value) {
            const messageId = feedbackBody.messageId as string
            const feedback: FeedbackReport = {
              type: feedbackBody.type as 'rating' | 'text',
              value: feedbackBody.value as string
            }

            if (!feedbackMap.has(messageId)) {
              feedbackMap.set(messageId, [])
            }
            feedbackMap.get(messageId)!.push(feedback)
          }
        }
      }

      const comments: CommentReport[] = directMessages.map((msg) => {
        const text: string =
          msg.bodyType === 'json' || msg.bodyType === 'multimodal'
            ? ((msg.body as Record<string, unknown>).text as string)
            : (msg.body as string)
        const comment: CommentReport = {
          user: msg.pseudonym,
          text,
          timestamp: msg.createdAt,
          fromAgent: msg.fromAgent,
          ...((msg.bodyType === 'json' || msg.bodyType === 'multimodal') && { messageType: msg.bodyType })
        }

        // Add feedback if this is an agent message and feedback exists
        if (msg.fromAgent && feedbackMap.has(msg._id.toString())) {
          comment.feedback = feedbackMap.get(msg._id.toString())
        }

        return comment
      })
      // Only include interactions where a human sent at least one message
      const humanMessages = directMessages.filter((msg) => !msg.fromAgent)
      if (humanMessages.length > 0) {
        messages.push({ username: humanMessages[0].pseudonym, comments, userMsgCount: humanMessages.length })
      }
    }

    // Process additional channels
    const additionalChannels: AdditionalChannelReport[] = []
    for (const channelName of additionalChannelNames) {
      const channelMessages = await Message.find({
        channels: channelName,
        conversation: conversation._id
      }).sort({ createdAt: 1 })

      if (channelMessages.length > 0) {
        const comments: CommentReport[] = channelMessages.map((msg) => {
          const text: string =
            msg.bodyType === 'json' || msg.bodyType === 'multimodal'
              ? ((msg.body as Record<string, unknown>).text as string)
              : (msg.body as string)
          return {
            user: msg.pseudonym,
            text,
            timestamp: msg.createdAt,
            fromAgent: msg.fromAgent,
            ...((msg.bodyType === 'json' || msg.bodyType === 'multimodal') && { messageType: msg.bodyType })
          }
        })

        // Calculate unique pseudonyms for this channel
        const uniquePseudonyms = new Set(channelMessages.map((msg) => msg.pseudonym))

        additionalChannels.push({
          channelName,
          messages: comments,
          totalUsers: uniquePseudonyms.size
        })
      }
    }

    // Only include agents that have direct channels to message users on
    if (totalUsers > 0) {
      const userMsgCounts = messages.map((msg) => msg.userMsgCount)

      // Collect all unique pseudonyms from all direct channels using participant IDs
      const allPseudonyms = new Set<string>()
      for (const channel of directChannels) {
        // Populate participants to get User objects
        await channel.populate('participants')
        // Filter to get non-agent participants (users)
        for (const participant of channel.participants!) {
          // Check if this participant is not the agent
          if (participant._id!.toString() !== agent._id.toString()) {
            // Get the active pseudonym from the User
            const { activePseudonym } = participant
            if (activePseudonym) {
              allPseudonyms.add(activePseudonym.pseudonym)
            }
          }
        }
      }

      // Also collect from additional channels (using messages since they don't have participants)
      for (const channelName of additionalChannelNames) {
        const channelMessages = await Message.find({
          channels: channelName,
          conversation: conversation._id
        })
        for (const msg of channelMessages) {
          if (msg.pseudonym && !msg.fromAgent) {
            allPseudonyms.add(msg.pseudonym)
          }
        }
      }

      // Calculate per-agent metrics
      // 1. Feedback ratings count for this agent
      const feedbackRatings: Record<string, number> = {}
      for (const message of messages) {
        for (const comment of message.comments) {
          if (comment.feedback) {
            for (const feedback of comment.feedback) {
              if (feedback.type === 'rating') {
                const ratingValue = feedback.value
                feedbackRatings[ratingValue] = (feedbackRatings[ratingValue] || 0) + 1
              }
            }
          }
        }
      }

      // 2. Direct messages per user (non-agent) for this agent
      const directMessagesPerUser: Record<string, number> = {}
      // Initialize all pseudonyms with 0
      for (const pseudonym of allPseudonyms) {
        directMessagesPerUser[pseudonym] = 0
      }
      for (const message of messages) {
        const { username } = message
        for (const comment of message.comments) {
          if (!comment.fromAgent) {
            directMessagesPerUser[username] = (directMessagesPerUser[username] || 0) + 1
          }
        }
      }

      // 3. Messages on additional channels per user per channel for this agent
      const additionalChannelMessagesPerUser: Record<string, Record<string, number>> = {}
      if (additionalChannels.length > 0) {
        for (const channel of additionalChannels) {
          if (!additionalChannelMessagesPerUser[channel.channelName]) {
            additionalChannelMessagesPerUser[channel.channelName] = {}
            // Initialize all pseudonyms with 0 for this channel
            for (const pseudonym of allPseudonyms) {
              additionalChannelMessagesPerUser[channel.channelName][pseudonym] = 0
            }
          }
          for (const message of channel.messages) {
            if (!message.fromAgent) {
              const username = message.user
              additionalChannelMessagesPerUser[channel.channelName][username] =
                (additionalChannelMessagesPerUser[channel.channelName][username] || 0) + 1
            }
          }
        }
      }

      agents.push({
        name: agent.name,
        messages,
        participantCount: messages.length,
        userCount: totalUsers,
        minEngagements: messages.length > 0 ? Math.min(...userMsgCounts) : 0,
        maxEngagements: messages.length > 0 ? Math.max(...userMsgCounts) : 0,
        avgEngagements:
          messages.length > 0 ? userMsgCounts.reduce((acc, count) => acc + count, 0) / userMsgCounts.length : 0,
        ...(additionalChannels.length > 0 && { additionalChannels }),
        aggregateMetrics: {
          feedbackRatings,
          directMessagesPerUser,
          ...(Object.keys(additionalChannelMessagesPerUser).length > 0 && { additionalChannelMessagesPerUser })
        }
      })
    }
  }

  return {
    ...(metadata && { experiment: { ...metadata, _id: conversation._id } }),
    resultConversation: conversation._id.toString(),
    baseConversation: metadata?.baseConversationId || conversation._id.toString(),
    agents
  }
}

async function generatePeriodicAgentsData(conversation, metadata?: ReportMetadata) {
  await conversation.populate('agents')

  const conversationId = conversation._id
  const agents: PeriodicAgentReport[] = []
  for (const agent of conversation.agents) {
    let startTime
    let endTime

    const agentMessages = await Message.find({
      conversation: conversationId,
      fromAgent: true,
      pseudonymId: agent.pseudonyms[0]._id
    })
      .sort({ createdAt: 1 })
      .lean()

    const messages: MessageReport[] = []
    for (const message of agentMessages) {
      try {
        let bodyObj
        const timeInterval = agent.triggers.periodic.timerPeriod
        if (typeof message.body === 'string') {
          bodyObj = {
            value: message.body,
            timestamp: { start: new Date(message.createdAt!.getTime() - timeInterval * 1000), end: message.createdAt }
          }
        } else {
          bodyObj = {
            ...message.body
          }
          if (!message.body.timestamp) {
            bodyObj.timestamp = {
              start: new Date(message.createdAt!.getTime() - timeInterval * 1000),
              end: message.createdAt
            }
          }
        }
        startTime = new Date(bodyObj.timestamp.start)
        // Account for microsecond differences between start and stop interval
        if (Math.floor(startTime.getTime() / 1000) !== Math.floor(endTime?.getTime() / 1000)) {
          const createdAtQuery = endTime
            ? {
                $gte: endTime,
                $lte: startTime
              }
            : {
                $lte: startTime
              }
          const comments = await findComments(createdAtQuery, conversationId)
          messages.push({
            timestamp: { start: endTime, end: startTime },
            comments,
            hasResponses: false
          })
        }
        endTime = new Date(bodyObj.timestamp.end)

        const createdAtQuery = {
          $gte: startTime,
          $lte: endTime
        }

        const comments = await findComments(createdAtQuery, conversationId)
        const { timestamp, ...responseBody } = bodyObj

        messages.push({ timestamp, comments, responses: responseBody, hasResponses: true })
      } catch (parseError) {
        logger.error(`Error parsing message ${message._id}: ${parseError.message}`)
      }
    }

    // Grab anything after the last agent response
    if (endTime) {
      const comments = await findComments(
        {
          $gte: endTime
        },
        conversationId
      )
      messages.push({
        timestamp: { start: endTime },
        comments,
        hasResponses: false
      })
    }
    if (messages.length > 0) {
      agents.push({ name: agent.name, messages })
    }
  }
  const allComments = agents.flatMap((agent) => agent.messages.flatMap((message) => message.comments || []))
  return {
    ...(metadata && { experiment: { ...metadata, _id: conversation._id } }),
    agents,
    resultConversation: conversation._id.toString(),
    baseConversation: metadata?.baseConversationId || conversation._id.toString(),
    participantCount: new Set(allComments.map((comment) => (comment as { user: string }).user)).size
  }
}

async function generateReport(
  conversation: IConversation,
  reportName: string,
  format = 'text',
  timezone = 'UTC',
  additionalChannels: string[] = [],
  agentType?: string,
  metadata?: ReportMetadata
): Promise<string> {
  // Generate report data based on report name
  let reportData
  switch (reportName) {
    case 'periodicResponses':
      reportData = await generatePeriodicAgentsData(conversation, metadata)
      break
    case 'directMessageResponses':
      reportData = await generateDirectMessageAgentsData(conversation, metadata, additionalChannels)
      break
    case 'userMetrics': {
      if (!agentType) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Agent type is required for userMetrics report')
      }
      reportData = await generateUserMetricsData(conversation, agentType, metadata, additionalChannels)
      break
    }
    default:
      throw new ApiError(httpStatus.BAD_REQUEST, `Unknown report name: ${reportName}`)
  }

  // Load and compile template
  const templatePath = path.resolve(`report_templates/${reportName}.${format}.hbs`)
  let templateContent

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    templateContent = await fs.readFile(templatePath, 'utf8')
  } catch {
    throw new ApiError(httpStatus.NOT_FOUND, `Template not found: ${reportName}.${format}.hbs`)
  }

  const template = handlebars.compile(templateContent)

  // Register helpers for formatting
  handlebars.registerHelper('formatTime', (timestamp) => {
    if (!timestamp) return 'No timestamp'
    return new Date(timestamp).toLocaleTimeString('en-US', { timeZone: timezone })
  })

  handlebars.registerHelper('formatDate', (timestamp) => {
    if (!timestamp) return 'No date'
    return new Date(timestamp).toLocaleString('en-US', { timeZone: timezone })
  })
  handlebars.registerHelper('eq', (a, b) => a === b)

  handlebars.registerHelper('formatObject', (obj) => {
    const jsonStr = JSON.stringify(obj, null, 2)
      // eslint-disable-next-line no-useless-escape
      .replace(/[{}"\[\]]/g, '') // Remove brackets and quotes
      .replace(/,\s*$/gm, '') // Remove trailing commas
      .replace(/^\s*$/gm, '') // Remove empty lines

    // Split into lines and process each line
    const lines = jsonStr.split('\n')
    const processedLines = lines.map((line) => {
      // Match lines that have a key followed by colon
      const match = line.match(/^(\s*)([a-z_]+):\s*(.*)$/)
      if (match) {
        const [, indent, key, restOfLine] = match
        // Capitalize first letter and replace underscores with spaces
        const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ')
        // If there's content after the colon on the same line, add a space
        if (restOfLine && restOfLine.trim() !== '') {
          return `${indent}${capitalizedKey}: ${restOfLine}`
        }
        // If the line ends with just the colon, no space
        return `${indent}${capitalizedKey}:`
      }
      return line
    })
    return processedLines.join('\n')
  })

  handlebars.registerHelper('formatMessagesCSV', (aggregateMetrics) => {
    const directMessagesPerUser = (aggregateMetrics.directMessagesPerUser || {}) as Record<string, number>
    const additionalChannelMessagesPerUser = (aggregateMetrics.additionalChannelMessagesPerUser || {}) as Record<
      string,
      Record<string, number>
    >

    // Get all unique pseudonyms from all sources and sort alphabetically
    const pseudonyms = Array.from(
      new Set([
        ...Object.keys(directMessagesPerUser),
        ...Object.values(additionalChannelMessagesPerUser).flatMap((channelData) => Object.keys(channelData))
      ])
    ).sort()

    // Get channel names sorted
    const channelNames = Object.keys(additionalChannelMessagesPerUser).sort()

    // Build headers: Pseudonym, Direct Messages, [Additional channels]
    const headers = ['Pseudonym', 'Direct Messages', ...channelNames]
    const rows = [headers.join(',')]

    // Build data rows
    for (const pseudonym of pseudonyms) {
      const rowValues: (string | number)[] = [pseudonym]

      // Add direct message count
      const directCount = directMessagesPerUser[pseudonym] ?? ''
      rowValues.push(directCount)

      // Add additional channel counts
      const channelCounts = channelNames.map(
        (channelName) => additionalChannelMessagesPerUser[channelName]?.[pseudonym] ?? ''
      )
      rowValues.push(...channelCounts)

      rows.push(rowValues.join(','))
    }

    return rows.join('\n')
  })

  handlebars.registerHelper('fallback', (value, fallback) => value || fallback)

  handlebars.registerHelper('formatFeedbackCSV', (feedbackRatings) => {
    if (!feedbackRatings || Object.keys(feedbackRatings).length === 0) {
      return ''
    }

    // Get rating types sorted
    const ratingTypes = Object.keys(feedbackRatings).sort()
    const rows: string[] = []

    for (const ratingType of ratingTypes) {
      rows.push(`${ratingType},${feedbackRatings[ratingType]}`)
    }

    return rows.join('\n')
  })

  return template(reportData)
}

const reportService = {
  generateReport,
  generateUserMetricsData,
  generateDirectMessageAgentsData,
  generatePeriodicAgentsData
}

export default reportService
