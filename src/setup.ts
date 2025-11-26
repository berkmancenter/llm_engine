import config from './config/config.js'
import { startJobs } from './jobs/startup.js'
import agentService from './services/agent.service/index.js'

export default async () => {
  await agentService.initializeAgents()
  if (config.env !== 'test') {
    await startJobs()
  }
}
