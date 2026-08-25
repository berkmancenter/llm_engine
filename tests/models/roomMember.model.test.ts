import mongoose from 'mongoose'
import { RoomMember } from '../../src/models/index.js'
import setupIntTest from '../utils/setupIntTest.js'
import { conversationCommunityRoom } from '../fixtures/conversation.fixture.js'

setupIntTest()

describe('RoomMember model', () => {
  beforeAll(async () => {
    // setupIntTest() only wipes documents (deleteMany); indexes are not built automatically
    // in tests, so build them explicitly before asserting the unique index is enforced.
    await RoomMember.syncIndexes()
  })

  it('has a unique conversation + email index', async () => {
    const indexes = await RoomMember.collection.indexes()
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
    await RoomMember.create(member)
    await expect(RoomMember.create(member)).rejects.toThrow()
  })

  it('allows the same email in two different conversations', async () => {
    await RoomMember.create({
      conversation: conversationCommunityRoom._id,
      email: 'grace.hopper@example.com',
      name: 'Grace Hopper'
    })
    await expect(
      RoomMember.create({
        conversation: new mongoose.Types.ObjectId(),
        email: 'grace.hopper@example.com',
        name: 'Grace Hopper'
      })
    ).resolves.toBeDefined()
  })

  it('defaults inviteState, alreadyAnnounced, and status', async () => {
    const member = await RoomMember.create({
      conversation: conversationCommunityRoom._id,
      email: 'alan.turing@example.com',
      name: 'Alan Turing'
    })
    expect(member.inviteState).toBe('pending')
    expect(member.alreadyAnnounced).toBe(false)
    expect(member.status).toBe('active')
    expect(member.userAccount).toBeUndefined()
  })
})
