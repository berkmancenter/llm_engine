import Message from '../../models/message.model.js'
import { ConversationHistorySettings } from '../../types/index.types.js'

export default function getConversationHistory(
  messages,
  settings: ConversationHistorySettings = { count: 10, channels: [] },
  includeAgents?,
  directChannels?,
  parseInput?
) {
  const { count, timeWindow, endTime } = settings
  const end = endTime ?? new Date(Date.now())
  let start
  let filteredMessages = [...messages]
  if (settings.channels || (directChannels && settings.directMessages)) {
    const channels = settings.channels || []
    if (directChannels && settings.directMessages) {
      channels.push(...directChannels)
    }
    filteredMessages = messages.filter((message) => message.channels?.some((channel) => channels.includes(channel)))
  }
  if (timeWindow) {
    start = new Date(end.getTime() - timeWindow * 1000)
    filteredMessages = filteredMessages.filter(
      (message) => message.updatedAt.getTime() >= start.getTime() && message.updatedAt.getTime() <= end.getTime()
    )
  } else if (endTime) {
    filteredMessages = filteredMessages.filter((message) => message.updatedAt.getTime() <= endTime.getTime())
  }
  if (count) {
    filteredMessages = filteredMessages.slice(Math.max(0, filteredMessages.length - count))
  }
  if (includeAgents) {
    filteredMessages = filteredMessages.filter(
      (message) => !message.fromAgent || (message.fromAgent && includeAgents.includes(message.pseudonym))
    )
  }
  if (!start) {
    // Set start to the timestamp of the first message
    start = filteredMessages[0]?.updatedAt
  }
  if (parseInput) {
    filteredMessages = filteredMessages.map((message) => new Message(parseInput(message.toObject())))
  }
  return { start, end, messages: filteredMessages }
}
