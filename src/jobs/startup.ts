import config from '../config/config.js'
import logger from '../config/logger.js'
import agenda from './index.js'
import defineJob from './define.js'
import schedule from './schedule.js'

export async function startJobs() {
  if (config.env !== 'test') {
    logger.info('Started daily jobs')
    // Start the processing loop once, here, rather than redundantly inside every defineJob.*
    // call (define() can be called before or after start() — Agenda looks up the handler by
    // name only when a job of that name is actually due to run).
    await agenda.start()
    await defineJob.cleanUpTopics()
    await schedule.cleanUpTopics()
    await defineJob.cleanUpTranscripts()
    await schedule.cleanUpTranscripts()
    await defineJob.autoStartConversation()
    await defineJob.conversationEndingSoon()
    await defineJob.summarizePdf()
    await defineJob.conversationEvent()
    await defineJob.conversationCost()
    await defineJob.pollExpired()
  }
}

export default { startJobs }
