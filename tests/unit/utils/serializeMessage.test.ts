import mongoose from 'mongoose'
import serializeMessage from '../../../src/utils/serializeMessage.js'
import { Message, User } from '../../../src/models/index.js'

describe('serializeMessage owner', () => {
  const build = (owner) =>
    new Message({
      body: 'hi',
      conversation: new mongoose.Types.ObjectId(),
      owner,
      pseudonym: 'p',
      pseudonymId: new mongoose.Types.ObjectId()
    })

  it('emits the id string when the owner is an ObjectId', () => {
    const id = new mongoose.Types.ObjectId()
    expect(serializeMessage(build(id)).owner).toBe(id.toString())
  })

  it('collapses a populated User document to its id string', () => {
    const user = new User({ username: 'u', email: 'u@example.com', password: 'password1', role: 'participant' })
    const out = serializeMessage(build(user))
    expect(out.owner).toBe(user._id.toString())
    expect(typeof out.owner).toBe('string')
  })

  it('leaves a missing owner missing', () => {
    expect(serializeMessage(build(undefined)).owner).toBeUndefined()
  })
})
