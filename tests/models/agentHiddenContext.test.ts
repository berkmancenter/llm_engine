/* eslint-disable @typescript-eslint/no-explicit-any */
import setupIntTest from '../utils/setupIntTest.js'
import { Agent, Conversation, Message } from '../../src/models/index.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'
import { insertMessage, seedHideScenario, conversationOne } from '../fixtures/messageHide.fixture.js'

jest.setTimeout(120000)

const mockEvaluate = jest.fn()
const mockRespond = jest.fn()

const testAgentTypes = {
  ctxAgent: {
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: jest.fn(),
    stop: jest.fn(),
    name: 'Hidden context agent',
    description: 'Records what history it is handed',
    maxTokens: 2000,
    defaultTriggers: { perMessage: {} },
    priority: 10,
    llmTemplateVars: {},
    llmTemplates: {},
    defaultLLMPlatform,
    defaultLLMModel,
    defaultConversationHistorySettings: { count: 50 }
  }
}

setupIntTest()

let s: Awaited<ReturnType<typeof seedHideScenario>>
let agent: any
let trigger: any

beforeAll(() => {
  setAgentTypes(testAgentTypes as any)
})
afterAll(() => {
  setAgentTypes(defaultAgentTypes)
})

beforeEach(async () => {
  s = await seedHideScenario()
  await Conversation.updateOne({ _id: conversationOne._id }, { enableAgents: true })
  const conversation = await Conversation.findById(conversationOne._id)
  agent = await Agent.create({ agentType: 'ctxAgent', conversation, active: true })
  trigger = await insertMessage(s.other, conversationOne, { body: 'the message being answered' })
  mockEvaluate.mockResolvedValue({
    userMessage: trigger,
    action: 'OK',
    agentContributionVisible: true,
    userContributionVisible: true,
    suggestion: undefined
  })
  mockRespond.mockResolvedValue([])
})
afterEach(() => {
  jest.clearAllMocks()
})

const hideSingle = () => Message.updateOne({ _id: s.authorMsg._id }, { hiddenByAdmin: true })
const hideAuthor = () => Conversation.updateOne({ _id: conversationOne._id }, { $addToSet: { hiddenAuthors: s.author._id } })

const respondedWith = async () => {
  await agent.respond(trigger)
  expect(mockRespond).toHaveBeenCalledTimes(1)
  return mockRespond.mock.calls[0][0].messages.map((m) => m._id.toString())
}
const evaluatedWith = async () => {
  await agent.populate('conversation')
  await agent.evaluate(trigger)
  return agent.conversation.messages.map((m) => m._id.toString())
}

describe('agent context excludes hidden messages', () => {
  it('respond() hands the agent every visible message when nothing is hidden', async () => {
    expect(await respondedWith()).toEqual(
      expect.arrayContaining([s.authorMsg._id.toString(), s.reply._id.toString(), s.otherMsg._id.toString()])
    )
  })

  it('evaluate() loads every visible message when nothing is hidden', async () => {
    expect(await evaluatedWith()).toEqual(
      expect.arrayContaining([s.authorMsg._id.toString(), s.reply._id.toString(), s.otherMsg._id.toString()])
    )
  })

  it.each([
    ['a message hidden on its own', hideSingle],
    ['a hidden author', hideAuthor]
  ])('respond() leaves out %s and the reply under it, but keeps the rest', async (_name, hide) => {
    await hide()
    const seen = await respondedWith()
    expect(seen).not.toContain(s.authorMsg._id.toString())
    expect(seen).not.toContain(s.reply._id.toString())
    expect(seen).toEqual(expect.arrayContaining([s.otherMsg._id.toString()]))
  })

  it.each([
    ['a message hidden on its own', hideSingle],
    ['a hidden author', hideAuthor]
  ])('evaluate() leaves out %s and the reply under it, but keeps the rest', async (_name, hide) => {
    await hide()
    const seen = await evaluatedWith()
    expect(seen).not.toContain(s.authorMsg._id.toString())
    expect(seen).not.toContain(s.reply._id.toString())
    expect(seen).toEqual(expect.arrayContaining([s.otherMsg._id.toString()]))
  })

  it('never puts hidden message text into the context respond() hands the agent, but keeps the visible control', async () => {
    await Message.updateOne({ _id: s.authorMsg._id }, { body: 'CANARY-AUTHOR hidden author words' })
    await Message.updateOne({ _id: s.reply._id }, { body: 'CANARY-REPLY under the hidden author' })
    await Message.updateOne({ _id: s.otherMsg._id }, { body: 'CONTROL-VISIBLE words' })
    const flagged = await insertMessage(s.other, conversationOne, { body: 'CANARY-FLAGGED words', hiddenByAdmin: true })
    await insertMessage(s.other, conversationOne, { body: 'CANARY-REPLY under flagged', parentMessage: flagged._id })
    await hideAuthor()

    await agent.respond(trigger)

    const bodies = mockRespond.mock.calls[0][0].messages.map((m) => m.body).join('\n')
    expect(bodies).not.toContain('CANARY')
    expect(bodies).toContain('CONTROL-VISIBLE')
  })

  it("keeps a hidden author's assistant-channel messages in respond() and evaluate() context", async () => {
    const inAssistant = await insertMessage(s.author, conversationOne, { channels: ['assistant'], body: 'private ask' })
    await hideAuthor()
    // the agent's history follows the channel of the message it answers
    trigger = await insertMessage(s.author, conversationOne, { channels: ['assistant'], body: 'the private question' })

    expect(await respondedWith()).toContain(inAssistant._id.toString())
    expect(await evaluatedWith()).toContain(inAssistant._id.toString())
  })
})
