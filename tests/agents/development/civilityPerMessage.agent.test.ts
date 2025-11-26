import faker from 'faker'
import mongoose from 'mongoose'
import { Conversation, Agent } from '../../../src/models/index.js'
import { insertUsers } from '../../fixtures/user.fixture.js'
import { publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { AgentMessageActions } from '../../../src/types/index.types.js'
import setupAgentTest from '../../utils/setupAgentTest.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('civilityPerMessage')
describe('civility agent tests', () => {
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

  async function checkOkResponseEvaluation(evaluation) {
    expect(evaluation).toEqual(expect.objectContaining({ action: AgentMessageActions.OK, userContributionVisible: true }))
  }

  async function checkRejectResponseEvaluation(evaluation, msg) {
    expect(evaluation).toEqual(
      expect.objectContaining({
        action: AgentMessageActions.REJECT,
        userContributionVisible: true,
        suggestion: expect.stringMatching(/^@Strange Fellow:\s.+/),
        contribution: undefined,
        userMessage: msg
      })
    )
  }

  beforeEach(async () => {
    user1 = await createUser('Strange Fellow')

    await insertUsers([user1])
    await insertTopics([publicTopic])

    conversationData = {
      _id: new mongoose.Types.ObjectId(),
      name: 'What are you thinking about today?',
      owner: user1._id,
      topic: publicTopic._id,
      enableAgents: true,
      agents: [],
      messages: []
    }
    conversation = new Conversation(conversationData)
    await conversation.save()
    agent = new Agent({
      agentType: 'civilityPerMessage',
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

  it('should allow civil messages', async () => {
    const msg1 = await createMessage(user1, "How are y'all doing?")
    await checkOkResponseEvaluation(await agent.evaluate(msg1))
  })

  it('should prevent profanity', async () => {
    const msg1 = await createMessage(user1, 'Asshole')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  it('should prevent profanity with missing characters', async () => {
    const msg1 = await createMessage(user1, 'F you')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  it('should prevent profanity with placeholder characters', async () => {
    const msg1 = await createMessage(user1, 'A$$hole')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  it('should prevent personal attacks', async () => {
    const msg1 = await createMessage(user1, 'John is stupid')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  it('should prevent religious based harassment', async () => {
    const msg1 = await createMessage(user1, 'Christians are always causing problems')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  it('should prevent sexuality based harassment', async () => {
    const msg1 = await createMessage(user1, 'Gay people are always causing problems')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  it('should prevent gender based harassment', async () => {
    const msg1 = await createMessage(user1, 'Men are always causing problems')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  it('should prevent age based harassment', async () => {
    const msg1 = await createMessage(user1, 'Old people are always causing problems')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  it('should prevent race based harassment', async () => {
    const msg1 = await createMessage(user1, 'White people are always causing problems')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  it('should prevent disability based harassment', async () => {
    const msg1 = await createMessage(user1, 'Disabled people are always causing problems')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  it('should prevent citizenship based harassment', async () => {
    const msg1 = await createMessage(user1, 'Americans are always causing problems')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  it('should prevent marital status based harassment', async () => {
    const msg1 = await createMessage(user1, 'Single people are always causing problems')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  // TODO: Check on this

  // it('should prevent speaking for others', async () => {
  //
  //   const msg1 = await createMessage(user1, 'I know John agrees with me')
  //   await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  // })

  it('should prevent group attacks', async () => {
    const msg1 = await createMessage(user1, 'You are all so dumb')
    await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  })

  // TODO: Check on this

  // it('should prevent unspecific emotional outbursts', async () => {
  //
  //   const msg1 = await createMessage(user1, 'I am so angry!')
  //   await checkRejectResponseEvaluation(await agent.evaluate(msg1), msg1)
  // })

  it('should allow specific expression of emotion: frustration', async () => {
    const msg1 = await createMessage(
      user1,
      'I am frustrated because no one has acknowledged the point I was making about the connection between immigration and the impact on social services'
    )
    await checkOkResponseEvaluation(await agent.evaluate(msg1))
  })

  it('should allow specific expression of emotion :upset', async () => {
    const msg1 = await createMessage(
      user1,
      'This conversation is making me upset because none of your responses address what I have stated I consider to be the central topic: gender-based inequalities. Can you please comment on that?'
    )
    await checkOkResponseEvaluation(await agent.evaluate(msg1))
  })

  it('should allow specific expression of emotion :sadness', async () => {
    const msg1 = await createMessage(user1, 'I am saddened when I hear that the group has opposed my proposal')
    await checkOkResponseEvaluation(await agent.evaluate(msg1))
  })

  it('should allow I statements: variant 1', async () => {
    const msg1 = await createMessage(
      user1,
      'I feel upset when I hear about people who do not pay taxes being able to receive social benefits'
    )
    await checkOkResponseEvaluation(await agent.evaluate(msg1))
  })

  it('should allow I statements: variant 2', async () => {
    const msg1 = await createMessage(
      user1,
      'When I hear about people who do not pay taxes being able to receive social benefits I feel upset'
    )
    await checkOkResponseEvaluation(await agent.evaluate(msg1))
  })

  it('should allow nuanced reference to protected groups: A', async () => {
    const msg1 = await createMessage(
      user1,
      'As a young person, I would like to know if people over 60 understand how they are perceived by younger people'
    )
    await checkOkResponseEvaluation(await agent.evaluate(msg1))
  })

  it('should allow nuanced reference to protected groups: B', async () => {
    const msg1 = await createMessage(
      user1,
      'As a young person, I can tell you that many young people are frustrated by what appears to be a lack of concern for the experiences of young people like me'
    )
    await checkOkResponseEvaluation(await agent.evaluate(msg1))
  })

  it('should allow nuanced statements on complex topics', async () => {
    const msg1 = await createMessage(
      user1,
      'I am concerned about unfettered immigration because of the load it could create on social services'
    )
    await checkOkResponseEvaluation(await agent.evaluate(msg1))
  })
})
