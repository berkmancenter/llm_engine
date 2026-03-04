import logger from '../../config/logger.js'
import { IChannel } from '../../types/index.types.js'

export default class AgentEvaluationService {
  static async evaluateMessage(agent, userMessage, messageCount) {
    // Disallow processing messages from agents (including self) unless explicitly opted in
    if (userMessage.fromAgent && !agent.triggers?.perMessage?.allowMessagesFromAgents) return false

    if (userMessage && !agent.triggers?.perMessage) {
      return false
    }

    if (userMessage.channels && userMessage.channels.length > 0) {
      const triggerChannels = agent.triggers?.perMessage?.channels || []
      const matchingChannels = userMessage.channels.filter((channel) => triggerChannels.includes(channel))

      // Get direct channels if direct messages are enabled
      const directChannels = agent.triggers?.perMessage?.directMessages
        ? userMessage.channels.filter((channelName) => {
            const channel = agent.conversation.channels.find((ch: IChannel) => ch.name === channelName)
            return (channel as IChannel)?.direct && channel.participants?.includes(agent._id)
          })
        : []

      // Either no matching channels in channel trigger or no supported DM channels
      if (matchingChannels.length === 0 && directChannels.length === 0) {
        return false
      }
    }
    if (
      agent.triggers.perMessage!.minNewMessages &&
      messageCount - agent.lastActiveMessageCount < agent.triggers.perMessage!.minNewMessages
    ) {
      logger.debug('Not enough new messages for activation')
      return false
    }
    return true
  }
}
