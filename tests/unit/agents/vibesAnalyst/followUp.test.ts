import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import { Message } from '../../../../src/models/index.js'
import { resolveFollowUpContext } from '../../../../src/agents/vibesAnalyst/followUp.js'

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

describe('resolveFollowUpContext', () => {
  it('returns null when the message is not a threaded reply', async () => {
    const conversationId = new mongoose.Types.ObjectId()

    const result = await resolveFollowUpContext(
      { _id: new mongoose.Types.ObjectId(), body: 'how many posters?' } as never,
      conversationId.toString()
    )

    expect(result).toBeNull()
  })

  it("returns the parent card's metrics context for a threaded reply", async () => {
    const conversationId = new mongoose.Types.ObjectId()
    const metricsContext = [{ posterCount: 12, lurkerCount: 68 }]
    const parent = await seedMessage(
      {
        conversation: conversationId,
        responseKind: 'curatedVibesSummary',
        renderData: { header: 'Recap' },
        metricsContext
      },
      new Date('2026-06-10T18:00:00.000Z')
    )

    const result = await resolveFollowUpContext(
      { _id: new mongoose.Types.ObjectId(), conversation: conversationId, parentMessage: parent._id, body: 'so how many lurked?' } as never,
      conversationId.toString()
    )

    expect(result).toEqual(metricsContext)
  })

  it('finds the card in a reply, not just the parent, when the parent itself carries no metrics', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    const metricsContext = [{ posterCount: 5 }]
    const parent = await seedMessage(
      { conversation: conversationId, body: 'plain greeting reply, no card' },
      new Date('2026-06-10T18:00:00.000Z')
    )
    await seedMessage(
      {
        conversation: conversationId,
        parentMessage: parent._id,
        responseKind: 'curatedVibesSummary',
        renderData: { header: 'Recap' },
        metricsContext
      },
      new Date('2026-06-10T18:01:00.000Z')
    )

    const result = await resolveFollowUpContext(
      { _id: new mongoose.Types.ObjectId(), conversation: conversationId, parentMessage: parent._id, body: 'and the rest?' } as never,
      conversationId.toString()
    )

    expect(result).toEqual(metricsContext)
  })

  it('prefers the newest card when the thread carries more than one', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    const olderMetrics = [{ posterCount: 5 }]
    const newerMetrics = [{ posterCount: 9 }]
    const parent = await seedMessage(
      {
        conversation: conversationId,
        responseKind: 'curatedVibesSummary',
        renderData: { header: 'Recap' },
        metricsContext: olderMetrics
      },
      new Date('2026-06-10T18:00:00.000Z')
    )
    await seedMessage(
      {
        conversation: conversationId,
        parentMessage: parent._id,
        responseKind: 'curatedVibesSummary',
        renderData: { header: 'Trend' },
        metricsContext: newerMetrics
      },
      new Date('2026-06-10T18:05:00.000Z')
    )

    const result = await resolveFollowUpContext(
      { _id: new mongoose.Types.ObjectId(), conversation: conversationId, parentMessage: parent._id, body: 'and now?' } as never,
      conversationId.toString()
    )

    expect(result).toEqual(newerMetrics)
  })

  it('returns null when no message in the thread carries metrics context', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    const parent = await seedMessage(
      { conversation: conversationId, body: 'just a greeting' },
      new Date('2026-06-10T18:00:00.000Z')
    )

    const result = await resolveFollowUpContext(
      { _id: new mongoose.Types.ObjectId(), conversation: conversationId, parentMessage: parent._id, body: 'huh?' } as never,
      conversationId.toString()
    )

    expect(result).toBeNull()
  })

  it('never reads across conversations, even if another thread shares the same parent id by coincidence', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    const otherConversationId = new mongoose.Types.ObjectId()
    const parent = await seedMessage(
      { conversation: conversationId, body: 'just a greeting' },
      new Date('2026-06-10T18:00:00.000Z')
    )
    await seedMessage(
      {
        conversation: otherConversationId,
        parentMessage: parent._id,
        responseKind: 'curatedVibesSummary',
        renderData: { header: 'Trend' },
        metricsContext: [{ posterCount: 100 }]
      },
      new Date('2026-06-10T18:05:00.000Z')
    )

    const result = await resolveFollowUpContext(
      { _id: new mongoose.Types.ObjectId(), conversation: conversationId, parentMessage: parent._id, body: 'and now?' } as never,
      conversationId.toString()
    )

    expect(result).toBeNull()
  })
})
