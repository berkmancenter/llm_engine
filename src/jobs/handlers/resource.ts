import logger from '../../config/logger.js'
import resourceService from '../../services/resource.service.js'

const summarizePdf = async (job) => {
  const { conversationId, resourceId, filePath, citation } = job.attrs.data
  try {
    await resourceService.summarizePdf(conversationId, resourceId, filePath, citation)
  } catch (err) {
    logger.error(`resource handler: failed to summarize PDF for resource ${resourceId}`, err)
  }
}

export default { summarizePdf }
