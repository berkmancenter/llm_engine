import PQueue from 'p-queue'
import logger from '../../config/logger.js'
import agenda from '../../jobs/index.js'
import Agent from '../../models/user.model/agent.model/index.js'
import schedule from '../../jobs/schedule.js'
import defineJob from '../../jobs/define.js'

const MAX_CONCURRENCY = 20
// initialize all agent to set up their timers as needed

/* Boot vs. reschedule.
   ---------------------
   These job documents live in MongoDB and are shared by every autoscaled instance, so
   "set up this agent's timer" means two different things depending on who is asking:

   - A RESCHEDULE (patchAgent, startAgent, a newly created agent) genuinely wants the old
     schedule gone and a new one in its place. That is `reschedule: true`, the default.

   - A BOOT (initializeAgents, on every instance, on every scale-out) does not. If the
     cluster already has a live instance, the schedule is already in Mongo and is already
     being processed. Recreating it there is not a harmless no-op:

       * agenda.every() upserts on {name, type:'single'}, and save-job.js only protects
         nextRunAt via $setOnInsert when it is in the PAST. Both callers below pass
         skipImmediate, so nextRunAt is always in the future - which means the upsert
         overwrites it and pushes the agent's next run out by a full interval. Every
         boot. If instances boot more often than an agent's interval (a 1->5 scale-out
         boots four in ~70s; a rolling deploy walks the whole group) that agent is
         starved for as long as the churn lasts - exactly when load is highest and
         proactive agents matter most.
       * The cancel that used to run first is redundant for de-duplication, because
         every() is already an upsert keyed by name. All it added was a window in which
         the job did not exist - a tick landing there is lost - and the chance of
         deleting a job another instance was mid-run on.
       * It is also 2 writes per agent per boot per instance, landing at the same moment
         new instances are doing everything else they do at startup.

   So on the boot path we still define the handler (in-memory, per-process, genuinely
   required on every instance) and only touch Mongo if no schedule exists yet - which is
   the real recovery case this code was written for: the whole cluster having been down.

   POSSIBLE FUTURE WORK - leader election. The cleanest version of this is for exactly
   one instance to own scheduling, via a lock in Mongo, so schedule creation is not
   racy-by-construction across a scaling group at all. Not done here because it is
   materially more machinery (lock acquisition, renewal, handover when the leader is
   scaled down or replaced mid-deploy) and the split below removes the harm without it.
   Worth revisiting if scheduling ever needs to do more than create-if-absent, or if
   agents start being rescheduled frequently enough that "who owns this" matters. */
async function schedulePeriodicAgent(agent, { reschedule = true } = {}) {
  if (reschedule) {
    // Genuine reschedule: the interval may have changed, so the old job must go.
    await schedule.cancelPeriodicAgent(agent._id)
  }
  // Always: in-memory handler registration, required on every instance.
  await defineJob.periodicAgent()
  if (reschedule || !(await schedule.periodicAgentExists(agent._id))) {
    await schedule.periodicAgent(`${agent.triggers.periodic.timerPeriod} seconds`, { agentId: agent._id })
    logger.debug(`Set timer for ${agent.agentType} ${agent._id} ${agent.triggers.periodic.timerPeriod} seconds`)
  } else {
    logger.debug(`Timer already scheduled for ${agent.agentType} ${agent._id}; left as-is`)
  }
}

async function scheduleCronAgent(agent, { reschedule = true } = {}) {
  if (reschedule) {
    await schedule.cancelCronAgent(agent._id)
  }
  await defineJob.cronAgent()
  if (reschedule || !(await schedule.cronAgentExists(agent._id))) {
    await schedule.cronAgent(agent.triggers.cron.expression, { agentId: agent._id })
    logger.debug(`Set cron for ${agent.agentType} ${agent._id} "${agent.triggers.cron.expression}"`)
  } else {
    logger.debug(`Cron already scheduled for ${agent.agentType} ${agent._id}; left as-is`)
  }
}
async function initialize(agent, { reschedule = true } = {}) {
  try {
    if (!agent.triggers || agent.triggers?.perMessage) {
      // Define the job used to retrieve response async during per-message or manual activation
      await defineJob.agentResponse()
    }
    if (agent.active && agent.triggers?.periodic) {
      await schedulePeriodicAgent(agent, { reschedule })
    }
    if (agent.active && agent.triggers?.cron) {
      await scheduleCronAgent(agent, { reschedule })
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
    // reschedule: false - see the "Boot vs. reschedule" note above.
    await initialize(agent, { reschedule: false })
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
