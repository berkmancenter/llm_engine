import { Agenda } from 'agenda'
import config from '../config/config.js'
import logger from '../config/logger.js'

const agenda = new Agenda({ db: { address: config.mongoose.url } })
agenda.on('fail', (err, job) => {
  logger.error(`[AGENDA] Job ${job.attrs.name} failed:`, err)
})
agenda.on('error', (error) => {
  logger.error('[AGENDA] Global error:', error)
})
export default agenda
