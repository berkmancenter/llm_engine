import { Conversation, Agent, Message } from '../../../src/models/index.js'
import agentHandlers from '../../../src/jobs/handlers/agent.js'
import { setAgentTypes } from '../../../src/models/user.model/agent.model/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../../src/agents/helpers/getModelChat.js'
import messageService from '../../../src/services/message.service.js'
import setupIntTest from '../../utils/setupIntTest.js'
import { seedHideScenario, insertMessage, conversationOne } from '../../fixtures/messageHide.fixture.js'

setupIntTest()

/* The agent job carries the message as it was when posted. A message hidden after that (the queue can be
   backlogged) must not reach respond() - and so no LLM call, intent classifier included - nor get a reply. */
describe('agentResponse job and messages hidden after they were posted', () => {
  let scenario
  let agent
  let respondSpy
  let newMessageSpy

  const runJob = async (message) => {
    // the job payload is the snapshot taken at post time
    const snapshot = message.toObject()
    await agentHandlers.agentResponse({ attrs: { data: { agentId: agent._id, message: snapshot } } })
  }

  beforeAll(() => {
    setAgentTypes({
      perMessage: {
        respond: jest.fn(),
        evaluate: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
        name: 'Test Agent',
        description: 'test',
        maxTokens: 2000,
        defaultTriggers: {},
        priority: 10,
        llmTemplateVars: {},
        defaultLLMTemplates: {},
        defaultLLMPlatform,
        defaultLLMModel
      }
    })
  })

  beforeEach(async () => {
    jest.restoreAllMocks()
    scenario = await seedHideScenario()
    agent = await new Agent({ agentType: 'perMessage', conversation: conversationOne._id, active: true }).save()
    respondSpy = jest
      .spyOn(Agent.prototype, 'respond')
      .mockResolvedValue([{ visible: true, message: 'reply', messageType: 'text', channels: [] }])
    newMessageSpy = jest.spyOn(messageService, 'newMessageHandler').mockResolvedValue([])
  })

  test('a message that is not hidden is still answered', async () => {
    await runJob(scenario.otherMsg)
    expect(respondSpy).toHaveBeenCalledTimes(1)
    expect(newMessageSpy).toHaveBeenCalledTimes(1)
  })

  test('a message hidden between enqueue and processing gets no respond() call and no reply', async () => {
    const snapshotSource = scenario.otherMsg
    await Message.updateOne({ _id: snapshotSource._id }, { hiddenByAdmin: true })
    await runJob(snapshotSource)
    expect(respondSpy).not.toHaveBeenCalled()
    expect(newMessageSpy).not.toHaveBeenCalled()
  })

  test('a later message by an author hidden after it was posted is skipped', async () => {
    const later = await insertMessage(scenario.author, await Conversation.findById(conversationOne._id))
    await Conversation.updateOne({ _id: conversationOne._id }, { hiddenAuthors: [scenario.author._id] })
    await runJob(later)
    expect(respondSpy).not.toHaveBeenCalled()
    expect(newMessageSpy).not.toHaveBeenCalled()
  })

  test('a reply to a message hidden after the reply was posted is skipped', async () => {
    await Message.updateOne({ _id: scenario.authorMsg._id }, { hiddenByAdmin: true })
    await runJob(scenario.reply)
    expect(respondSpy).not.toHaveBeenCalled()
    expect(newMessageSpy).not.toHaveBeenCalled()
  })

  test('hiding does not apply outside the chat channel', async () => {
    const dm = await insertMessage(scenario.other, await Conversation.findById(conversationOne._id), {
      channels: ['assistant'],
      hiddenByAdmin: true
    })
    await runJob(dm)
    expect(respondSpy).toHaveBeenCalledTimes(1)
  })
})
