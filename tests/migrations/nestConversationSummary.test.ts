import mongoose from 'mongoose'
import migration from '../../migrations/20261118000000-nest-conversation-summary.js'
import setupIntTest from '../utils/setupIntTest.js'
import Conversation from '../../src/models/conversation.model.js'

setupIntTest()

const conversations = () => mongoose.connection.db!.collection('conversations')
const params = () => ({ name: migration.name, context: { db: mongoose.connection.db! }, path: undefined })

const legacyConversation = (overrides: Record<string, unknown> = {}) => ({
  name: 'Legacy Conversation',
  owner: new mongoose.Types.ObjectId(),
  topic: new mongoose.Types.ObjectId(),
  active: false,
  agents: [],
  adapters: [],
  messages: [],
  channels: [],
  ...overrides
})

describe('nest-conversation-summary migration', () => {
  it('moves a real summary and its provenance under postEventAnalysis', async () => {
    const { insertedId } = await conversations().insertOne(
      legacyConversation({
        summary: 'What happened in the meeting.',
        summaryProvenance: { sourceMessageIds: [], authorIds: [], generator: 'conversationSummary', generatedAt: new Date() }
      })
    )

    const result = await migration.up(params())

    expect((result as { moved: number }).moved).toBe(1)
    const doc = await Conversation.findById(insertedId)
    expect(doc!.postEventAnalysis?.summary).toBe('What happened in the meeting.')
    expect(doc!.postEventAnalysis?.summaryProvenance?.generator).toBe('conversationSummary')
    const raw = await conversations().findOne({ _id: insertedId })
    expect(raw).not.toHaveProperty('summary')
    expect(raw).not.toHaveProperty('summaryProvenance')
  })

  it('just unsets the old fields, without nesting anything, for the untouched default-empty case', async () => {
    const { insertedId } = await conversations().insertOne(legacyConversation({ summary: '' }))

    await migration.up(params())

    const doc = await Conversation.findById(insertedId)
    expect(doc!.postEventAnalysis).toBeUndefined()
    const raw = await conversations().findOne({ _id: insertedId })
    expect(raw).not.toHaveProperty('summary')
  })

  it('leaves a conversation with no summary field at all untouched', async () => {
    const { insertedId } = await conversations().insertOne(legacyConversation())

    const result = await migration.up(params())

    expect((result as { moved: number }).moved).toBe(0)
    const doc = await Conversation.findById(insertedId)
    expect(doc!.postEventAnalysis).toBeUndefined()
  })

  it('keeps a summary already written in the new shape and only unsets the old fields', async () => {
    const provenance = (generatedAt: Date) => ({
      sourceMessageIds: [],
      authorIds: [],
      generator: 'conversationSummary',
      generatedAt
    })
    const firstStop = new Date(Date.now() - 24 * 60 * 60 * 1000) // 1 day ago
    const secondStop = new Date()
    const { insertedId } = await conversations().insertOne(
      legacyConversation({
        summary: 'Summary from the first stop.',
        summaryProvenance: provenance(firstStop),
        postEventAnalysis: {
          summary: 'Summary from the second stop.',
          summaryProvenance: provenance(secondStop),
          openThreads: ['Still open?']
        }
      })
    )

    await migration.up(params())

    const raw = await conversations().findOne({ _id: insertedId })
    expect(raw!.postEventAnalysis.summary).toBe('Summary from the second stop.')
    expect(raw!.postEventAnalysis.summaryProvenance.generatedAt).toEqual(secondStop)
    expect(raw!.postEventAnalysis.openThreads).toEqual(['Still open?'])
    expect(raw).not.toHaveProperty('summary')
    expect(raw).not.toHaveProperty('summaryProvenance')
  })

  it('down moves summary and its provenance back to the top level', async () => {
    const { insertedId } = await conversations().insertOne(
      legacyConversation({
        summary: 'What happened in the meeting.',
        summaryProvenance: { sourceMessageIds: [], authorIds: [], generator: 'conversationSummary', generatedAt: new Date() }
      })
    )
    await migration.up(params())

    await migration.down(params())

    const raw = await conversations().findOne({ _id: insertedId })
    expect(raw!.summary).toBe('What happened in the meeting.')
    expect(raw!.summaryProvenance.generator).toBe('conversationSummary')
    // $rename empties the subdocument's two keys but leaves the (now-empty) object itself -
    // harmless residue, same as the up direction leaving the old field names unset rather
    // than deleted outright.
    expect(raw!.postEventAnalysis).toEqual({})
  })

  it('down leaves a sibling openThreads on postEventAnalysis untouched', async () => {
    const { insertedId } = await conversations().insertOne(
      legacyConversation({ postEventAnalysis: { summary: 'Recap.', openThreads: ['Still open?'] } })
    )

    await migration.down(params())

    const raw = await conversations().findOne({ _id: insertedId })
    expect(raw!.summary).toBe('Recap.')
    expect(raw!.postEventAnalysis.summary).toBeUndefined()
    expect(raw!.postEventAnalysis.openThreads).toEqual(['Still open?'])
  })
})
