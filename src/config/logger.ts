import * as Sentry from '@sentry/node'
import winston from 'winston'
import Transport from 'winston-transport'
import config from './config.js'

// Sentry starts here (rather than a dedicated instrument file) so init is guaranteed before the transport below is created
if (config.sentryDsn) {
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.env,
    enableLogs: true
  })
}

const loggerTransports: winston.transport[] = [
  new winston.transports.Console({
    stderrLevels: ['error']
  })
]
if (config.sentryDsn) {
  const SentryWinstonTransport = Sentry.createSentryWinstonTransport(Transport)
  loggerTransports.push(new SentryWinstonTransport({ levels: ['info', 'warn', 'error'] }))
}

const enumerateErrorFormat = winston.format((info) => {
  if (info.message && info[Symbol.for('splat')]) {
    const splat = info[Symbol.for('splat')] as unknown[]
    const [error] = splat || []
    if (error instanceof Error) {
      Object.assign(info, {
        message: `${info.message} \n ${error.stack}${error.cause ? `\nCaused by: ${error.cause}` : ''}`
      })
    }
  } else if (info instanceof Error) {
    Object.assign(info, {
      message: info.stack + (info.cause ? `\nCaused by: ${info.cause}` : '')
    })
  }
  return info
})

const logger = winston.createLogger({
  level: config.logLevel || (config.env === 'development' ? 'debug' : 'info'),
  format: winston.format.combine(
    enumerateErrorFormat(),
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    config.env === 'development' ? winston.format.colorize() : winston.format.uncolorize(),
    winston.format.splat(),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: loggerTransports
})

export default logger
