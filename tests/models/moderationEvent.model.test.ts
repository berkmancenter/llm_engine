/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { ModerationEvent } from '../../src/models/index.js'

setupIntTest()

const valid = () => ({
  conversation: new mongoose.Types.ObjectId(),
  actor: new mongoose.Types.ObjectId(),
  action: 'hide' as const,
  scope: 'message' as const,
  targetMessage: new mongoose.Types.ObjectId(),
  messageIds: [new mongoose.Types.ObjectId()],
  reason: 'pii'
})

describe('ModerationEvent model', () => {
  it('stores an event with a creation time and no update time', async () => {
    const event = await ModerationEvent.create(valid())
    const json = event.toJSON() as Record<string, any>
    expect(json.createdAt).toBeInstanceOf(Date)
    expect(json.updatedAt).toBeUndefined()
    expect(json.id).toBeDefined()
  })

  it('requires conversation, actor, action and scope, and restricts action and scope', async () => {
    await expect(ModerationEvent.create({ ...valid(), conversation: undefined })).rejects.toThrow()
    await expect(ModerationEvent.create({ ...valid(), actor: undefined })).rejects.toThrow()
    await expect(ModerationEvent.create({ ...valid(), action: 'delete' as never })).rejects.toThrow()
    await expect(ModerationEvent.create({ ...valid(), scope: 'everyone' as never })).rejects.toThrow()
  })

  it('caps the reason length and has no field that could hold a message body', async () => {
    await expect(ModerationEvent.create({ ...valid(), reason: 'x'.repeat(201) })).rejects.toThrow()
    expect(Object.keys(ModerationEvent.schema.paths)).not.toContain('body')
  })

  it('indexes by conversation and creation time', async () => {
    await ModerationEvent.syncIndexes()
    const indexes = await ModerationEvent.collection.indexes()
    expect(indexes.some((i) => JSON.stringify(i.key) === JSON.stringify({ conversation: 1, createdAt: 1 }))).toBe(true)
  })

  describe('is append-only', () => {
    it('refuses to save changes to an existing event', async () => {
      const event = await ModerationEvent.create(valid())
      event.reason = 'other'
      await expect(event.save()).rejects.toThrow(/append-only/)
    })

    it.each([
      ['updateOne', (id) => ModerationEvent.updateOne({ _id: id }, { reason: 'other' })],
      ['updateMany', (id) => ModerationEvent.updateMany({ _id: id }, { reason: 'other' })],
      ['findOneAndUpdate', (id) => ModerationEvent.findOneAndUpdate({ _id: id }, { reason: 'other' })],
      ['replaceOne', (id) => ModerationEvent.replaceOne({ _id: id }, valid())],
      ['deleteOne', (id) => ModerationEvent.deleteOne({ _id: id })],
      ['deleteMany', (id) => ModerationEvent.deleteMany({ _id: id })],
      ['findOneAndDelete', (id) => ModerationEvent.findOneAndDelete({ _id: id })]
    ])('refuses %s', async (_name, run) => {
      const event = await ModerationEvent.create(valid())
      await expect(run(event._id)).rejects.toThrow(/append-only/)
      expect(await ModerationEvent.countDocuments({ _id: event._id })).toBe(1)
      expect((await ModerationEvent.findById(event._id))!.reason).toBe('pii')
    })

    it('refuses a document-level delete', async () => {
      const event = await ModerationEvent.create(valid())
      await expect(event.deleteOne()).rejects.toThrow(/append-only/)
    })
  })
})
