import config from './config/config.js'
import { startJobs } from './jobs/startup.js'
import agentService from './services/agent.service/index.js'
import conversationService from './services/conversation.service/index.js'

export default async () => {
  await agentService.initializeAgents()
  await conversationService.initializeConversations()
  if (config.env !== 'test') {
    await startJobs()
  }
}
