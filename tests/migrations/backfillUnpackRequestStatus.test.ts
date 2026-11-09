import mongoose from 'mongoose'
import migration from '../../migrations/20261109000000-backfill-unpack-request-status.js'
import setupIntTest from '../utils/setupIntTest.js'
import UnpackRequest from '../../src/models/unpackRequest.model.js'

setupIntTest()

const unpackRequests = () => mongoose.connection.db!.collection('unpackrequests')
const params = () => ({ name: migration.name, context: { db: mongoose.connection.db! }, path: undefined })

const catchMeUpAsk = (overrides: Record<string, unknown> = {}) => ({
  conversation: new mongoose.Types.ObjectId(),
  user: new mongoose.Types.ObjectId(),
  mode: 'lastMinute',
  destination: 'privateChat',
  chunkIds: [],
  quote: 'What the speaker said.',
  ...overrides
})

describe('backfill-unpack-request-status migration', () => {
  it('marks every ask saved before status existed as sent, so it saves again without a validation error', async () => {
    const { insertedId } = await unpackRequests().insertOne(catchMeUpAsk())

    await migration.up(params())

    const ask = await UnpackRequest.findById(insertedId)
    expect(ask!.status).toBe('sent')
    await expect(ask!.save()).resolves.toBeDefined()
  })

  it('leaves an ask that already has a status alone', async () => {
    const { insertedId } = await unpackRequests().insertOne(catchMeUpAsk({ mode: 'passage', status: 'previewed' }))

    await migration.up(params())

    expect((await unpackRequests().findOne({ _id: insertedId }))!.status).toBe('previewed')
  })
})
