import config from '../config/config.js'
import logger from '../config/logger.js'
import defineJob from './define.js'
import schedule from './schedule.js'

export async function startJobs() {
  if (config.env !== 'test') {
    logger.info('Started daily jobs')
    await defineJob.cleanUpTopics()
    await schedule.cleanUpTopics()
    await defineJob.cleanUpTranscripts()
    await schedule.cleanUpTranscripts()
  }
}

export default { startJobs }
