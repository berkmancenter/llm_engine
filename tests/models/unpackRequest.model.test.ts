import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import UnpackRequest from '../../src/models/unpackRequest.model.js'

setupIntTest()

const validRequest = () => ({
  conversation: new mongoose.Types.ObjectId(),
  user: new mongoose.Types.ObjectId(),
  mode: 'lastMinute',
  destination: 'privateChat',
  status: 'sent',
  chunkIds: [new mongoose.Types.ObjectId()],
  quote: 'We measure reliability with SLOs.',
  requestMessage: new mongoose.Types.ObjectId(),
  answerMessage: new mongoose.Types.ObjectId()
})

describe('UnpackRequest model', () => {
  it('saves a request with its creation time', async () => {
    const saved = await UnpackRequest.create(validRequest())

    expect(saved.createdAt).toBeInstanceOf(Date)
  })

  it('has no pseudonym field, so a row can never store one', async () => {
    const saved = await UnpackRequest.create({ ...validRequest(), pseudonym: 'Curious Otter' })

    expect(saved.toObject()).not.toHaveProperty('pseudonym')
  })

  it.each(['conversation', 'user', 'mode', 'status'])('requires %s', async (field) => {
    const request = validRequest()
    delete request[field]

    await expect(UnpackRequest.create(request)).rejects.toThrow(mongoose.Error.ValidationError)
  })

  describe('passage asks', () => {
    beforeAll(async () => {
      await UnpackRequest.syncIndexes()
    })

    const passageAsk = (user = new mongoose.Types.ObjectId()) => ({
      conversation: new mongoose.Types.ObjectId(),
      user,
      mode: 'passage',
      status: 'previewed',
      passageKey: 'chunkA:0-chunkB:12',
      range: {
        startMessageId: new mongoose.Types.ObjectId(),
        startOffset: 0,
        endMessageId: new mongoose.Types.ObjectId(),
        endOffset: 12
      }
    })

    it('saves a preview with no destination, request message or answer yet', async () => {
      const saved = await UnpackRequest.create(passageAsk())

      expect(saved.destination).toBeUndefined()
      expect(saved.answerMessage).toBeUndefined()
      expect(saved.range!.endOffset).toBe(12)
    })

    it('keeps one ask per person per passage', async () => {
      const user = new mongoose.Types.ObjectId()
      await UnpackRequest.create(passageAsk(user))

      await expect(UnpackRequest.create(passageAsk(user))).rejects.toThrow(/duplicate key/)
    })

    it('lets different people ask about the same passage', async () => {
      await UnpackRequest.create(passageAsk())

      await expect(UnpackRequest.create(passageAsk())).resolves.toBeDefined()
    })

    it('still lets one person ask to catch up on the last minute many times', async () => {
      const user = new mongoose.Types.ObjectId()
      await UnpackRequest.create({ ...validRequest(), user })

      await expect(UnpackRequest.create({ ...validRequest(), user })).resolves.toBeDefined()
    })
  })

  it('rejects a mode it does not support yet', async () => {
    await expect(UnpackRequest.create({ ...validRequest(), mode: 'selection' })).rejects.toThrow(
      mongoose.Error.ValidationError
    )
  })
})
