import faker from 'faker'
import setupIntTest from './setupIntTest.js'
import { newPublicTopic, insertTopics } from '../fixtures/topic.fixture.js'
import { Conversation, ConversationMembership, User } from '../../src/models/index.js'
import assertMembership from '../../src/utils/assertMembership.js'

setupIntTest()

const createUser = async (role = 'participant') =>
  User.create({
    username: faker.internet.userName(),
    email: faker.internet.email().toLowerCase(),
    password: 'password123',
    role,
    isEmailVerified: false,
    pseudonyms: [{ pseudonym: faker.name.findName(), token: faker.datatype.uuid(), active: true }]
  })

describe('assertMembership', () => {
  let adminUser
  let memberUser
  let nonMemberUser
  let enforcedConv
  let openConv

  beforeEach(async () => {
    adminUser = await createUser('admin')
    memberUser = await createUser()
    nonMemberUser = await createUser()

    const topic = newPublicTopic()
    topic.owner = adminUser._id
    await insertTopics([topic])

    enforcedConv = await Conversation.create({
      name: 'Members Only',
      owner: adminUser._id,
      topic: topic._id,
      enforceMembership: true,
      useRealNames: false,
      enableDMs: [],
      enableAgents: false
    })

    openConv = await Conversation.create({
      name: 'Open',
      owner: adminUser._id,
      topic: topic._id,
      enforceMembership: false,
      useRealNames: false,
      enableDMs: [],
      enableAgents: false
    })

    await ConversationMembership.create({
      conversation: enforcedConv._id,
      email: memberUser.email,
      name: 'Test Member',
      userAccount: memberUser._id
    })
  })

  test('admin bypasses the check', async () => {
    await expect(assertMembership(adminUser, enforcedConv)).resolves.toBeUndefined()
  })

  test('passes when conversation does not enforce membership', async () => {
    await expect(assertMembership(nonMemberUser, openConv)).resolves.toBeUndefined()
  })

  test('member passes', async () => {
    await expect(assertMembership(memberUser, enforcedConv)).resolves.toBeUndefined()
  })

  test('non-member throws 403', async () => {
    await expect(assertMembership(nonMemberUser, enforcedConv)).rejects.toMatchObject({ statusCode: 403 })
  })

  test('accepts conversation id string — fetches enforceMembership from DB', async () => {
    await expect(assertMembership(nonMemberUser, enforcedConv._id.toString())).rejects.toMatchObject({
      statusCode: 403
    })
  })
})
