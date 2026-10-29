import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import UnpackRequest from '../../src/models/unpackRequest.model.js'

setupIntTest()

const validRequest = () => ({
  conversation: new mongoose.Types.ObjectId(),
  user: new mongoose.Types.ObjectId(),
  mode: 'lastMinute',
  chunkIds: [new mongoose.Types.ObjectId()],
  quote: 'We measure reliability with SLOs.',
  requestMessage: new mongoose.Types.ObjectId(),
  answerMessage: new mongoose.Types.ObjectId()
})

describe('UnpackRequest model', () => {
  it('saves a request and defaults the destination to Private Chat', async () => {
    const saved = await UnpackRequest.create(validRequest())

    expect(saved.destination).toBe('privateChat')
    expect(saved.createdAt).toBeInstanceOf(Date)
  })

  it('has no pseudonym field, so a row can never store one', async () => {
    const saved = await UnpackRequest.create({ ...validRequest(), pseudonym: 'Curious Otter' })

    expect(saved.toObject()).not.toHaveProperty('pseudonym')
  })

  it.each(['conversation', 'user', 'mode', 'answerMessage'])('requires %s', async (field) => {
    const request = validRequest()
    delete request[field]

    await expect(UnpackRequest.create(request)).rejects.toThrow(mongoose.Error.ValidationError)
  })

  it('rejects a mode it does not support yet', async () => {
    await expect(UnpackRequest.create({ ...validRequest(), mode: 'selection' })).rejects.toThrow(
      mongoose.Error.ValidationError
    )
  })
})
