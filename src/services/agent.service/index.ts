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

async function scheduleCronAgent(agent) {
  await schedule.cancelCronAgent(agent._id)
  await defineJob.cronAgent(agent._id)
  await schedule.cronAgent(agent.triggers.cron.expression, { agentId: agent._id })
  logger.debug(`Set cron for ${agent.agentType} ${agent._id} "${agent.triggers.cron.expression}"`)
}
async function initialize(agent) {
  try {
    if (!agent.triggers || agent.triggers?.perMessage) {
      // Define the job used to retrieve response async during per-message or manual activation
      await defineJob.agentResponse(agent._id)
    }
    if (agent.active && agent.triggers?.periodic) {
      await schedulePeriodicAgent(agent)
    }
    if (agent.active && agent.triggers?.cron) {
      await scheduleCronAgent(agent)
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
  if (agent.active && agent.triggers?.cron) {
    await scheduleCronAgent(agent)
  }
}

async function startAgent(agent) {
  logger.debug(`Agent service start: ${agent._id}`)
  await agent.start()
  if (agent.triggers?.periodic) {
    await schedulePeriodicAgent(agent)
  } else if (agent.triggers?.cron) {
    await scheduleCronAgent(agent)
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
  if (agent.triggers?.cron) {
    await schedule.cancelCronAgent(agent._id)
  }
}

const agentService = { initializeAgents, createAgent, patchAgent, startAgent, stopAgent }
export default agentService
