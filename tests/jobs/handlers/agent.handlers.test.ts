import mongoose from 'mongoose'
import { Conversation, Agent, Message } from '../../../src/models/index.js'
import { publicTopic, conversationAgentsEnabled } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { insertUsers, registeredUser } from '../../fixtures/user.fixture.js'
import agentHandlers from '../../../src/jobs/handlers/agent.js'
import { setAgentTypes } from '../../../src/models/user.model/agent.model/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../../src/agents/helpers/getModelChat.js'
import messageService from '../../../src/services/message.service.js'
import resourceService from '../../../src/services/resource.service.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import setupIntTest from '../../utils/setupIntTest.js'

setupIntTest()

const mockStart = jest.fn()
const mockStop = jest.fn()

const testAgentTypes = {
  periodic: {
    respond: jest.fn(),
    evaluate: jest.fn(),
    start: mockStart,
    stop: mockStop,
    name: 'Test Periodic Agent',
    description: 'A periodic test agent',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 300 } },
    priority: 10,
    llmTemplateVars: {},
    defaultLLMTemplates: {},
    defaultLLMPlatform,
    defaultLLMModel
  }
}

describe('agent job handlers', () => {
  let conversation
  let agent

  beforeAll(() => {
    setAgentTypes(testAgentTypes)
  })

  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])
    conversation = new Conversation({ ...conversationAgentsEnabled, active: true })
    await conversation.save()
    agent = new Agent({ agentType: 'periodic', conversation: conversation._id, active: true })
    await agent.save()
    conversation.agents.push(agent)
    await conversation.save()
    jest.restoreAllMocks()
    jest.spyOn(websocketGateway, 'broadcastResourcesUpdated').mockResolvedValue()
  })

  describe('agentResponse', () => {
    test('should not throw if agent not found', async () => {
      const fakeId = new mongoose.Types.ObjectId()
      await expect(agentHandlers.agentResponse({ attrs: { data: { agentId: fakeId, message: {} } } })).resolves.not.toThrow()
    })

    test('should call newMessageHandler for a standard agent response', async () => {
      const mockResponse = { visible: true, message: 'Hello from agent', messageType: 'text', channels: [] }
      jest.spyOn(Agent.prototype, 'respond').mockResolvedValue([mockResponse])
      const newMessageSpy = jest.spyOn(messageService, 'newMessageHandler').mockResolvedValue([])

      await agentHandlers.agentResponse({ attrs: { data: { agentId: agent._id, message: {} } } })

      expect(newMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Hello from agent', fromAgent: true, visible: true }),
        expect.anything()
      )
    })

    test('should call resourceService.addResources for a resources response', async () => {
      const resources = [{ source: 'ai', title: 'Test Paper', category: 'suggested', participantVisible: true }]
      jest
        .spyOn(Agent.prototype, 'respond')
        .mockResolvedValue([{ visible: false, message: resources, messageType: 'resources' }])
      const addResourcesSpy = jest.spyOn(resourceService, 'addResources').mockResolvedValue(undefined)

      await agentHandlers.agentResponse({ attrs: { data: { agentId: agent._id, message: {} } } })

      expect(addResourcesSpy).toHaveBeenCalledWith(resources, conversation._id.toString())
    })

    test('should persist resources to conversation when agent returns resources response', async () => {
      const resources = [{ source: 'ai', title: 'AI Recommended Paper', category: 'suggested', participantVisible: true }]
      jest
        .spyOn(Agent.prototype, 'respond')
        .mockResolvedValue([{ visible: false, message: resources, messageType: 'resources' }])

      await agentHandlers.agentResponse({ attrs: { data: { agentId: agent._id, message: {} } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.resources).toHaveLength(1)
      expect(updated!.resources[0].title).toBe('AI Recommended Paper')
      expect(updated!.resources[0].source).toBe('ai')
    })

    test('should not call newMessageHandler for a resources response', async () => {
      const resources = [{ source: 'ai', title: 'Paper', category: 'suggested', participantVisible: true }]
      jest
        .spyOn(Agent.prototype, 'respond')
        .mockResolvedValue([{ visible: false, message: resources, messageType: 'resources' }])
      const newMessageSpy = jest.spyOn(messageService, 'newMessageHandler').mockResolvedValue([])

      await agentHandlers.agentResponse({ attrs: { data: { agentId: agent._id, message: {} } } })

      expect(newMessageSpy).not.toHaveBeenCalled()
    })

    test('should not throw if agent respond fails', async () => {
      jest.spyOn(Agent.prototype, 'respond').mockRejectedValue(new Error('LLM failed'))

      await expect(
        agentHandlers.agentResponse({ attrs: { data: { agentId: agent._id, message: {} } } })
      ).resolves.not.toThrow()
    })

    /* Simulates a from-scratch retry after a mid-job kill: agenda would re-invoke this exact
       handler with the same job data once the original attempt's lock expires. Without the
       claimResponseTrigger guard, this would call respond() (a real LLM call) and post a
       second message for the same triggering message. */
    test('should not call respond a second time for the same triggering message', async () => {
      const mockResponse = { visible: true, message: 'Hello from agent', messageType: 'text', channels: [] }
      const respondSpy = jest.spyOn(Agent.prototype, 'respond').mockResolvedValue([mockResponse])
      const newMessageSpy = jest.spyOn(messageService, 'newMessageHandler').mockResolvedValue([])
      const message = { _id: new mongoose.Types.ObjectId() }

      await agentHandlers.agentResponse({ attrs: { data: { agentId: agent._id, message } } })
      await agentHandlers.agentResponse({ attrs: { data: { agentId: agent._id, message } } })

      expect(respondSpy).toHaveBeenCalledTimes(1)
      expect(newMessageSpy).toHaveBeenCalledTimes(1)
    })

    test('should still respond to a different triggering message from the same agent', async () => {
      const mockResponse = { visible: true, message: 'Hello from agent', messageType: 'text', channels: [] }
      const respondSpy = jest.spyOn(Agent.prototype, 'respond').mockResolvedValue([mockResponse])
      jest.spyOn(messageService, 'newMessageHandler').mockResolvedValue([])

      await agentHandlers.agentResponse({
        attrs: { data: { agentId: agent._id, message: { _id: new mongoose.Types.ObjectId() } } }
      })
      await agentHandlers.agentResponse({
        attrs: { data: { agentId: agent._id, message: { _id: new mongoose.Types.ObjectId() } } }
      })

      expect(respondSpy).toHaveBeenCalledTimes(2)
    })

    /* The triggerless call site (agentService.startAgent, for manual-trigger agents at
       conversation start) has no message id, so it claims a synthetic per-conversation key
       instead — this must be just as retry-safe. */
    test('should not call respond a second time for the triggerless conversation-start case', async () => {
      const respondSpy = jest.spyOn(Agent.prototype, 'respond').mockResolvedValue([])

      await agentHandlers.agentResponse({ attrs: { data: { agentId: agent._id } } })
      await agentHandlers.agentResponse({ attrs: { data: { agentId: agent._id } } })

      expect(respondSpy).toHaveBeenCalledTimes(1)
    })

    test('populates only the conversation ref, not a duplicate messages/channels lookup', async () => {
      jest.spyOn(Agent.prototype, 'respond').mockResolvedValue([])
      const populateSpy = jest.spyOn(Agent.prototype, 'populate')

      await agentHandlers.agentResponse({ attrs: { data: { agentId: agent._id, message: {} } } })

      expect(populateSpy).toHaveBeenCalledTimes(1)
      expect(populateSpy).toHaveBeenCalledWith('conversation')
    })
  })

  describe('periodicAgent', () => {
    test('should not throw if agent not found', async () => {
      const fakeId = new mongoose.Types.ObjectId()
      await expect(agentHandlers.periodicAgent({ attrs: { data: { agentId: fakeId } } })).resolves.not.toThrow()
    })

    test('should call newMessageHandler when agent evaluates to CONTRIBUTE', async () => {
      const mockResponse = { visible: true, message: 'Periodic response', messageType: 'text', channels: [] }
      jest.spyOn(Agent.prototype, 'evaluate').mockResolvedValue({ action: 2 })
      jest.spyOn(Agent.prototype, 'respond').mockResolvedValue([mockResponse])
      const newMessageSpy = jest.spyOn(messageService, 'newMessageHandler').mockResolvedValue([])

      await agentHandlers.periodicAgent({ attrs: { data: { agentId: agent._id } } })

      expect(newMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Periodic response', fromAgent: true }),
        expect.anything()
      )
    })

    test('should persist resources when periodic agent returns resources response', async () => {
      const resources = [{ source: 'ai', title: 'Periodic AI Paper', category: 'suggested', participantVisible: true }]
      jest.spyOn(Agent.prototype, 'evaluate').mockResolvedValue({ action: 2 })
      jest
        .spyOn(Agent.prototype, 'respond')
        .mockResolvedValue([{ visible: false, message: resources, messageType: 'resources' }])

      await agentHandlers.periodicAgent({ attrs: { data: { agentId: agent._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.resources).toHaveLength(1)
      expect(updated!.resources[0].title).toBe('Periodic AI Paper')
    })

    test('should not respond when agent evaluates to OK', async () => {
      jest.spyOn(Agent.prototype, 'evaluate').mockResolvedValue({ action: 0 })
      const respondSpy = jest.spyOn(Agent.prototype, 'respond')
      const newMessageSpy = jest.spyOn(messageService, 'newMessageHandler').mockResolvedValue([])

      await agentHandlers.periodicAgent({ attrs: { data: { agentId: agent._id } } })

      expect(respondSpy).not.toHaveBeenCalled()
      expect(newMessageSpy).not.toHaveBeenCalled()
    })

    /* Proactive periodic agents have no natural per-tick trigger id (see agent.ts), so a
       from-scratch retry after a mid-job kill is instead caught by debouncing against the
       agent's own most recent message. */
    describe('proactive debounce', () => {
      // Mongoose's timestamps plugin resets createdAt to now on every write, including a
      // plain updateOne — so backdating an existing message has to bypass Mongoose entirely
      // via the native collection, rather than save() then update().
      const postOwnMessage = async (createdAt: Date = new Date()) => {
        await Message.collection.insertOne({
          _id: new mongoose.Types.ObjectId(),
          body: 'Just posted',
          bodyType: 'text',
          conversation: conversation._id,
          owner: agent._id,
          pseudonymId: agent.pseudonyms[0]._id,
          pseudonym: agent.pseudonyms[0].pseudonym,
          createdAt,
          updatedAt: createdAt
        })
      }

      test('should not call respond again if the agent posted very recently', async () => {
        agent.triggers = { periodic: { proactive: true, timerPeriod: 300 } }
        await agent.save()
        jest.spyOn(Agent.prototype, 'evaluate').mockResolvedValue({ action: 2 })
        const respondSpy = jest.spyOn(Agent.prototype, 'respond').mockResolvedValue([])
        await postOwnMessage()

        await agentHandlers.periodicAgent({ attrs: { data: { agentId: agent._id } } })

        expect(respondSpy).not.toHaveBeenCalled()
      })

      test('should call respond when the agent has no recent own message', async () => {
        agent.triggers = { periodic: { proactive: true, timerPeriod: 300 } }
        await agent.save()
        jest.spyOn(Agent.prototype, 'evaluate').mockResolvedValue({ action: 2 })
        const respondSpy = jest.spyOn(Agent.prototype, 'respond').mockResolvedValue([])

        await agentHandlers.periodicAgent({ attrs: { data: { agentId: agent._id } } })

        expect(respondSpy).toHaveBeenCalledTimes(1)
      })

      test('should call respond once the debounce window has passed', async () => {
        agent.triggers = { periodic: { proactive: true, timerPeriod: 300 } }
        await agent.save()
        jest.spyOn(Agent.prototype, 'evaluate').mockResolvedValue({ action: 2 })
        const respondSpy = jest.spyOn(Agent.prototype, 'respond').mockResolvedValue([])
        await postOwnMessage(new Date(Date.now() - 60_000))

        await agentHandlers.periodicAgent({ attrs: { data: { agentId: agent._id } } })

        expect(respondSpy).toHaveBeenCalledTimes(1)
      })

      test('non-proactive periodic agents respond immediately even with a very recent message', async () => {
        // agent (from the outer beforeEach) has no triggers set, so it is not proactive.
        jest.spyOn(Agent.prototype, 'evaluate').mockResolvedValue({ action: 2 })
        const respondSpy = jest.spyOn(Agent.prototype, 'respond').mockResolvedValue([])
        await postOwnMessage()

        await agentHandlers.periodicAgent({ attrs: { data: { agentId: agent._id } } })

        expect(respondSpy).toHaveBeenCalledTimes(1)
      })
    })

    test('populates only the conversation ref, not a duplicate messages/channels lookup', async () => {
      jest.spyOn(Agent.prototype, 'evaluate').mockResolvedValue({ action: 0 })
      const populateSpy = jest.spyOn(Agent.prototype, 'populate')

      await agentHandlers.periodicAgent({ attrs: { data: { agentId: agent._id } } })

      expect(populateSpy).toHaveBeenCalledTimes(1)
      expect(populateSpy).toHaveBeenCalledWith('conversation')
    })

    test('feeds respond() the same conversation history a direct query would return', async () => {
      // Real evaluate()/respond() run here (not mocked at the prototype level), so this exercises
      // the actual populate the handler now relies on instead of doing itself.
      const seededMessage = await Message.create({
        body: 'Hello from a participant',
        bodyType: 'text',
        conversation: conversation._id,
        owner: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        channels: []
      })

      testAgentTypes.periodic.evaluate.mockResolvedValueOnce({
        userMessage: undefined,
        action: 2, // AgentMessageActions.CONTRIBUTE
        userContributionVisible: true,
        suggestion: undefined
      })
      let capturedHistory
      testAgentTypes.periodic.respond.mockImplementationOnce((history) => {
        capturedHistory = history
        return []
      })

      await agentHandlers.periodicAgent({ attrs: { data: { agentId: agent._id } } })

      expect(capturedHistory).toBeDefined()
      expect(capturedHistory.messages).toHaveLength(1)
      expect(capturedHistory.messages[0]._id.toString()).toBe(seededMessage._id.toString())
      expect(capturedHistory.messages[0].body).toBe('Hello from a participant')
    })
  })
})
