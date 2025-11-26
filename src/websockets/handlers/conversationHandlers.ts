import catchAsync from '../../utils/catchAsync.js'
import { checkAuth } from '../utils.js'
import logger from '../../config/logger.js'

export default (io, socket) => {
  const joinUser = catchAsync(async (data) => {
    logger.debug('Joining user via socket. UserId = %s', data.user._id)
    socket.join(data.userId.toString())
  })
  const joinTopic = catchAsync(async (data) => {
    logger.debug('Joining topic via socket. TopicId = %s', data.topicId)
    socket.join(data.topicId.toString())
  })
  socket.use(([event, args], next) => {
    logger.debug('Checking auth (JWT) for topic socket requests.')
    checkAuth(event, args, next)
  })
  socket.on('user:join', joinUser)
  socket.on('topic:join', joinTopic)
  socket.on('topic:disconnect', () => {
    logger.info('Socket disconnecting from topic.')
    socket.disconnect(true)
  })
}
