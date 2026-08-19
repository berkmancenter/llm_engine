import PQueue from 'p-queue'
import logger from '../../config/logger.js'
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
/* Boot-time wrapper around initialize(). initialize() deliberately rethrows unexpected
   errors for its runtime callers (createAgent/startAgent), where the caller can surface a
   failure to the request that caused it. At boot there is no such caller: the only
   listener is the process-level unhandledRejection handler, which exits. Containing the
   error here keeps a single unschedulable agent from taking the whole instance down while
   still making the failure visible in logs. */
async function initializeForBoot(agent) {
  try {
    await initialize(agent)
  } catch (err) {
    logger.error(`Agent ${agent?._id} failed to initialize at boot; continuing`, err)
  }
}

async function initializeAgents() {
  // stop to clear locks
  await agenda.stop()
  const queue = new PQueue({ concurrency: MAX_CONCURRENCY })
  /* Only the fields initialize() actually reads, as lean plain objects rather than
     hydrated Mongoose documents. This runs over every agent document in the database on
     every boot, so the per-document cost is paid once per instance per scale-out event -
     and under autoscaling that is no longer a once-a-deploy cost. Nothing below calls a
     document method, so there is nothing to lose by not hydrating. */
  const cursor = Agent.find({}, '_id agentType active triggers').lean().cursor()
  let count = 0

  for (let agent = await cursor.next(); agent; agent = await cursor.next()) {
    /* RETURN the promise. Without it PQueue sees a synchronous task that completes
       immediately, which broke three things at once: MAX_CONCURRENCY was never actually
       applied (every agent initialised in parallel, unbounded), onEmpty() resolved before
       any real work had finished (hence the sleep(1000) that used to stand in for
       waiting), and a rejection from initialize() surfaced as an unhandled rejection -
       which index.ts turns into process.exit(1), so one bad agent could kill an instance
       during boot. */
    queue.add(() => initializeForBoot(agent)).catch((err) => logger.error(err))
    count++
  }

  // onIdle, not onEmpty: empty means every task has *started*, idle means they have finished.
  await queue.onIdle()
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
