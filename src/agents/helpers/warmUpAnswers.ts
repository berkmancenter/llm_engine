import mongoose from 'mongoose'
import { findMessages } from '../../utils/messageVisibility.js'

/**
 * Replies to this conversation's warm-up-question prompt(s), found via answersPrompt rather than
 * "any non-agent DM content" — so an unrelated later DM isn't swept in. body.type: 'warmUpQuestion'
 * is already unique within a conversation, so no further scoping by agent or channel is needed.
 *
 * `promptMessageIds` lets a caller that already fetched the prompt messages for its own purposes
 * (e.g. to read their question text) pass the ids straight through, instead of this function
 * re-running the identical body.type: 'warmUpQuestion' query a second time.
 */
export default async function findWarmUpAnswers(
  conversationId: string | mongoose.Types.ObjectId,
  promptMessageIds?: mongoose.Types.ObjectId[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const ids =
    promptMessageIds ?? (await findMessages(conversationId, 'model', { 'body.type': 'warmUpQuestion' })).map((m) => m._id)
  if (!ids.length) return []
  return findMessages(conversationId, 'model', {
    answersPrompt: { $in: ids }
  })
}
