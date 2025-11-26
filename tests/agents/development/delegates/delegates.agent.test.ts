import faker from 'faker'
import mongoose from 'mongoose'
import path from 'path'
import { Conversation, Agent } from '../../../../src/models/index.js'
import { insertUsers } from '../../../fixtures/user.fixture.js'
import { publicTopic } from '../../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../../fixtures/topic.fixture.js'
import websocketGateway from '../../../../src/websockets/websocketGateway.js'
import setupAgentTest from '../../../utils/setupAgentTest.js'
import rag from '../../../../src/agents/helpers/rag.js'

jest.setTimeout(120000)

const participantsPerRound = 2

const testConfig = setupAgentTest('delegates')
describe('delegate agent tests', () => {
  let agent
  let conversation
  let user

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

  beforeEach(async () => {
    user = await createUser('Test User')
    await insertUsers([user])
    await insertTopics([publicTopic])

    conversation = new Conversation({
      name: 'Exploring the book "The Line: AI and the Future of Personhood" by James Boyle',
      owner: user._id,
      topic: publicTopic._id,
      enableAgents: true,
      agents: [],
      messages: []
    })
    await conversation.save()
    agent = new Agent({
      agentType: 'delegates',
      agentConfig: {
        expertRAGFiles: ['the_line.pdf', 'foucault_in_cyberspace.pdf', 'the_public_domain.pdf'],
        delegateRAGFiles: ['the_line.pdf'],
        participantsPerRound,
        delegates: [
          {
            personality: 'You are a wealthy woman from San Francisco who thinks AI will be great for humanity.',
            interest: "Why do so many people think AI will be dangerous? I don't understand their concerns.",
            pseudonym: 'Pro AI Urban Woman',
            question: "Why do so many people think AI will be dangerous? I don't understand their concerns."
          },
          {
            personality:
              'You are a working class man from Omaha, Nebraska who recently watch the movie "The Terminator" and are concerned about AI controlled robots taking over our world.',
            interest: 'Why are not more people concerned about AI controlled robots?',
            pseudonym: 'Anti AI Rural Man',
            question: 'Why are so few people concerned about AI controlled robots?'
          },
          {
            personality:
              "You are a college student curious about tech who has had recent good experiences using OpenAI to help with your paper writing. But you also don't trust the big tech companies.",
            interest:
              "I like what I see AI can do for me. Why can't government properly regulate AI companies to make sure nothing bad happens?",
            pseudonym: 'AI Curious College Student',
            question:
              "I like what I see AI can do for me. Why can't government properly regulate AI companies to make sure nothing bad happens?"
          },
          {
            personality: 'You are an upper middle class man from Michigan who does not really care about AI.',
            interest: 'What can AI even do for me? What are people so excited about it?',
            pseudonym: 'AI Agnostic',
            question: 'What can AI even do for me? What are people so excited about it?'
          },
          {
            personality: 'You are a broke college student who is just attending this event for the free food.',
            interest: 'Pizza',
            pseudonym: 'Party Crasher'
          }
        ]
      },
      conversation,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel
    })
    await agent.save()
    conversation.agents.push(agent)
    await conversation.save()
    // Load the smallest doc in just to make sure RAG integration works
    const metadataFn = (doc) => ({
      ...doc,
      metadata: {
        pdf: 'foucault_in_cyberspace.pdf',
        pageNumber: doc.metadata.loc.pageNumber,
        lineFrom: doc.metadata.loc.lines.from,
        lineTo: doc.metadata.loc.lines.to,
        citation:
          'Boyle, J. (1997) Foucault in Cyberspace: Surveillance, Sovereignty, and Hardwired Censors. University of Cincinnati Law Review 66 (1), 177-205.',
        shortCitation: 'Foucault in Cyberspace'
      }
    })
    await rag.addPDFToVectorStore(
      'boyle',
      path.join('rag_documents', 'boyle_line', 'foucault_in_cyberspace.pdf'),
      metadataFn
    )
  })

  afterEach(async () => {
    jest.clearAllMocks()
  })

  it('should generate an intro message and the correct number of rounds of responses', async () => {
    const broadcastVoteSpy = jest.spyOn(websocketGateway, 'broadcastNewVote').mockResolvedValue()
    const broadcastMsgSpy = jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()

    // activate
    await agent.start()
    await agent.respond()

    await conversation.populate('messages')
    const agentMessages = conversation.messages.filter((msg) => msg.fromAgent && msg.visible)
    /**
     * 0 Intro Message
     * 1,8,15,22 Round Started
     * 2,9,16,23 Question
     * 3,10,17,24 Boyle Response
     * 4,11,18,25 Boyle Q
     * 5-6,12-13,19-20,26-27 discussion
     * 7,14,21,28 Round ended
     * 29 Concluding message
     */
    // We should only have four rounds and not five b/c Party Crasher did not have a question
    expect(agentMessages).toHaveLength(30)

    // verify all four users with questions asked them (no repeats)
    expect(
      new Set([
        agentMessages[2].pseudonym,
        agentMessages[9].pseudonym,
        agentMessages[16].pseudonym,
        agentMessages[23].pseudonym
      ]).size
    ).toBe(4)

    // verify first five messages were from five unique users - everyone should get to go before repeats occur
    expect(
      new Set([
        agentMessages[5].pseudonym,
        agentMessages[6].pseudonym,
        agentMessages[12].pseudonym,
        agentMessages[13].pseudonym,
        agentMessages[19].pseudonym
      ]).size
    ).toBe(5)

    // verify no repeat users in rounds after everyone has gone
    expect(agentMessages[19].pseudonym).not.toEqual(agentMessages[20].pseudonym)
    expect(agentMessages[26].pseudonym).not.toEqual(agentMessages[27].pseudonym)

    // verify Anti AI Rural Man's transformed question was used, not his interest
    expect(
      agentMessages.find(
        (msg) =>
          msg.pseudonym === 'Anti AI Rural Man' && msg.body === 'Why are so few people concerned about AI controlled robots?'
      )
    ).toBeDefined()
    expect(broadcastVoteSpy).toHaveBeenCalled()
    expect(broadcastMsgSpy).toHaveBeenCalledTimes(29)
    // TODO verify upvotes, more participant selection tests
  })
})
