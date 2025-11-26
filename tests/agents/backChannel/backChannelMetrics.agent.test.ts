import faker from 'faker'
import mongoose from 'mongoose'
import { Message, Conversation, Agent, Channel } from '../../../src/models/index.js'
import { insertUsers } from '../../fixtures/user.fixture.js'
import { publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import setupAgentTest from '../../utils/setupAgentTest.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('backChannelMetrics')
describe('back channel agent tests', () => {
  let agent
  let conversation
  let footballConversation
  let user1
  let user2
  let user3
  let user4
  async function createUser(pseudonym) {
    return {
      _id: new mongoose.Types.ObjectId(),
      username: faker.name.findName(),
      email: faker.internet.email().toLowerCase(),
      password: 'password1',
      role: 'user',
      isEmailVerified: false,
      pseudonyms: [
        {
          _id: new mongoose.Types.ObjectId(),
          token: '31c5d2b7d2b0f86b2b4b204',
          pseudonym,
          active: 'true'
        }
      ]
    }
  }

  async function addMessageToConversation(msgObj, user) {
    const msg = new Message({
      _id: new mongoose.Types.ObjectId(),
      body: msgObj.body,
      bodyType: msgObj.bodyType,
      conversation: msgObj.conversation,
      owner: user._id,
      pseudonymId: user.pseudonyms[0]._id,
      pseudonym: user.pseudonyms[0].pseudonym,
      channels: msgObj.channels
    })
    await msg.save()
    await conversation.populate('messages')
  }
  async function createMessage(user, body: Record<string, string | boolean>) {
    const msg = {
      body,
      bodyType: 'json',
      conversation,
      pseudonym: user.pseudonyms[0].pseudonym,
      channels: ['participant']
    }
    await addMessageToConversation(msg, user)
  }
  beforeEach(async () => {
    user1 = await createUser('Boring Badger')
    user2 = await createUser('Shady Lawyer')
    user3 = await createUser('Hungry Hippo')
    user4 = await createUser('Sad Llama')

    await insertUsers([user1, user2, user3, user4])
    await insertTopics([publicTopic])

    const channels = await Channel.create([{ name: 'moderator' }, { name: 'participant' }])

    footballConversation = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Is the concussion crisis and CTE the end of the NFL?',
      owner: user1._id,
      topic: publicTopic._id,
      enableAgents: true,
      agents: [],
      messages: [],
      channels
    }
    conversation = new Conversation(footballConversation)
    await conversation.save()
    agent = new Agent({
      agentType: 'backChannelMetrics',
      conversation,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel
    })
    await agent.save()
    await agent.initialize()
    await agent.start()
  })

  it('correctly classifies comments and reports the comments in a given category to the moderator channel', async () => {
    agent.agentConfig = { categories: ['Boredom', 'Inaudible'], reportingThreshold: 2 }

    await createMessage(user1, { text: 'I am Bored', preset: true })
    await createMessage(user2, { text: 'This is boring' })
    await createMessage(user3, { text: 'I do not understand' })
    await createMessage(user4, { text: 'Snooze. Can you move on?' })
    await createMessage(user2, { text: 'Scrolling memes now. Let me know when he talks about something else.' })
    await createMessage(user3, { text: 'Doom scrolling till he moves on.' })
    await createMessage(user3, { text: 'Cannot hear', preset: true })
    await createMessage(user2, { text: 'What did he say?' })
    await createMessage(user4, { text: 'I am Bored', preset: true })
    await createMessage(user2, { text: 'Cannot hear', preset: true })
    await createMessage(user1, { text: 'Cannot hear', preset: true })

    await agent.evaluate()
    const responses = await agent.respond()
    expect(responses).toHaveLength(1)
    // verify message going out to moderator channel
    expect(responses[0].channels).toHaveLength(1)
    expect(responses[0].channels[0].name).toEqual('moderator')
    const response = responses[0].body
    // agent currently configured to check in two minute intervals
    expect(response.timestamp.end - response.timestamp.start).toBeGreaterThanOrEqual(120 * 1000)
    const { metrics } = response
    expect(metrics).toHaveLength(2)

    const boredomMetric = metrics[0].name === 'I am Bored' ? metrics[0] : metrics[1]
    const hearingMetric = metrics[0].name === 'Cannot hear' ? metrics[0] : metrics[1]

    // 5 boredom comments from 4 unique users
    expect(boredomMetric).toEqual(expect.objectContaining({ name: 'I am Bored', value: 2 }))
    expect(boredomMetric.comments).toHaveLength(2)
    expect(boredomMetric.comments).toEqual(
      expect.arrayContaining([{ user: user1.pseudonyms[0].pseudonym, text: 'I am Bored', preset: true }])
    )

    // 2 comments from users who cannot hear
    expect(hearingMetric).toEqual(expect.objectContaining({ name: 'Cannot hear', value: 3 }))
    expect(hearingMetric.comments).toHaveLength(3)
    expect(hearingMetric.comments).toEqual(
      expect.arrayContaining([{ user: user3.pseudonyms[0].pseudonym, text: 'Cannot hear', preset: true }])
    )
  })

  it('does not include metrics with values below the reporting threshold', async () => {
    agent.agentConfig = { categories: ['Confusion'], reportingThreshold: 2 }
    await createMessage(user1, { text: "I'm confused", preset: true })
    await createMessage(user2, { text: 'This is great!', preset: true })
    await createMessage(user3, { text: 'I do not understand' })
    await createMessage(user4, { text: 'That made no sense' })
    await createMessage(user2, { text: "I'm confused", preset: true })

    await agent.evaluate()
    const responses = await agent.respond()
    expect(responses).toHaveLength(1)
    const response = responses[0].body
    // agent currently configured to check in two minute intervals
    expect(response.timestamp.end - response.timestamp.start).toBeGreaterThanOrEqual(120 * 1000)
    const { metrics } = response
    expect(metrics).toHaveLength(1)
  })

  it('does not respond if no metrics are at or above reporting threshold', async () => {
    agent.agentConfig = { categories: ['Enthusiasm'], reportingThreshold: 2 }

    await createMessage(user1, { text: 'This is awesome!', preset: true })
    await createMessage(user2, { text: 'This is boring' })
    await createMessage(user3, { text: 'I do not understand' })

    await agent.evaluate()
    const responses = await agent.respond()
    expect(responses).toHaveLength(0)
  })
  it('does not respond if no messages are found', async () => {
    agent.agentConfig = { categories: ['Enthusiasm'], reportingThreshold: 1 }

    await agent.evaluate()
    const responses = await agent.respond()
    expect(responses).toHaveLength(0)
  })
})
