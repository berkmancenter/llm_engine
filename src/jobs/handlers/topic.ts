import config from '../../config/config.js'
import logger from '../../config/logger.js'
import topicService from '../../services/topic.service.js'

const cleanUpTopics = async () => {
  try {
    if (config.enableAutoDeletion) {
      // Delete old topics job
      logger.info(`Started delete old topics job.`)
      const deleteResult = await topicService.deleteOldTopics()
      if (deleteResult.length > 0) {
        logger.info(
          `Successfully deleted ${deleteResult.length} old topics. Topic ids: ${deleteResult.map((x) => x._id).join()}`
        )
      } else {
        logger.info(`Did not find any old topics to delete.`)
      }
      logger.info(`Ended delete old topics job.`)

      // Archive topics job
      logger.info(`Started email users to archive job.`)
      const emailResult = await topicService.emailUsersToArchive()
      if (emailResult.length > 0) {
        logger.info(
          `Successfully deleted ${emailResult.length} old topics. Topic ids: ${emailResult.map((x) => x._id).join()}`
        )
      } else {
        logger.info(`Did not find any users to notify for archiving.`)
      }
      logger.info(`Ended email users to archive job.`)
    } else {
      logger.info(`Auto-deletion is disabled. Skipping old topics deletion and archive jobs.`)
    }
  } catch (err) {
    logger.error('Error occurred cleaning up inactive topics', err)
  }
}
const topicHandlers = {
  cleanUpTopics
}
export default topicHandlers
