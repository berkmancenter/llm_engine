import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import conceptCartographer from '../../../src/agents/conceptCartographer/agent.js'
import conceptGraphService from '../../../src/services/conceptGraph/index.js'
import { Agent, Conversation } from '../../../src/models/index.js'
import { insertUsers, userOne } from '../../fixtures/user.fixture.js'
import { insertTopics, newPublicTopic } from '../../fixtures/topic.fixture.js'

setupIntTest()

/* The graph build is a chain of LLM calls covered by the conceptGraph unit tests. These
   check only what the agent decides to do with an event, so the build is stubbed. */
describe('conceptCartographer agent type', () => {
  let agent
  let conversation
  let topic
  let generateSpy: jest.SpyInstance
  let refineSpy: jest.SpyInstance

  beforeEach(async () => {
    await insertUsers([userOne])
    topic = newPublicTopic()
    topic.owner = userOne._id
    await insertTopics([topic])
    conversation = await Conversation.create({
      name: 'Mapped session',
      slug: 'mapped-session',
      owner: userOne._id,
      topic: topic._id
    })
    agent = new Agent({ agentType: 'conceptCartographer', conversation: conversation._id })
    await agent.save()
    await agent.populate({ path: 'conversation', populate: { path: 'topic' } })

    generateSpy = jest.spyOn(conceptGraphService, 'generateConceptGraph').mockResolvedValue(null)
    refineSpy = jest.spyOn(conceptGraphService, 'refineTopicGraph').mockResolvedValue(null)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('ignores events other than the conversation stopping', async () => {
    const responses = await conceptCartographer.onConversationEvent.call(agent, {
      type: 'participantJoined',
      conversationId: conversation._id.toString(),
      userId: userOne._id.toString(),
      name: 'Someone'
    })

    expect(responses).toEqual([])
    expect(generateSpy).not.toHaveBeenCalled()
  })

  it("ignores another conversation's stop", async () => {
    const responses = await conceptCartographer.onConversationEvent.call(agent, {
      type: 'conversationStopped',
      conversationId: new mongoose.Types.ObjectId().toString()
    })

    expect(responses).toEqual([])
    expect(generateSpy).not.toHaveBeenCalled()
  })

  it('maps its own conversation when it stops, then folds the result into the series graph', async () => {
    const built = {
      artifact: { _id: new mongoose.Types.ObjectId() },
      version: { versionNumber: 1 },
      results: [],
      texts: [],
      knownIdentities: []
    }
    generateSpy.mockResolvedValue(built)

    const responses = await conceptCartographer.onConversationEvent.call(agent, {
      type: 'conversationStopped',
      conversationId: conversation._id.toString()
    })

    expect(generateSpy).toHaveBeenCalledWith(conversation._id.toString(), agent)
    expect(refineSpy).toHaveBeenCalledWith(
      topic._id.toString(),
      agent,
      expect.objectContaining({ conversationId: conversation._id.toString() })
    )
    // The event is over, so there is nobody in the chat to post to.
    expect(responses).toEqual([])
  })

  it('leaves the series graph alone when there was nothing to map', async () => {
    await conceptCartographer.onConversationEvent.call(agent, {
      type: 'conversationStopped',
      conversationId: conversation._id.toString()
    })

    expect(generateSpy).toHaveBeenCalled()
    expect(refineSpy).not.toHaveBeenCalled()
  })
})
