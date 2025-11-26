import mongoose from 'mongoose'
import app from './app.js'
import config from './config/config.js'
import logger from './config/logger.js'
import setup from './setup.js'

logger.info(`Environment: ${config.env} -> Reading config from file: ${config.envFile}`)

let server
// set mongoose strict model
mongoose.set('strict', true)
if (config.mongoose.debug !== undefined) mongoose.set('debug', config.mongoose.debug)
mongoose.connect(config.mongoose.url, config.mongoose.options).then(() => {
  logger.info('Connected to MongoDB')
  setup().then(() => {
    server = app.listen(config.port, () => {
      logger.info(`Listening to port ${config.port}`)
    })
  })
})
const exitHandler = () => {
  if (server) {
    server.close(() => {
      logger.info('Server closed')
      process.exit(1)
    })
  } else {
    process.exit(1)
  }
}
const unexpectedErrorHandler = (error) => {
  logger.error(error)
  exitHandler()
}
process.on('uncaughtException', unexpectedErrorHandler)
process.on('unhandledRejection', unexpectedErrorHandler)
process.on('SIGTERM', () => {
  logger.info('SIGTERM received')
  if (server) {
    server.close()
  }
})
