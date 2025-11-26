import PQueue from 'p-queue'
import logger from '../../config/logger.js'
import sleep from '../../utils/sleep.js'
import agenda from '../../jobs/index.js'
import Agent from '../../models/user.model/agent.model/index.js'
import schedule from '../../jobs/schedule.js'
import defineJob from '../../jobs/define.js'

const MAX_CONCURRENCY = 20
// initialize all agent to set up their timers as needed

async function schedulePeriodicAgent(agent) {
  // cancel in case of multiple start attempts. Should be a no-op if not already running
  await schedule.cancelPeriodicAgent(agent._id)
  await defineJob.periodicAgent(agent._id)
  await schedule.periodicAgent(`${agent.triggers.periodic.timerPeriod} seconds`, { agentId: agent._id })
  logger.debug(`Set timer for ${agent.agentType} ${agent._id} ${agent.triggers.periodic.timerPeriod} seconds`)
}
async function initialize(agent) {
  try {
    await agent.initialize()
    if (!agent.triggers || agent.triggers?.perMessage) {
      // Define the job used to retrieve response async during per-message or manual activation
      await defineJob.agentResponse(agent._id)
    }
    // Define the job used by agent to send introductory messages on channel creation
    await defineJob.agentIntroduction(agent._id)
    if (agent.active && agent.triggers?.periodic) {
      await schedulePeriodicAgent(agent)
    }
  } catch (err) {
    logger.error(err)
    if (!err.message.includes('No such agent')) throw err
  }
}
async function initializeAgents() {
  // stop to clear locks
  await agenda.stop()
  const queue = new PQueue({ concurrency: MAX_CONCURRENCY })
  const cursor = await Agent.find().cursor()
  let count = 0

  for (let agent = await cursor.next(); agent; agent = await cursor.next()) {
    await queue.add(() => {
      initialize(agent)
    })
    count++
  }
  await sleep(1000)
  await queue.onEmpty()
  logger.debug(`Agents initialized: ${count}`)
}

async function introduceAgents(agents, channel) {
  for (const agent of agents) {
    // Only ask agent to introduce itself on a group channel or direct channel on which it participates
    if (!channel.direct || (channel.direct && channel.participants.includes(agent._id))) {
      await schedule.agentIntroduction({ agentId: agent._id, channelId: channel._id })
    }
  }
}

async function createAgent(agentType, conversation, agentProps?) {
  const agent = new Agent({
    agentType,
    conversation
  })
  if (agentProps) agent.deepPatch(agentProps)
  // need to save to get id
  await agent.save()
  await initialize(agent)
  return agent
}

async function patchAgent(agent, agentProps) {
  agent.deepPatch(agentProps)
  await agent.save()
  if (agent.active && agent.triggers?.periodic) {
    await schedulePeriodicAgent(agent)
  }
}

async function startAgent(agent) {
  logger.debug(`Agent service start: ${agent._id}`)
  await agent.start()
  if (agent.triggers?.periodic) {
    // periodic activation
    await schedulePeriodicAgent(agent)
  } else if (!agent.triggers) {
    // activate manual agent
    await schedule.agentResponse({ agentId: agent._id })
  }
}

async function stopAgent(agent) {
  logger.debug(`Agent service stop: ${agent._id}`)
  await agent.stop()
  if (agent.triggers?.periodic) {
    await schedule.cancelPeriodicAgent(agent._id)
  }
}

const agentService = { initializeAgents, introduceAgents, createAgent, patchAgent, startAgent, stopAgent }
export default agentService
