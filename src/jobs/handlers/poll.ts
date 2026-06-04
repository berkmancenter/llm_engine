import logger from '../../config/logger.js'
import websocketGateway from '../../websockets/websocketGateway.js'

const pollExpired = async (job) => {
  const { pollId, conversationId } = job.attrs.data
  logger.debug(`Poll expired: ${pollId}`)
  await websocketGateway.broadcastPollExpired(conversationId, pollId)
}

const pollHandlers = { pollExpired }
export default pollHandlers
