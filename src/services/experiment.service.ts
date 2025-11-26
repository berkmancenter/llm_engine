import mongoose from 'mongoose'
import httpStatus from 'http-status'
import fs from 'fs/promises'
import path from 'path'
import handlebars from 'handlebars'
import Experiment from '../models/experiment.model/experiment.js'
import { Agent, Message, Conversation, Topic, Channel } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import logger from '../config/logger.js'
import transcript from '../agents/helpers/transcript.js'
import { duplicateConversationMessages } from './message.service.js'

interface CommentReport {
  user: string
  text: string
  timestamp?: Date
  fromAgent?: boolean
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

interface DirectMessageAgentReport {
  name: string
  messages: DirectMessageReport[]
  participantCount: number
  minEngagements: number
  maxEngagements: number
  avgEngagements: number
  userCount: number
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
    const text: string = m.bodyType === 'json' ? ((m.body as Record<string, unknown>).text as string) : (m.body as string)
    return {
      user: m.pseudonym,
      text,
      timestamp: m.createdAt
    }
  })
  return comments
}

async function generateDirectMessageAgentsData(experiment) {
  await experiment.populate('resultConversation')
  await experiment.resultConversation.populate('agents')

  const agents: DirectMessageAgentReport[] = []

  for (const agent of experiment.resultConversation.agents) {
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
        conversation: experiment.resultConversation._id
      }).sort({ createdAt: 1 })

      const comments: CommentReport[] = directMessages.map((msg) => ({
        user: msg.pseudonym,
        text: msg.body as string,
        timestamp: msg.createdAt,
        fromAgent: msg.fromAgent
      }))
      // Only include interactions where a human sent at least one message
      const humanMessages = directMessages.filter((msg) => !msg.fromAgent)
      if (humanMessages.length > 0) {
        messages.push({ username: humanMessages[0].pseudonym, comments, userMsgCount: humanMessages.length })
      }
    }
    if (messages.length > 0) {
      const userMsgCounts = messages.map((msg) => msg.userMsgCount)
      agents.push({
        name: agent.name,
        messages,
        participantCount: messages.length,
        userCount: totalUsers,
        minEngagements: Math.min(...userMsgCounts),
        maxEngagements: Math.max(...userMsgCounts),
        avgEngagements: userMsgCounts.reduce((acc, count) => acc + count, 0) / userMsgCounts.length
      })
    }
  }

  return {
    experiment: experiment.toObject(),
    resultConversation: experiment.resultConversation._id.toString(),
    baseConversation: experiment.baseConversation._id.toString(),
    agents
  }
}

async function generatePeriodicAgentsData(experiment) {
  await experiment.populate({
    path: 'resultConversation',
    populate: {
      path: 'agents'
    }
  })

  const conversationId = experiment.resultConversation._id
  const agents: PeriodicAgentReport[] = []
  for (const agent of experiment.resultConversation.agents) {
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
    experiment: experiment.toObject(),
    agents,
    resultConversation: experiment.resultConversation._id.toString(),
    baseConversation: experiment.baseConversation._id.toString(),
    participantCount: new Set(allComments.map((comment) => (comment as { user: string }).user)).size
  }
}

async function getAgentResponse(agent, experiment, endTime, msg?) {
  // simulate conversation history at a point in time by setting endTime
  agent.deepPatch({ conversationHistorySettings: { endTime } })
  // TODO deepPatch seems to be unpopulating the conversation. Expected?
  await agent.populate('conversation')
  await agent.conversation.populate(['messages', 'channels'])
  const responses = await agent.respond(msg)
  for (const response of responses) {
    response.channels = response.channels?.map((c) => c.name)
    response.createdAt = new Date(endTime.getTime() + 1000) // simulate agent message one second after end time
    const responseMsg = await Message.create(response)
    experiment.resultConversation.messages.push(responseMsg)
  }
}

async function runPeriodicExperiment(agent, experiment, simulatedStartTime?) {
  const msgStartTime = new Date(Math.min(...experiment.resultConversation.messages.map((msg) => msg.createdAt.getTime())))
  const msgEndTime = new Date(Math.max(...experiment.resultConversation.messages.map((msg) => msg.createdAt.getTime())))

  const timeInterval = agent.triggers.periodic.timerPeriod
  const endTime = new Date(msgEndTime.getTime() + timeInterval * 1000)
  const startTime = simulatedStartTime ?? msgStartTime
  let currentTime = new Date(startTime.getTime() + timeInterval * 1000)

  // simulate running agent at normal periodic interval, ensuring first and last messages are captured
  while (currentTime <= endTime) {
    await getAgentResponse(agent, experiment, currentTime)
    // Add minutes for the next interval
    currentTime = new Date(currentTime.getTime() + timeInterval * 1000)
  }
}

async function runPerMessageExperiment(agent, experiment) {
  if (agent.useTranscriptRAGCollection) {
    await transcript.loadEventMetadataIntoVectorStore(experiment.resultConversation)
    const transcriptMsgs = experiment.resultConversation.messages.filter((message) =>
      message.channels.some((channel) => channel === 'transcript')
    )
    await transcript.loadTranscriptIntoVectorStore(transcriptMsgs, experiment.resultConversation._id)
  }
  let filteredMessages = experiment.resultConversation.messages

  if (agent.triggers.perMessage.directMessages || agent.triggers.perMessage.channels) {
    const channels = agent.triggers.perMessage.channels || []
    if (agent.triggers.perMessage.directMessages) {
      const directChannels = experiment.resultConversation.channels
        .filter((channel) => channel.direct)
        .map((channel) => channel.name)
      channels.push(...directChannels)
    }
    filteredMessages = filteredMessages.filter((message) => message.channels?.some((channel) => channels.includes(channel)))
  }
  for (const message of filteredMessages) {
    // simulate conversation history and transcript at time message was received
    await getAgentResponse(agent, experiment, message.createdAt, message)
  }
}

const runExperiment = async (experimentId) => {
  // TODO user validation - can anyone run or just experiment owner?
  const experiment = await Experiment.findOne({ _id: new mongoose.Types.ObjectId(experimentId) }).populate({
    path: 'resultConversation',
    populate: [
      {
        path: 'messages'
      },
      {
        path: 'channels'
      }
    ]
  })
  if (!experiment) throw new ApiError(httpStatus.NOT_FOUND, 'Experiment not found')
  if (experiment.status === 'completed') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Experiment has already run')
  }
  if (!experiment.resultConversation) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Experiment does not have a result conversation')
  }

  experiment.executedAt = new Date(Date.now())
  experiment.status = 'running'
  await experiment.save()
  try {
    if (experiment.agentModifications) {
      for (const agentMod of experiment.agentModifications) {
        const agent = await Agent.findOne({ _id: agentMod.agent._id })
        if (!agent) {
          logger.warn(`Could not find agent ${agentMod.agent._id}. Skipping experiment for this agent.`)
          continue
        }
        agent.conversation = experiment.resultConversation
        if (agentMod.experimentValues) {
          // temp modify the agent by deep patching without saving
          agent.deepPatch(agentMod.experimentValues)
        }
        if (agent.triggers?.periodic) {
          await runPeriodicExperiment(agent, experiment, agentMod.simulatedStartTime)
        } else if (agent.triggers?.perMessage) {
          await runPerMessageExperiment(agent, experiment)
        } else {
          logger.error('Experiments with manual agents are not currently supported')
          continue
        }
        if (!agent.active) {
          await agent.start()
        }
      }
    }
    experiment.status = 'completed'
    await experiment.save()
    return experiment
  } catch (err) {
    experiment.status = 'failed'
    await experiment.save()
    throw err
  }
}

const createExperiment = async (experimentBody, user) => {
  if (experimentBody.executedAt && experimentBody.agentModifications) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Cannot provide agent modifications for past experiment`)
  }
  const baseConversation = await Conversation.findOne({ _id: new mongoose.Types.ObjectId(experimentBody.baseConversation) })
    .populate('agents')
    .exec()

  if (!baseConversation) throw new ApiError(httpStatus.BAD_REQUEST, 'Base conversation not found')

  // Make sure all agents involved in the experiment are valid
  for (const agentMod of experimentBody.agentModifications || []) {
    const agent = baseConversation.agents.find((a) => a._id!.toString() === agentMod.agent)
    if (!agent) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Agent ${agentMod.agent} not found in base conversation`)
    }
    agentMod.agent = agent
  }

  let resultConversation
  if (experimentBody.agentModifications) {
    // clone base conversation into a new conversation that can be used for simulation
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, createdAt, updatedAt, ...resultConversationData } = baseConversation.toObject()

    resultConversationData.experimental = true
    resultConversation = new Conversation(resultConversationData)
    await resultConversation.save()
    const topic = await Topic.findById(resultConversation.topic)
    topic!.conversations.push(resultConversation.toObject())
    await topic!.save()

    // refresh messages - delete and re-duplicate
    await Message.deleteMany({ conversation: resultConversation._id })
    // TODO only remove the messages from agents we are experimenting with?
    await duplicateConversationMessages(baseConversation._id, resultConversation._id, { fromAgent: false })
    await resultConversation.populate('messages')
    await resultConversation.save()
  }

  const experiment = await Experiment.create({
    name: experimentBody.name,
    description: experimentBody.description,
    baseConversation,
    createdBy: user,
    ...(resultConversation !== undefined && { resultConversation, agentModifications: experimentBody.agentModifications }),
    ...(experimentBody.executedAt !== undefined && {
      executedAt: experimentBody.executedAt,
      status: 'completed',
      resultConversation: baseConversation
    })
  })
  baseConversation.experiments.push(experiment)
  await baseConversation.save()

  experiment.createdBy = user._id
  return experiment
}

const getExperiment = async (id) => {
  const experiment = await Experiment.findOne({ _id: id }).populate('resultConversation').populate('baseConversation').exec()
  if (!experiment) throw new ApiError(httpStatus.NOT_FOUND, 'Experiment not found')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, ...experimentPojo } = experiment.toObject()

  return experimentPojo
}

const generateExperimentReport = async (experimentId, reportName, format = 'text') => {
  const experiment = await Experiment.findOne({ _id: experimentId })
  if (!experiment) throw new ApiError(httpStatus.NOT_FOUND, 'Experiment not found')

  // Generate report data based on report name
  let reportData
  switch (reportName) {
    case 'periodicResponses':
      reportData = await generatePeriodicAgentsData(experiment)
      break
    case 'directMessageResponses':
      reportData = await generateDirectMessageAgentsData(experiment)
      break
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
    return new Date(timestamp).toLocaleTimeString()
  })

  handlebars.registerHelper('formatDate', (timestamp) => {
    if (!timestamp) return 'No date'
    return new Date(timestamp).toLocaleString()
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

  return template(reportData)
}

const experimentService = {
  createExperiment,
  runExperiment,
  getExperiment,
  generateExperimentReport
}
export default experimentService
