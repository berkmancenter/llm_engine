import Message from '../../models/message.model.js'
import { IMessage } from '../../types/index.types.js'

/**
 * Gets messages for a threaded conversation.
 * If userMessage has a parentMessage, fetches the parent and all its replies.
 * Otherwise returns all messages up to (but not including) the userMessage.
 *
 * @param allMessages - All messages in the conversation
 * @param userMessage - The current user message being responded to
 * @param conversationId - The conversation ID for fetching additional messages if needed
 * @returns Array of messages that should be included in the conversation history
 */
export default async function getThreadMessages(
  allMessages: IMessage[],
  userMessage: IMessage | null,
  conversationId: string
): Promise<IMessage[]> {
  if (!userMessage || allMessages.length === 0) {
    return allMessages
  }

  // Check if this is a threaded reply
  if (userMessage.parentMessage) {
    // For threaded replies, build history from just the thread
    // Fetch the parent message and all replies to it (excluding the current userMessage)
    const parentMessage = allMessages.find((m) => m._id?.equals(userMessage.parentMessage))

    if (parentMessage) {
      // Get all replies to the parent (excluding current userMessage)
      const replies = await Message.find({
        parentMessage: userMessage.parentMessage,
        _id: { $ne: userMessage._id },
        conversation: conversationId
      })
        .sort({ createdAt: 1 })
        .exec()

      // Build thread: parent + replies in chronological order
      return [parentMessage, ...replies].sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime())
    }

    // Parent not found in current messages, fetch it separately
    const fetchedParent = await Message.findById(userMessage.parentMessage).exec()

    if (fetchedParent) {
      const replies = await Message.find({
        parentMessage: userMessage.parentMessage,
        _id: { $ne: userMessage._id },
        conversation: conversationId
      })
        .sort({ createdAt: 1 })
        .exec()

      return [fetchedParent, ...replies].sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime())
    }

    // Parent not found at all, fall back to empty history
    return []
  }

  // Not a threaded reply - use normal flow
  // Find and exclude userMessage from history (and anything that was added after it, between evaluate and respond)
  const userMsgIndex = allMessages.findIndex((m) => m._id?.equals(userMessage._id))
  if (userMsgIndex !== -1) {
    return allMessages.slice(0, userMsgIndex)
  }

  return allMessages
}
