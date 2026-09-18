import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import { Channel, Conversation, Message, Topic, User } from '../../../src/models/index.js'
import {
  assertSafeTarget,
  cleanSeededEvents,
  generateTranscript,
  parseTranscript,
  seedEvent,
  SEED_USERNAME_PREFIX
} from '../../../scripts/seedEvent.js'

setupIntTest()

const transcript = `# a comment line is skipped
Ada: I lean on the assistant for first drafts, then rewrite everything.
Ben: Same, but I never let it near anything with a deadline.
Ada: Why not?

Cy: Because when it is wrong it is confidently wrong, and you only find out later.`

describe('parseTranscript', () => {
  it('turns "Speaker: text" lines into utterances and skips blanks and comments', () => {
    const lines = parseTranscript(transcript)

    expect(lines).toEqual([
      { speaker: 'Ada', text: 'I lean on the assistant for first drafts, then rewrite everything.' },
      { speaker: 'Ben', text: 'Same, but I never let it near anything with a deadline.' },
      { speaker: 'Ada', text: 'Why not?' },
      { speaker: 'Cy', text: 'Because when it is wrong it is confidently wrong, and you only find out later.' }
    ])
  })

  it('appends a line with no speaker to the previous utterance', () => {
    const lines = parseTranscript('Ada: first half\nsecond half\nBen: reply')

    expect(lines).toEqual([
      { speaker: 'Ada', text: 'first half second half' },
      { speaker: 'Ben', text: 'reply' }
    ])
  })
})

describe('assertSafeTarget', () => {
  it('refuses to run against production', () => {
    expect(() => assertSafeTarget({ nodeEnv: 'production', mongoUrl: 'mongodb://127.0.0.1:27017/x' })).toThrow(/production/)
  })

  it('refuses a remote database unless explicitly allowed', () => {
    const remote = { nodeEnv: 'development', mongoUrl: 'mongodb+srv://user:pw@cluster.example.net/x' }

    expect(() => assertSafeTarget(remote)).toThrow(/--allow-remote/)
    expect(() => assertSafeTarget({ ...remote, allowRemote: true })).not.toThrow()
  })

  it('accepts a local database', () => {
    expect(() => assertSafeTarget({ nodeEnv: 'development', mongoUrl: 'mongodb://localhost:27017/x' })).not.toThrow()
    expect(() => assertSafeTarget({ nodeEnv: 'test', mongoUrl: 'mongodb://127.0.0.1:27017/x-test' })).not.toThrow()
  })
})

describe('seedEvent', () => {
  it('creates a topic, an ended conversation with transcript and chat channels, participant users, and transcript messages', async () => {
    const result = await seedEvent({
      topicName: 'Living with assistants',
      eventName: 'Session one',
      userCount: 2,
      transcript: parseTranscript(transcript)
    })

    const topic = await Topic.findById(result.topicId)
    expect(topic?.name).toBe('Living with assistants')
    expect(topic?.conversations.map(String)).toContain(result.conversationId)

    const conversation = await Conversation.findById(result.conversationId).populate('channels')
    expect(conversation?.topic?.toString()).toBe(result.topicId)
    expect(conversation?.active).toBe(false)
    expect(conversation?.draft).toBe(false)
    expect(conversation?.startTime).toBeInstanceOf(Date)
    expect(conversation?.endTime).toBeInstanceOf(Date)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channelNames = (conversation?.channels as any[]).map((c) => c.name).sort()
    expect(channelNames).toEqual(['chat', 'transcript'])

    const users = await User.find({ username: { $regex: `^${SEED_USERNAME_PREFIX}` } })
    expect(users).toHaveLength(2)
    expect(users.every((u) => u.role === 'participant')).toBe(true)

    const messages = await Message.find({ conversation: result.conversationId }).sort({ createdAt: 1 })
    expect(messages.map((m) => m.body)).toEqual(parseTranscript(transcript).map((l) => l.text))
    expect(messages.every((m) => m.channels?.includes('transcript'))).toBe(true)
    expect(messages.every((m) => m.fromAgent === false)).toBe(true)
    expect(result.messageCount).toBe(4)
  })

  it('maps each speaker to one seeded user, wrapping round when there are more speakers than users', async () => {
    const result = await seedEvent({
      topicName: 't',
      eventName: 'e',
      userCount: 2,
      transcript: parseTranscript(transcript)
    })

    const messages = await Message.find({ conversation: result.conversationId }).sort({ createdAt: 1 })
    const [ada1, ben, ada2, cy] = messages
    expect(ada1.owner?.toString()).toBe(ada2.owner?.toString())
    expect(ada1.pseudonym).toBe(ada2.pseudonym)
    expect(ben.owner?.toString()).not.toBe(ada1.owner?.toString())
    // Third speaker wraps back to the first user
    expect(cy.owner?.toString()).toBe(ada1.owner?.toString())
  })

  it('uses an existing user as the owner when one is named', async () => {
    const owner = await User.create({
      username: 'organizer',
      role: 'admin',
      pseudonyms: [{ token: 'tok', pseudonym: 'Organizer Owl', active: true }]
    })

    const result = await seedEvent({
      topicName: 't',
      eventName: 'e',
      userCount: 1,
      transcript: parseTranscript('Ada: hi there everyone, welcome.'),
      ownerUsername: 'organizer'
    })

    const conversation = await Conversation.findById(result.conversationId)
    expect(conversation?.owner.toString()).toBe(owner._id.toString())
    const topic = await Topic.findById(result.topicId)
    expect(topic?.owner.toString()).toBe(owner._id.toString())
  })

  it('fails loudly when the named owner does not exist', async () => {
    await expect(
      seedEvent({ topicName: 't', eventName: 'e', userCount: 1, transcript: [], ownerUsername: 'nobody' })
    ).rejects.toThrow(/nobody/)
  })

  it('spaces the messages out in time so the transcript reads in order', async () => {
    const result = await seedEvent({
      topicName: 't',
      eventName: 'e',
      userCount: 1,
      transcript: parseTranscript(transcript)
    })

    const messages = await Message.find({ conversation: result.conversationId }).sort({ createdAt: 1 })
    const times = messages.map((m) => m.createdAt!.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(new Set(times).size).toBe(times.length)
    const conversation = await Conversation.findById(result.conversationId)
    expect(times[0]).toBeGreaterThanOrEqual(conversation!.startTime!.getTime())
    expect(times[times.length - 1]).toBeLessThanOrEqual(conversation!.endTime!.getTime())
  })
})

describe('cleanSeededEvents', () => {
  it('removes everything a seed run created and leaves other records alone', async () => {
    const bystanderOwner = new mongoose.Types.ObjectId()
    const bystanderTopic = await Topic.create({
      name: 'Real topic',
      slug: 'real-topic',
      votingAllowed: false,
      conversationCreationAllowed: true,
      private: false,
      archivable: false,
      owner: bystanderOwner
    })
    const bystanderConversation = await Conversation.create({
      name: 'Real event',
      slug: 'real-event',
      owner: bystanderOwner,
      topic: bystanderTopic._id,
      transcript: { status: 'stopped' }
    })
    await Message.create({
      body: 'real',
      conversation: bystanderConversation._id,
      pseudonym: 'Real Person',
      pseudonymId: new mongoose.Types.ObjectId()
    })
    await User.create({ username: 'real-user', pseudonyms: [{ token: 't', pseudonym: 'Real Person', active: true }] })
    await seedEvent({ topicName: 't', eventName: 'e', userCount: 2, transcript: parseTranscript(transcript) })

    const removed = await cleanSeededEvents()

    expect(removed).toEqual({ topics: 1, conversations: 1, channels: 2, messages: 4, users: 2 })
    expect(await Topic.countDocuments()).toBe(1)
    expect(await Conversation.countDocuments()).toBe(1)
    expect(await Channel.countDocuments()).toBe(0)
    expect(await Message.countDocuments()).toBe(1)
    expect(await User.countDocuments()).toBe(1)
  })
})

describe('generateTranscript', () => {
  it('asks the given model for a transcript and parses its reply, without touching any real provider', async () => {
    const invoke = jest.fn().mockResolvedValue({ content: 'Ada: Hello.\nBen: Hi back.\n' })

    const lines = await generateTranscript('a short chat about assistants', {
      speakers: ['Ada', 'Ben'],
      llm: { invoke }
    })

    expect(lines).toEqual([
      { speaker: 'Ada', text: 'Hello.' },
      { speaker: 'Ben', text: 'Hi back.' }
    ])
    const prompt = String(invoke.mock.calls[0][0])
    expect(prompt).toContain('a short chat about assistants')
    expect(prompt).toContain('Ada')
    expect(prompt).toContain('Ben')
  })

  it('rejects a reply that contains no usable lines', async () => {
    const invoke = jest.fn().mockResolvedValue({ content: 'Sorry, I cannot help with that.' })

    await expect(generateTranscript('x', { speakers: ['Ada'], llm: { invoke } })).rejects.toThrow(/no transcript lines/i)
  })
})
