import mongoose from 'mongoose'
import { ConversationMembership } from '../../src/models/index.js'
import setupIntTest from '../utils/setupIntTest.js'
import { conversationCommunityRoom } from '../fixtures/conversation.fixture.js'

setupIntTest()

describe('ConversationMembership model', () => {
  beforeAll(async () => {
    // setupIntTest() only wipes documents (deleteMany); indexes are not built automatically
    // in tests, so build them explicitly before asserting the unique index is enforced.
    await ConversationMembership.syncIndexes()
  })

  it('has a unique conversation + email index', async () => {
    const indexes = await ConversationMembership.collection.indexes()
    expect(indexes).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: { conversation: 1, email: 1 }, unique: true })])
    )
  })

  it('rejects a second record for the same conversation + email', async () => {
    const member = {
      conversation: conversationCommunityRoom._id,
      email: 'ada.lovelace@example.com',
      name: 'Ada Lovelace'
    }
    await ConversationMembership.create(member)
    await expect(ConversationMembership.create(member)).rejects.toThrow()
  })

  it('allows the same email in two different conversations', async () => {
    await ConversationMembership.create({
      conversation: conversationCommunityRoom._id,
      email: 'grace.hopper@example.com',
      name: 'Grace Hopper'
    })
    await expect(
      ConversationMembership.create({
        conversation: new mongoose.Types.ObjectId(),
        email: 'grace.hopper@example.com',
        name: 'Grace Hopper'
      })
    ).resolves.toBeDefined()
  })

  it('defaults inviteState, joined, and status', async () => {
    const member = await ConversationMembership.create({
      conversation: conversationCommunityRoom._id,
      email: 'alan.turing@example.com',
      name: 'Alan Turing'
    })
    expect(member.inviteState).toBe('pending')
    expect(member.joined).toBe(false)
    expect(member.status).toBe('active')
    expect(member.userAccount).toBeUndefined()
  })
})
