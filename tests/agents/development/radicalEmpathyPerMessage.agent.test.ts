import faker from 'faker'
import mongoose from 'mongoose'
import { Conversation, Agent } from '../../../src/models/index.js'
import { insertUsers } from '../../fixtures/user.fixture.js'
import { publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { AgentMessageActions } from '../../../src/types/index.types.js'
import setupAgentTest from '../../utils/setupAgentTest.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('radicalEmpathyPerMessage')
describe('radicalEmpathyPerMessage agent tests', () => {
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
      name: 'Test Radical Empathy Conversation Topic',
      owner: user1._id,
      topic: publicTopic._id,
      enableAgents: true,
      agents: [],
      messages: []
    }
    conversation = new Conversation(conversationData)
    await conversation.save()
    agent = new Agent({
      agentType: 'radicalEmpathyPerMessage',
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

  it('should evaluate a message for empathy and return OK for appropriate messages', async () => {
    const msg1 = await createMessage(user1, 'I understand your perspective and appreciate you sharing that.')

    // This should trigger the agent to evaluate the message
    const evaluation = await agent.evaluate(msg1)
    expect(evaluation.action).toBe(AgentMessageActions.OK)
    expect(evaluation.userContributionVisible).toBe(true)
    expect(evaluation.suggestion).toBe('OK')
  })

  it('should evaluate a message and suggest improvements for potentially problematic messages', async () => {
    const msg1 = await createMessage(user1, 'That is a stupid idea.')

    // This should trigger the agent to reject the message and provide a suggestion
    const evaluation = await agent.evaluate(msg1)
    expect(evaluation.action).toBe(AgentMessageActions.REJECT)
    expect(evaluation.userContributionVisible).toBe(true)
    expect(evaluation.suggestion).toBeDefined()
    expect(evaluation.suggestion).not.toBe('OK')
    expect(evaluation.suggestion).toContain('@') // Should contain @ mention
  })
})
