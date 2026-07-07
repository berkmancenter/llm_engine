import Message from '../../models/message.model.js'
import { IMessage } from '../../types/index.types.js'

/**
 * Fetches every message in this message's thread (the root plus all its replies), newest first.
 * Returns an empty array when the message is not a threaded reply, since there is no thread to
 * walk. Shared by every VA check that needs to look at what was said earlier in the same thread.
 */
export async function fetchThread(userMessage: IMessage, conversationId: string): Promise<IMessage[]> {
  if (!userMessage.parentMessage) return []
  return Message.find({
    conversation: conversationId,
    $or: [{ _id: userMessage.parentMessage }, { parentMessage: userMessage.parentMessage }]
  }).sort({ createdAt: -1 })
}

/**
 * True when the most recent message in this thread before this one was posted by this same
 * agent. Lets a threaded reply to something VA just said (a disambiguation list, a follow-up
 * question) count as addressed to VA without an explicit @mention, since the human is continuing
 * a conversation VA itself just spoke last in. False once someone else has replied since, so VA
 * does not keep intercepting a thread indefinitely after it has stopped being the one waiting on
 * an answer.
 */
export async function threadContinuesFromAgent(userMessage: IMessage, conversationId: string, agentId: string): Promise<boolean> {
  const thread = await fetchThread(userMessage, conversationId)
  const previous = thread.find((message) => message._id?.toString() !== userMessage._id?.toString())
  if (!previous?.fromAgent) return false
  const owner = previous.owner as unknown as { toString(): string } | undefined
  return owner?.toString() === agentId
}
