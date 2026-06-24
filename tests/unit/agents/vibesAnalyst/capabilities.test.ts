import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import { Message } from '../../../../src/models/index.js'
import capabilities, {
  VA_READABLE_CHANNELS,
  loadReadableMessages
} from '../../../../src/agents/vibesAnalyst/capabilities.js'

setupIntTest()

const ownerId = new mongoose.Types.ObjectId()
const EVENT_START = new Date('2026-06-10T10:00:00.000Z')

/* A timestamp N minutes into the event, so message ordering in these tests reads
   in plain minutes instead of raw millisecond math. */
function minutesIn(minutes: number): Date {
  return new Date(EVENT_START.getTime() + minutes * 60 * 1000)
}

/* Seeds one message in the given channels at a fixed createdAt so ordering is
   deterministic. timestamps:true stamps createdAt at insert and marks it
   immutable, so the offset is forced through the native driver, which bypasses
   Mongoose casting and the immutable guard. */
async function seedMessage(
  conversationId: mongoose.Types.ObjectId,
  channels: string[] | undefined,
  body: string,
  createdAt: Date,
  fromAgent = false
) {
  const [message] = await Message.create([
    { body, conversation: conversationId, owner: ownerId, pseudonymId: ownerId, pseudonym: 'ana', fromAgent, channels }
  ])
  await Message.collection.updateOne({ _id: message._id }, { $set: { createdAt } })
}

describe('vibesAnalyst capabilities', () => {
  it('reads all public topics so it can react to every public event', () => {
    const result = capabilities()
    expect(result.read).toEqual([{ type: 'allPublicTopics' }])
  })

  it('writes only to its own conversation', () => {
    const result = capabilities()
    expect(result.write).toEqual([{ type: 'ownConversation' }])
  })
})

describe('VA_READABLE_CHANNELS', () => {
  it('allowlists the shared event channels and nothing else', () => {
    expect([...VA_READABLE_CHANNELS]).toEqual(['transcript', 'chat', 'moderator'])
  })
})

describe('loadReadableMessages', () => {
  it('returns only messages in allowlisted channels, oldest first', async () => {
    const conversationId = new mongoose.Types.ObjectId()

    await seedMessage(conversationId, ['transcript'], 'speaker line', minutesIn(1))
    await seedMessage(conversationId, ['chat'], 'audience reply', minutesIn(2))
    await seedMessage(conversationId, ['moderator'], 'mod backchannel note', minutesIn(3))

    const messages = await loadReadableMessages(conversationId)

    expect(messages.map((m) => m.body)).toEqual(['speaker line', 'audience reply', 'mod backchannel note'])
  })

  it('excludes 1:1 direct DM channels (generated names are not on the allowlist)', async () => {
    const conversationId = new mongoose.Types.ObjectId()

    await seedMessage(conversationId, ['chat'], 'public', minutesIn(1))
    await seedMessage(conversationId, ['dm-7f3a9c2b'], 'private DM with the bot', minutesIn(2))

    const messages = await loadReadableMessages(conversationId)

    expect(messages.map((m) => m.body)).toEqual(['public'])
  })

  it('excludes messages with no channel or an unknown channel', async () => {
    const conversationId = new mongoose.Types.ObjectId()

    await seedMessage(conversationId, ['chat'], 'public', minutesIn(1))
    await seedMessage(conversationId, undefined, 'channelless', minutesIn(2))
    await seedMessage(conversationId, ['image-gen'], 'other channel', minutesIn(3))

    const messages = await loadReadableMessages(conversationId)

    expect(messages.map((m) => m.body)).toEqual(['public'])
  })

  it('includes agent messages so callers can count agent activity', async () => {
    const conversationId = new mongoose.Types.ObjectId()

    await seedMessage(conversationId, ['chat'], 'human asks Berkie', minutesIn(1), false)
    await seedMessage(conversationId, ['chat'], 'Berkie answers', minutesIn(2), true)

    const messages = await loadReadableMessages(conversationId)

    expect(messages.map((m) => m.fromAgent)).toEqual([false, true])
  })

  it('scopes to the given conversation only', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    const otherConversationId = new mongoose.Types.ObjectId()

    await seedMessage(conversationId, ['chat'], 'ours', minutesIn(1))
    await seedMessage(otherConversationId, ['chat'], 'theirs', minutesIn(2))

    const messages = await loadReadableMessages(conversationId)

    expect(messages.map((m) => m.body)).toEqual(['ours'])
  })
})
