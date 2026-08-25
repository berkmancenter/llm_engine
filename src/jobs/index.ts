import { Agenda } from 'agenda'
import config from '../config/config.js'
import logger from '../config/logger.js'

/* These are library defaults, made explicit rather than inherited silently: multiple
   autoscaled instances now poll and process from the same `agendaJobs` collection, so it's
   worth being deliberate about how much concurrent job-processing capacity that adds per
   instance. Revisit with real multi-instance job-volume data (same spirit as the
   infra autoscaler's own placeholder thresholds in infra/modules/webserver-mig). */
const agenda = new Agenda({
  db: { address: config.mongoose.url },
  processEvery: '10 seconds',
  maxConcurrency: 20,
  defaultConcurrency: 5
})
agenda.on('fail', (err, job) => {
  logger.error(`[AGENDA] Job ${job.attrs.name} failed:`, err)
})
agenda.on('error', (error) => {
  logger.error('[AGENDA] Global error:', error)
})
export default agenda
