import mongoose from 'mongoose'
import httpStatus from 'http-status'
import Experiment from '../models/experiment.model/experiment.js'
import { Agent, Message, Conversation, Topic } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import logger from '../config/logger.js'
import transcript from '../agents/helpers/transcript.js'
import { duplicateConversationMessages } from './message.service.js'
import reportService from './report.service.js'

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
