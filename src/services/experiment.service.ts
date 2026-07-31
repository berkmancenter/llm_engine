import mongoose from 'mongoose'
import httpStatus from 'http-status'
import Experiment from '../models/experiment.model/experiment.js'
import { Agent, Message, Conversation, Topic } from '../models/index.js'
import { ConversationDocument } from '../models/conversation.model.js'
import { AgentDocument } from '../models/user.model/agent.model/index.js'
import ApiError from '../utils/ApiError.js'
import logger from '../config/logger.js'
import transcript from '../agents/helpers/transcript.js'
import { duplicateConversationMessages, agentResponseToMessageData } from './message.service.js'
import reportService from './report.service.js'

async function getAgentResponse(agent, experiment, endTime, msg?) {
  // Patch endTime into whichever conversationHistorySettings path respond() will actually read.
  // respond() prefers triggers.periodic.conversationHistorySettings over the top-level
  // conversationHistorySettings for periodic agents, so we must patch both paths.
  if (agent.triggers?.periodic) {
    agent.deepPatch({ triggers: { periodic: { conversationHistorySettings: { endTime } } } })
  } else {
    agent.deepPatch({ conversationHistorySettings: { endTime } })
  }
  // TODO deepPatch seems to be unpopulating the conversation. Expected?
  await agent.populate('conversation')
  await agent.conversation.populate(['messages', 'channels'])
  const responses = await agent.respond(msg)
  for (const response of responses) {
    const msgData = agentResponseToMessageData(response, agent)
    const simulatedAt = new Date(endTime.getTime() + 1000)
    const responseMsg = new Message({
      ...msgData,
      channels: msgData.channels?.map((c) => (typeof c === 'string' ? c : c.name)),
      createdAt: simulatedAt,
      updatedAt: simulatedAt
    })
    await responseMsg.save({ timestamps: false })
    experiment.resultConversation.messages.push(responseMsg)
  }
  if (responses.length > 0) {
    await experiment.resultConversation.save()
  }
}

async function runPeriodicExperiment(agent, experiment) {
  // Seed RAG for the result conversation so transcript search works against its collection.
  // The result conversation has a different _id than the base, so we must re-embed here.
  await transcript.loadEventMetadataIntoVectorStore(experiment.resultConversation)
  const transcriptMsgs = experiment.resultConversation.messages.filter((message) =>
    message.channels.some((channel) => channel === 'transcript')
  )
  if (transcriptMsgs.length > 0) {
    await transcript.loadTranscriptIntoVectorStore(transcriptMsgs, experiment.resultConversation._id)
  }

  // Use only original (non-agent) messages to calculate the window. Agent responses added
  // during simulation of earlier agents must not stretch the window for later agents.
  const baseMsgs = experiment.resultConversation.messages.filter((msg) => !msg.fromAgent)
  const msgStartTime = new Date(Math.min(...baseMsgs.map((msg) => msg.createdAt.getTime())))
  const msgEndTime = new Date(Math.max(...baseMsgs.map((msg) => msg.createdAt.getTime())))

  // Align the conversation's startTime with the earliest message so agents that use
  // conversation.startTime as a rate-limit baseline (e.g. proactiveGroupAgent) behave
  // correctly even when the conversation was restarted after the original messages.
  const resultConv = experiment.resultConversation as ConversationDocument
  if (!resultConv.startTime || resultConv.startTime > msgStartTime) {
    resultConv.startTime = msgStartTime
    await resultConv.save()
  }

  const timeInterval = agent.triggers.periodic.timerPeriod
  const endTime = new Date(msgEndTime.getTime() + timeInterval * 1000)
  const startTime = msgStartTime
  let currentTime = new Date(startTime.getTime() + timeInterval * 1000)

  // simulate running agent at normal periodic interval, ensuring first and last messages are captured
  while (currentTime <= endTime) {
    await getAgentResponse(agent, experiment, currentTime)
    // Add minutes for the next interval
    currentTime = new Date(currentTime.getTime() + timeInterval * 1000)
  }
}

async function runPerMessageExperiment(agent, experiment) {
  await transcript.loadEventMetadataIntoVectorStore(experiment.resultConversation)
  const transcriptMsgs = experiment.resultConversation.messages.filter((message) =>
    message.channels.some((channel) => channel === 'transcript')
  )
  await transcript.loadTranscriptIntoVectorStore(transcriptMsgs, experiment.resultConversation._id)
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

  await (experiment.resultConversation as ConversationDocument).populate('agents')

  experiment.executedAt = new Date(Date.now())
  experiment.status = 'running'
  await experiment.save()
  try {
    const resultConv = experiment.resultConversation as ConversationDocument
    for (const agentDoc of resultConv.agents ?? []) {
      const agent = await Agent.findOne({ _id: agentDoc._id ?? agentDoc })
      if (!agent) {
        logger.warn(`Could not find agent ${agentDoc._id ?? agentDoc}. Skipping.`)
        continue
      }
      if (!agent.active) {
        // Set active in-memory only — do not save, so the periodic job scheduler
        // never picks this experimental agent up for real-world scheduling on server restart.
        agent.active = true
      }
      if (agent.triggers?.periodic) {
        await runPeriodicExperiment(agent, experiment)
      } else if (agent.triggers?.perMessage) {
        await runPerMessageExperiment(agent, experiment)
      } else {
        logger.error('Experiments with manual agents are not currently supported')
        continue
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
  const baseConversation = await Conversation.findOne({ _id: new mongoose.Types.ObjectId(experimentBody.baseConversation) })
    .populate('agents')
    .exec()

  if (!baseConversation) throw new ApiError(httpStatus.BAD_REQUEST, 'Base conversation not found')

  // Resolve agent references for entries that reference existing agents
  const agentOps = experimentBody.agents ?? []
  for (const op of agentOps) {
    if (op.agent) {
      const agent = baseConversation.agents.find((a) => a._id!.toString() === op.agent.toString())
      if (!agent) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Agent ${op.agent} not found in base conversation`)
      }
      op.agent = agent
    }
  }

  let resultConversation
  if (!experimentBody.executedAt) {
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
    await duplicateConversationMessages(baseConversation._id, resultConversation._id, { fromAgent: false })
    await resultConversation.populate('messages')

    // Determine which base agents to clone:
    // if agents array is provided, only clone those referenced; otherwise clone all.
    const existingAgentOps = agentOps.filter((op) => op.agent)
    const opsByAgentId = new Map(existingAgentOps.map((op) => [op.agent._id.toString(), op]))
    const agentsToClone =
      agentOps.length > 0
        ? (baseConversation.agents as unknown as AgentDocument[]).filter((a) => opsByAgentId.has(a._id!.toString()))
        : (baseConversation.agents as unknown as AgentDocument[])

    resultConversation.agents = []
    for (const baseAgent of agentsToClone) {
      const agentObj = baseAgent.toObject() as unknown as Record<string, unknown>
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id: __, createdAt: ___, updatedAt: ____, conversation: _____, active: ______, ...agentFields } = agentObj
      const op = opsByAgentId.get(baseAgent._id!.toString()) as { experimentValues?: Record<string, unknown> } | undefined
      const clone = await Agent.create({
        ...agentFields,
        conversation: resultConversation._id,
        ...(op?.experimentValues ?? {})
      })
      resultConversation.agents.push(clone._id)
    }

    // Create new agents for entries that specify an agentType
    for (const op of agentOps.filter((o) => o.agentType)) {
      const newAgent = await Agent.create({
        agentType: op.agentType,
        conversation: resultConversation._id,
        ...(op.experimentValues ?? {})
      })
      resultConversation.agents.push(newAgent._id)
    }

    await resultConversation.save()
  }

  const experiment = await Experiment.create({
    name: experimentBody.name,
    description: experimentBody.description,
    baseConversation,
    createdBy: user,
    ...(resultConversation !== undefined && { resultConversation, agents: agentOps }),
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

const generateExperimentReport = async (
  experimentId,
  reportName,
  format = 'text',
  timezone = 'UTC',
  additionalChannels: string[] = [],
  agentName?: string
) => {
  const experiment = await Experiment.findOne({ _id: experimentId })
  if (!experiment) throw new ApiError(httpStatus.NOT_FOUND, 'Experiment not found')

  await experiment.populate('resultConversation')

  return reportService.generateReport(
    experiment.resultConversation!,
    reportName,
    format,
    timezone,
    additionalChannels,
    agentName,
    {
      name: experiment.name,
      description: experiment.description,
      executedAt: experiment.executedAt,
      baseConversationId: experiment.baseConversation!._id!.toString()
    }
  )
}

const experimentService = {
  createExperiment,
  runExperiment,
  getExperiment,
  generateExperimentReport
}
export default experimentService
