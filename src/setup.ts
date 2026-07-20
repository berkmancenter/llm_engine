import config from './config/config.js'
import { startJobs } from './jobs/startup.js'
import agentService from './services/agent.service/index.js'
import userService from './services/user.service.js'

export default async () => {
  await agentService.initializeAgents()
  await userService.ensureSystemUsers()
  if (config.env !== 'test') {
    await startJobs()
  }
}
