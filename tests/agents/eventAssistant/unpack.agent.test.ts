import mongoose from 'mongoose'
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createPublicTopic,
  createUser,
  createEventAssistantConversation,
  createDirectMessage,
  createMessage,
  prepareMessagesForAgent
} from '../../utils/agentTestHelpers.js'
import Conversation from '../../../src/models/conversation.model.js'
import UnpackRequest from '../../../src/models/unpackRequest.model.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('eventAssistant')

const SECOND = 1000

describe('Event Assistant unpacks the last minute of the talk', () => {
  let user
  let agent
  let conversation

  beforeEach(async () => {
    user = await createUser('Curious Badger')
    const topic = await createPublicTopic()
    conversation = await createEventAssistantConversation(
      {
        name: 'Building Reliable Distributed Systems',
        description: 'How engineering teams keep large services running.'
      },
      user,
      topic,
      new Date(Date.now() - 15 * 60 * SECOND),
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    await Conversation.findByIdAndUpdate(conversation._id, { features: [{ name: 'unpacker', enabled: true }] })
    ;[agent] = conversation.agents
  })

  it('explains only the last minute, in plain language, and names the specialist terms', async () => {
    const now = Date.now()
    const said = (body: string, secondsAgo: number) =>
      createMessage(body, user, conversation, ['transcript'], new Date(now - secondsAgo * SECOND))
    const request = {
      ...(await createDirectMessage(
        { type: 'unpack_request', mode: 'lastMinute', text: 'Unpack the last minute' },
        user,
        conversation,
        new Date(now)
      )),
      // the helper leaves IDs to the database, but a real request always arrives with one
      _id: new mongoose.Types.ObjectId()
    }
    await prepareMessagesForAgent(
      [
        await said('Before we start, the pizza for lunch is in the back of the room.', 5 * 60),
        await said('Every team here sets an SLO for each service it runs.', 50),
        await said('If you burn through your error budget, feature work stops until reliability recovers.', 35),
        await said('That tradeoff is the heart of how SRE teams negotiate with product managers.', 20),
        request
      ],
      conversation,
      agent
    )

    const [reply] = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [] }, request)

    expect(reply.message.type).toBe('unpack_explanation')
    expect(reply.message.chunkIds).toHaveLength(3)
    expect(reply.message.quote).not.toMatch(/pizza/i)
    expect(reply.message.whatTheyreSaying.length).toBeGreaterThan(0)
    expect(reply.message.whyItMatters.length).toBeGreaterThan(0)
    expect(reply.message.text).not.toMatch(/pizza/i)
    const termNames = reply.message.terms.map(({ term }) => term).join(' ')
    expect(termNames).toMatch(/SLO|error budget|SRE/i)
    expect(await UnpackRequest.countDocuments({ conversation: conversation._id, user: user._id })).toBe(1)
  })
})
