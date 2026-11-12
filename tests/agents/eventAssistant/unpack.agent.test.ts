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
import { getModelChat } from '../../../src/agents/helpers/getModelChat.js'
import { buildPassage, explainPassage } from '../../../src/agents/helpers/unpackPassage.js'

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

describe('Event Assistant explains a passage a participant highlighted', () => {
  const chunkAt = (body: string, secondsAgo: number) => ({
    _id: new mongoose.Types.ObjectId(),
    body,
    createdAt: new Date(Date.now() - secondsAgo * SECOND)
  })

  async function explain(chunk, words: string, { before = '', after = '' } = {}) {
    const start = chunk.body.indexOf(words)
    const passage = buildPassage([chunk], {
      startMessageId: chunk._id.toString(),
      startOffset: start,
      endMessageId: chunk._id.toString(),
      endOffset: start + words.length
    })
    const llm = await getModelChat(testConfig.llmPlatform, testConfig.llmModel, { maxTokens: 1000 })
    const sections = await explainPassage(llm, { topic: 'Building Reliable Distributed Systems', passage, before, after })
    return { passage, sections }
  }

  it('explains only the widened passage, names its terms, and writes a headline', async () => {
    const chunk = chunkAt(
      'If you burn through your error budget, feature work stops until reliability recovers. Lunch is at noon.',
      40
    )

    const { passage, sections } = await explain(chunk, 'burn through', {
      before: '[10:41:02 AM] Every team here sets an SLO for each service it runs.',
      after: '[10:42:30 AM] That tradeoff is how SRE teams negotiate with product managers.'
    })

    expect(passage.quote).toBe('If you burn through your error budget, feature work stops until reliability recovers.')
    expect(sections.whatTheyreSaying.length).toBeGreaterThan(0)
    expect(sections.whatTheyreSaying.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(3)
    expect(sections.whyItMatters.length).toBeGreaterThan(0)
    expect(`${sections.whatTheyreSaying} ${sections.whyItMatters}`).not.toMatch(/lunch|noon/i)
    expect(sections.terms.length).toBeLessThanOrEqual(3)
    expect(sections.terms.map(({ term }) => term).join(' ')).toMatch(/error budget/i)
    expect(sections.headline.length).toBeGreaterThan(0)
    expect(sections.headline.split(/\s+/).length).toBeLessThanOrEqual(15)
  })

  it('leaves out a visual for a definition', async () => {
    const definition = chunkAt('An SLO is simply the reliability target a team promises for a service.', 20)

    const { sections } = await explain(definition, 'reliability target')

    expect(sections.visual).toBeNull()
  })

  it('gives a drawable visual, with alt text and a caption, for a trend over time', async () => {
    const trend = chunkAt(
      'Our outage minutes fell from 400 in 2021 to 250 in 2022, then 90 in 2023, and just 20 last year.',
      20
    )

    const { sections } = await explain(trend, 'fell from 400')

    expect(sections.visual).not.toBeNull()
    expect(sections.visual!.description.length).toBeGreaterThan(0)
    expect(sections.visual!.altText.length).toBeGreaterThan(0)
    expect(sections.visual!.caption.length).toBeGreaterThan(0)
  })
})
