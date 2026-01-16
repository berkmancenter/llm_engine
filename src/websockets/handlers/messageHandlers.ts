import { messageService } from '../../services/index.js'
import WebsocketError from '../../utils/WebsocketError.js'
import { checkAuth } from '../utils.js'
import logger from '../../config/logger.js'

export default (io, socket) => {
  const createMessage = async (data) => {
    if (!data) {
      logger.error('No request data.')
      return
    }
    try {
      await messageService.newMessageHandler(data.message, data.user, data.request)
    } catch (err) {
      logger.error('Error creating message', err)
      // send error back to user
      io.in(data.userId).emit('error', {
        error: 'message:create',
        message: err.message,
        request: data.request,
        statusCode: err.statusCode
      })
    }
  }

  socket.use(([event, args], next) => {
    logger.debug('Checking auth (JWT) for message/conversation socket requests.')
    checkAuth(event, args, next)
  })
  socket.on('error', (err) => {
    if (err instanceof WebsocketError) {
      const { data, originalError } = err
      if (!data) {
        logger.error('No error data.')
        return
      }
      logger.info('Socket error - request: %s, user: %s, error: %s', data.request, data.userId, originalError.message)
      io.in(data.userId).emit('error', { error: originalError.message, request: data.request })
    } else {
      logger.error('Socket error', err)
    }
  })
  socket.on('message:create', createMessage)
  socket.on('conversation:disconnect', () => {
    logger.info('Socket disconnecting from conversation.')
    socket.disconnect(true)
  })
  socket.on('disconnect', () => {})

  // FOR DEBUGGING
  // socket.onAny((event, ...args) => {
  //   logger.debug(`DEBUG: Received event '${event}' with payload: ${JSON.stringify(args, null, 2)}`)
  // })
}
