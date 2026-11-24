import mongoose from 'mongoose'
import migration from '../../migrations/20261123000000-unpack-request-destinations.js'
import setupIntTest from '../utils/setupIntTest.js'
import UnpackRequest from '../../src/models/unpackRequest.model.js'

setupIntTest()

const unpackRequests = () => mongoose.connection.db!.collection('unpackrequests')
const params = () => ({ name: migration.name, context: { db: mongoose.connection.db! }, path: undefined })

const savedAsk = (overrides: Record<string, unknown> = {}) => ({
  conversation: new mongoose.Types.ObjectId(),
  user: new mongoose.Types.ObjectId(),
  mode: 'passage',
  status: 'sent',
  chunkIds: [],
  quote: 'What the speaker said.',
  ...overrides
})

describe('unpack-request-destinations migration', () => {
  it('turns the single destination into a one-item list', async () => {
    const { insertedId } = await unpackRequests().insertOne(savedAsk({ destination: 'privateChat' }))

    await migration.up(params())

    const ask = await unpackRequests().findOne({ _id: insertedId })
    expect(ask!.destinations).toEqual(['privateChat'])
    expect(ask).not.toHaveProperty('destination')
  })

  it('gives an ask that was only previewed an empty list', async () => {
    const { insertedId } = await unpackRequests().insertOne(savedAsk({ status: 'previewed' }))

    await migration.up(params())

    expect((await unpackRequests().findOne({ _id: insertedId }))!.destinations).toEqual([])
  })

  it('leaves an ask that already has a list alone', async () => {
    const { insertedId } = await unpackRequests().insertOne(savedAsk({ destinations: ['privateChat', 'groupChat'] }))

    await migration.up(params())

    expect((await unpackRequests().findOne({ _id: insertedId }))!.destinations).toEqual(['privateChat', 'groupChat'])
  })

  it('leaves rows the model can find by destination', async () => {
    await unpackRequests().insertOne(savedAsk({ destination: 'privateChat' }))

    await migration.up(params())

    expect(await UnpackRequest.countDocuments({ destinations: 'privateChat' })).toBe(1)
  })
})
