import { Message } from '../../src/models/index.js'
import setupIntTest from '../utils/setupIntTest.js'

setupIntTest()

describe('Message model indexes', () => {
  beforeAll(async () => {
    // setupIntTest() only wipes documents (deleteMany); indexes are not built automatically
    // in tests, so build them explicitly before asserting they exist.
    await Message.syncIndexes()
  })

  it('has a conversation + visible + createdAt index for the top-level-message fetch', async () => {
    const indexes = await Message.collection.indexes()
    expect(indexes).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: { conversation: 1, visible: 1, createdAt: 1 } })])
    )
  })

  it('has a conversation + createdAt index for conversation-scoped, time-ordered scans', async () => {
    const indexes = await Message.collection.indexes()
    expect(indexes).toEqual(expect.arrayContaining([expect.objectContaining({ key: { conversation: 1, createdAt: 1 } })]))
  })

  it('has a parentMessage + createdAt index for the reply-count and reply-fetch queries', async () => {
    const indexes = await Message.collection.indexes()
    expect(indexes).toEqual(expect.arrayContaining([expect.objectContaining({ key: { parentMessage: 1, createdAt: 1 } })]))
  })
})
