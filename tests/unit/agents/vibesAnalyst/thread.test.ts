import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import { Message } from '../../../../src/models/index.js'
import { threadContinuesFromAgent } from '../../../../src/agents/vibesAnalyst/thread.js'

setupIntTest()

const ownerId = new mongoose.Types.ObjectId()

/* Seeds one message at a fixed createdAt so thread ordering is deterministic. timestamps:true
   stamps createdAt at insert and marks it immutable, so the offset is forced through the native
   driver, which bypasses Mongoose casting and the immutable guard. */
async function seedMessage(overrides: Record<string, unknown>, createdAt: Date) {
  const [message] = await Message.create([
    { body: 'x', owner: ownerId, pseudonymId: ownerId, pseudonym: 'ana', ...overrides }
  ])
  await Message.collection.updateOne({ _id: message._id }, { $set: { createdAt } })
  return message
}

describe('threadContinuesFromAgent', () => {
  it('returns false when the message is not a threaded reply', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    const agentId = new mongoose.Types.ObjectId()

    const result = await threadContinuesFromAgent(
      { _id: new mongoose.Types.ObjectId(), body: 'Test Fancy Vibes #3' } as never,
      conversationId.toString(),
      agentId.toString()
    )

    expect(result).toBe(false)
  })

  it('returns true when the most recent message in the thread was posted by this agent', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    const agentId = new mongoose.Types.ObjectId()
    const parent = await seedMessage(
      { conversation: conversationId, body: 'What happened at Test Fancy Vibes?' },
      new Date('2026-06-10T18:00:00.000Z')
    )
    await seedMessage(
      {
        conversation: conversationId,
        parentMessage: parent._id,
        owner: agentId,
        fromAgent: true,
        body: 'A few public events match that. Which one did you mean?'
      },
      new Date('2026-06-10T18:00:05.000Z')
    )

    const result = await threadContinuesFromAgent(
      { _id: new mongoose.Types.ObjectId(), conversation: conversationId, parentMessage: parent._id, body: 'Test Fancy Vibes #3' } as never,
      conversationId.toString(),
      agentId.toString()
    )

    expect(result).toBe(true)
  })

  it('returns false when a human replied most recently, even though the agent spoke earlier in the thread', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    const agentId = new mongoose.Types.ObjectId()
    const parent = await seedMessage(
      { conversation: conversationId, body: 'What happened at Test Fancy Vibes?' },
      new Date('2026-06-10T18:00:00.000Z')
    )
    await seedMessage(
      {
        conversation: conversationId,
        parentMessage: parent._id,
        owner: agentId,
        fromAgent: true,
        body: 'Which one did you mean?'
      },
      new Date('2026-06-10T18:00:05.000Z')
    )
    await seedMessage(
      { conversation: conversationId, parentMessage: parent._id, body: 'never mind, something else' },
      new Date('2026-06-10T18:00:10.000Z')
    )

    const result = await threadContinuesFromAgent(
      { _id: new mongoose.Types.ObjectId(), conversation: conversationId, parentMessage: parent._id, body: 'ok thanks' } as never,
      conversationId.toString(),
      agentId.toString()
    )

    expect(result).toBe(false)
  })

  it('returns false when the most recent message was posted by a different agent', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    const agentId = new mongoose.Types.ObjectId()
    const otherAgentId = new mongoose.Types.ObjectId()
    const parent = await seedMessage(
      { conversation: conversationId, body: 'What happened at Test Fancy Vibes?' },
      new Date('2026-06-10T18:00:00.000Z')
    )
    await seedMessage(
      {
        conversation: conversationId,
        parentMessage: parent._id,
        owner: otherAgentId,
        fromAgent: true,
        body: 'Some unrelated agent chiming in'
      },
      new Date('2026-06-10T18:00:05.000Z')
    )

    const result = await threadContinuesFromAgent(
      { _id: new mongoose.Types.ObjectId(), conversation: conversationId, parentMessage: parent._id, body: 'Test Fancy Vibes #3' } as never,
      conversationId.toString(),
      agentId.toString()
    )

    expect(result).toBe(false)
  })
})
