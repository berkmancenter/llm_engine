import faker from 'faker'
import mongoose from 'mongoose'
import { Conversation, Agent } from '../../../src/models/index.js'
import { insertUsers } from '../../fixtures/user.fixture.js'
import { publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { AgentMessageActions } from '../../../src/types/index.types.js'
import setupAgentTest from '../../utils/setupAgentTest.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('playfulPerMessage')
describe('playfulPerMessage agent tests', () => {
  let agent
  let conversation
  let conversationData
  let user1

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
          token:
            '31c5d2b7d2b0f86b2b4b204ed4bf17938e4108a573b25db493a55c4639cc6cd3518a4c88787fe29cf9f273d61e3c5fd4eabb528e3e9b7398c1ed0944581ce51e53f6eae13328c4be05e7e14365063409',
          pseudonym,
          active: 'true'
        }
      ]
    }
  }

  async function createMessage(user, body) {
    return {
      body,
      pseudonym: user.pseudonyms[0].pseudonym
    }
  }

  beforeEach(async () => {
    user1 = await createUser('Test User')

    await insertUsers([user1])
    await insertTopics([publicTopic])

    conversationData = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Test Conversation Topic',
      owner: user1._id,
      topic: publicTopic._id,
      enableAgents: true,
      agents: [],
      messages: []
    }
    conversation = new Conversation(conversationData)
    await conversation.save()
    agent = new Agent({
      agentType: 'playfulPerMessage',
      conversation,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel
    })
    await agent.save()
    await agent.initialize()
    await agent.start()
  })

  afterEach(async () => {
    jest.clearAllMocks()
  })

  it('should respond to a direct message', async () => {
    const msg1 = await createMessage(user1, 'Hello everyone!')

    const evaluation = await agent.evaluate(msg1)
    expect(evaluation.action).toBe(AgentMessageActions.CONTRIBUTE)
    expect(evaluation.userContributionVisible).toBe(true)

    const responses = await agent.respond(msg1)
    expect(responses).toHaveLength(1)
    expect(responses[0].visible).toBe(true)
    expect(responses[0].body).toBeDefined()
    expect(responses[0].body).toContain('@')
  })
})
