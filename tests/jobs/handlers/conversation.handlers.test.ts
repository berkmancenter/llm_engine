import mongoose from 'mongoose'
import { Conversation, Message, Agent } from '../../../src/models/index.js'
import { publicTopic, conversationOne } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { insertUsers, userOne } from '../../fixtures/user.fixture.js'
import JobHandlers from '../../../src/jobs/handlers/index.js'
import setupIntTest from '../../utils/setupIntTest.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import agentService from '../../../src/services/agent.service/index.js'
import { setAgentTypes } from '../../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../../src/agents/helpers/getModelChat.js'
import config from '../../../src/config/config.js'
import schedule from '../../../src/jobs/schedule.js'

setupIntTest()

describe('conversation handler tests', () => {
  let conversation
  const originalDisablePostEventAnalysis = config.disablePostEventAnalysis

  /* Stopping a conversation summarizes it with a live call to the core LLM and dispatches
     conversationStopped to the agents. Neither is what these handler tests cover, and the
     network round trip regularly outruns Jest's 5s per-test limit. */
  beforeAll(() => {
    config.disablePostEventAnalysis = true
  })

  afterAll(() => {
    config.disablePostEventAnalysis = originalDisablePostEventAnalysis
  })

  beforeEach(async () => {
    await insertUsers([userOne])
    await insertTopics([publicTopic])

    /* draft: false because this describes start/stop mechanics, not draft-status behavior;
       conversationOne itself has no scheduledTime/zoomMeetingUrl, which would otherwise
       default it to Draft and block it from starting. */
    conversation = new Conversation({ ...conversationOne, active: false, draft: false })
    await conversation.save()

    jest.spyOn(websocketGateway, 'broadcastConversationStarted').mockResolvedValue(undefined)
    jest.spyOn(websocketGateway, 'broadcastConversationStopped').mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('autoStartConversation', () => {
    test('should start an inactive conversation', async () => {
      await JobHandlers.autoStartConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(true)
      expect(updated!.startTime).toBeDefined()
    })

    test('should skip if conversation is already active', async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { active: true })

      await JobHandlers.autoStartConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.startTime).toBeUndefined()
    })

    test('should not throw if conversation not found', async () => {
      const fakeId = '000000000000000000000000'
      await expect(JobHandlers.autoStartConversation({ attrs: { data: { conversationId: fakeId } } })).resolves.not.toThrow()
    })

    test('should not start a Draft conversation, and should not throw out of the job', async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { draft: true })

      await expect(
        JobHandlers.autoStartConversation({ attrs: { data: { conversationId: conversation._id } } })
      ).resolves.not.toThrow()

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(false)
      expect(updated!.startTime).toBeUndefined()
    })
  })

  describe('autoStopConversation', () => {
    const startedLongAgo = new Date(Date.now() - 90 * 60 * 1000) // > NEVER_STARTED_GRACE_MS
    const startedRecently = new Date(Date.now() - 10 * 60 * 1000) // < NEVER_STARTED_GRACE_MS

    async function createTranscriptMessages(count: number, ageMs: number) {
      await Message.insertMany(
        Array.from({ length: count }, () => ({
          conversation: conversation._id,
          channels: ['transcript'],
          body: 'hello',
          pseudonym: 'Speaker',
          pseudonymId: new mongoose.Types.ObjectId(),
          createdAt: new Date(Date.now() - ageMs)
        }))
      )
    }

    beforeEach(async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { active: true, startTime: startedLongAgo })
    })

    test('stops when idle past IDLE_TIMEOUT_MS with sufficient messages', async () => {
      await createTranscriptMessages(10, 10 * 60 * 1000) // 10 messages, 10 min old

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(false)
      expect(updated!.endTime).toBeDefined()
    })

    test('does not stop when last transcript message is within IDLE_TIMEOUT_MS', async () => {
      await createTranscriptMessages(10, 60 * 1000) // 10 messages, 1 min old

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(true)
      expect(updated!.endTime).toBeUndefined()
    })

    test('stops a scheduled event after its end time when idle', async () => {
      const scheduledEndTime = new Date(Date.now() - 10 * 60 * 1000) // ended 10 min ago
      await Conversation.findByIdAndUpdate(conversation._id, { scheduledEndTime })
      await createTranscriptMessages(10, 10 * 60 * 1000) // 10 min idle

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(false)
      expect(updated!.endTime).toBeDefined()
    })

    test('does not stop a scheduled event after its end time if still active', async () => {
      const scheduledEndTime = new Date(Date.now() - 10 * 60 * 1000) // ended 10 min ago
      await Conversation.findByIdAndUpdate(conversation._id, { scheduledEndTime })
      await createTranscriptMessages(10, 60 * 1000) // 1 min idle — still talking

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(true)
      expect(updated!.endTime).toBeUndefined()
    })

    test('does not stop when fewer than MIN_TRANSCRIPT_MESSAGES exist within NEVER_STARTED_GRACE_MS', async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { startTime: startedRecently })
      await createTranscriptMessages(2, 10 * 60 * 1000) // only 2 messages, idle

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(true)
      expect(updated!.endTime).toBeUndefined()
    })

    test('stops when fewer than MIN_TRANSCRIPT_MESSAGES exist but past NEVER_STARTED_GRACE_MS', async () => {
      // startedLongAgo (90min) is already set in beforeEach, past the 30-min grace period
      await createTranscriptMessages(2, 10 * 60 * 1000) // only 2 messages

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(false)
      expect(updated!.endTime).toBeDefined()
    })

    test('does not stop a restarted conversation with stale transcript messages within IDLE_TIMEOUT_MS of startTime', async () => {
      // Simulate a restart: startTime is recent but transcript messages are old (from the previous run)
      const restartedAt = new Date(Date.now() - 2 * 60 * 1000) // restarted 2 min ago
      await Conversation.findByIdAndUpdate(conversation._id, { startTime: restartedAt })
      await createTranscriptMessages(10, 10 * 60 * 1000) // 10 messages, 10 min old (pre-restart)

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(true)
      expect(updated!.endTime).toBeUndefined()
    })

    test('skips if conversation is already inactive', async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { active: false })

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      // endTime must not be set — doStopConversation was not called
      const updated = await Conversation.findById(conversation._id)
      expect(updated!.endTime).toBeUndefined()
    })

    test('does not throw if conversation not found', async () => {
      const fakeId = '000000000000000000000000'
      await expect(JobHandlers.autoStopConversation({ attrs: { data: { conversationId: fakeId } } })).resolves.not.toThrow()
    })
  })

  /* If an instance is torn down mid-flight (autoscaler scale-down, rolling deploy) and this
     job is retried from scratch, the retry's `if (conversation.active) skip` guard only
     prevents a double-run if `active` was persisted before the agent/adapter side effects —
     these confirm that ordering by forcing a mid-flight failure and checking what already
     made it to the DB. */
  describe('doStartConversation / doStopConversation persist active before side effects', () => {
    const testAgentType = {
      respond: jest.fn(),
      evaluate: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      name: 'Test Agent',
      description: 'A test agent',
      maxTokens: 2000,
      defaultTriggers: { perMessage: {} },
      priority: 10,
      llmTemplateVars: {},
      defaultLLMTemplates: {},
      defaultLLMPlatform,
      defaultLLMModel
    }

    beforeAll(() => {
      setAgentTypes({ testAgent: testAgentType })
    })

    afterAll(() => {
      setAgentTypes(defaultAgentTypes)
    })

    test('active is already true in the DB even if starting an agent throws mid-flight', async () => {
      const agent = new Agent({ agentType: 'testAgent', conversation: conversation._id })
      await agent.save()
      conversation.agents.push(agent)
      await conversation.save()
      jest.spyOn(agentService, 'startAgent').mockRejectedValue(new Error('boom'))

      await expect(
        JobHandlers.autoStartConversation({ attrs: { data: { conversationId: conversation._id } } })
      ).resolves.not.toThrow()

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(true)
      expect(updated!.startTime).toBeDefined()
    })

    test('active is already false in the DB even if stopping an agent throws mid-flight', async () => {
      const agent = new Agent({ agentType: 'testAgent', conversation: conversation._id })
      await agent.save()
      conversation.agents.push(agent)
      conversation.active = true
      conversation.startTime = new Date(Date.now() - 90 * 60 * 1000) // past MAX_RUNNING_TIME_MS
      await conversation.save()
      jest.spyOn(agentService, 'stopAgent').mockRejectedValue(new Error('boom'))

      await expect(
        JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })
      ).resolves.not.toThrow()

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(false)
      expect(updated!.endTime).toBeDefined()
    })
  })

  /* The stop routine deactivates this conversation's agents before it announces the stop,
     and the dispatcher only considers active agents. Post-event analysis is re-enabled here
     because the outer suite turns it off. */
  describe('conversationStopped reaches an agent attached to the stopping conversation', () => {
    let scheduleSpy: jest.SpyInstance

    beforeAll(() => {
      config.disablePostEventAnalysis = false
    })

    afterAll(() => {
      config.disablePostEventAnalysis = true
    })

    /* The block above stubs agentService.stopAgent and the outer afterEach only clears call
       history, so the stub has to be restored before this test, not just after it. */
    beforeEach(() => {
      jest.restoreAllMocks()
      scheduleSpy = jest.spyOn(schedule, 'conversationEvent').mockResolvedValue(undefined)
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    test('notifies the Concept Cartographer when the conversation it belongs to stops', async () => {
      /* No transcript, so the stop routine skips the live LLM summary call. Started well
         past the grace period that keeps a quiet conversation open, so it still stops. */
      const chatOnlyConversation = new Conversation({
        ...conversationOne,
        _id: new mongoose.Types.ObjectId(),
        transcript: undefined,
        active: true,
        draft: false,
        startTime: new Date(Date.now() - 90 * 60 * 1000) // 90 min ago
      })
      const agent = new Agent({
        agentType: 'conceptCartographer',
        conversation: chatOnlyConversation._id,
        active: true
      })
      await agent.save()
      chatOnlyConversation.agents.push(agent)
      await chatOnlyConversation.save()

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: chatOnlyConversation._id } } })

      expect(scheduleSpy).toHaveBeenCalledWith({
        agentId: agent._id.toString(),
        event: expect.objectContaining({ type: 'conversationStopped', conversationId: chatOnlyConversation._id.toString() })
      })
    })
  })

  describe('conversationEndingSoon', () => {
    beforeEach(async () => {})

    test('should call conversation ending soon job', async () => {
      await Conversation.findByIdAndUpdate(conversation._id, {
        active: true,
        startTime: new Date(),
        scheduledEndTime: new Date(Date.now() + 20 * 60 * 1000)
      }) // scheduled to end in 20 minutes
      const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastConversationAlmostEnding').mockResolvedValue(undefined)

      await JobHandlers.conversationEndingSoon({ attrs: { data: { conversationId: conversation._id } } })

      expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }))
    })
  })
})
