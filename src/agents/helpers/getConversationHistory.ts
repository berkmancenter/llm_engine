import Message from '../../models/message.model.js'
import { filterForAudience, hideContextOf } from '../../utils/messageVisibility.js'
import { ConversationHistorySettings } from '../../types/index.types.js'

export default function getConversationHistory(
  messages,
  settings: ConversationHistorySettings = { count: 10, channels: [] },
  onlyIncludeAgents?,
  directChannels?,
  parseInput?
) {
  const { count, timeWindow, endTime } = settings
  const end = endTime ?? new Date(Date.now())
  let start
  /* Backstop for the 'model' audience: callers populate `messages` without hidden ones (see
     populateMessagesForModel), and this drops any that got through: flagged, by a hidden author or a reply under
     a hidden message. The hide context is the one the list was populated under (hideContextOf), unless
     `settings.hideContext` overrides it. */
  let filteredMessages = filterForAudience(messages, 'model', settings.hideContext ?? hideContextOf(messages))
  if (settings.channels || (directChannels && settings.directMessages)) {
    const channels = settings.channels || []
    if (directChannels && settings.directMessages) {
      channels.push(...directChannels)
    }
    filteredMessages = filteredMessages.filter((message) => message.channels?.some((channel) => channels.includes(channel)))
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
  if (onlyIncludeAgents) {
    filteredMessages = filteredMessages.filter(
      (message) => !message.fromAgent || (message.fromAgent && onlyIncludeAgents.includes(message.pseudonym))
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
