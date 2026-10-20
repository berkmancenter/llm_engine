import setupIntTest from '../../utils/setupIntTest.js'
import authChannels from '../../../src/utils/authChannels.js'
import { Channel, Conversation } from '../../../src/models/index.js'
import { insertUsers, userOne } from '../../fixtures/user.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { publicTopic } from '../../fixtures/conversation.fixture.js'

setupIntTest()

describe('authChannels and a channel named admin', () => {
  let conversation

  beforeEach(async () => {
    await insertUsers([userOne])
    await insertTopics([publicTopic])
    // `admin` is an ordinary channel name: the admin-only socket room is `admin:<conversation>`, which no channel can alias
    const channels = await Channel.insertMany([
      { name: 'general', passcode: null },
      { name: 'admin', passcode: null }
    ])
    conversation = await Conversation.create({
      name: 'Reserved name',
      owner: userOne._id,
      topic: publicTopic._id,
      channels: channels.map((c) => c._id)
    })
  })

  it('lets a channel named admin through like any other channel', async () => {
    await expect(authChannels([{ name: 'admin' }], conversation._id.toString(), userOne)).resolves.toBeUndefined()
    await expect(authChannels([{ name: 'general' }, { name: 'admin' }], conversation, userOne)).resolves.toBeUndefined()
  })

  it('still lets other channels through', async () => {
    await expect(authChannels([{ name: 'general' }], conversation._id.toString(), userOne)).resolves.toBeUndefined()
    await expect(authChannels([{ name: 'general' }], conversation, userOne)).resolves.toBeUndefined()
  })

  it('still rejects an unknown channel as before', async () => {
    await expect(authChannels([{ name: 'nope' }], conversation._id.toString(), userOne)).rejects.toMatchObject({
      statusCode: 400
    })
  })
})
