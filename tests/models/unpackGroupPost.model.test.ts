import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import UnpackGroupPost from '../../src/models/unpackGroupPost.model.js'

setupIntTest()

const post = (chunkIds: mongoose.Types.ObjectId[]) => ({
  conversation: new mongoose.Types.ObjectId(),
  chunkIds,
  message: new mongoose.Types.ObjectId(),
  status: 'posting'
})

describe('UnpackGroupPost model', () => {
  beforeAll(async () => {
    await UnpackGroupPost.syncIndexes()
  })

  it('refuses a second post that shares even one chunk with an earlier one', async () => {
    const [first, shared, last] = [1, 2, 3].map(() => new mongoose.Types.ObjectId())
    await UnpackGroupPost.create(post([first, shared]))

    await expect(UnpackGroupPost.create(post([shared, last]))).rejects.toThrow(/duplicate key/)
  })

  it('accepts posts about different chunks', async () => {
    await UnpackGroupPost.create(post([new mongoose.Types.ObjectId()]))

    await expect(UnpackGroupPost.create(post([new mongoose.Types.ObjectId()]))).resolves.toBeDefined()
  })

  it('rejects a status it does not know', async () => {
    await expect(UnpackGroupPost.create({ ...post([new mongoose.Types.ObjectId()]), status: 'failed' })).rejects.toThrow(
      mongoose.Error.ValidationError
    )
  })
})
