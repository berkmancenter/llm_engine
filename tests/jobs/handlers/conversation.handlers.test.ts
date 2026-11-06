import mongoose from 'mongoose'
import { Adapter, Conversation, Message, Agent } from '../../../src/models/index.js'
import { publicTopic, conversationOne } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { insertUsers, userOne } from '../../fixtures/user.fixture.js'
import JobHandlers from '../../../src/jobs/handlers/index.js'
import setupIntTest from '../../utils/setupIntTest.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import agentService from '../../../src/services/agent.service/index.js'
import { setAgentTypes } from '../../../src/models/user.model/agent.model/index.js'
import { setAdapterTypes } from '../../../src/models/adapter.model.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import defaultAdapterTypes from '../../../src/adapters/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../../src/agents/helpers/getModelChat.js'
import config from '../../../src/config/config.js'
import schedule from '../../../src/jobs/schedule.js'
import agentDispatcher from '../../../src/jobs/agentDispatcher.js'

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

  describe('preStartAdapter', () => {
    const mockAdapterStart = jest.fn()

    beforeAll(() => {
      setAdapterTypes({
        zoom: { start: mockAdapterStart, stop: jest.fn(), getUniqueKeys: jest.fn().mockReturnValue([]) },
        slack: { start: mockAdapterStart, stop: jest.fn(), getUniqueKeys: jest.fn().mockReturnValue([]) }
      })
    })

    afterAll(() => {
      setAdapterTypes(defaultAdapterTypes)
    })

    test('starts an inactive adapter of the given type', async () => {
      const zoomAdapter = new Adapter({ type: 'zoom', conversation })
      await zoomAdapter.save()

      await JobHandlers.preStartAdapter({ attrs: { data: { conversationId: conversation._id, adapterType: 'zoom' } } })

      const updated = await Adapter.findById(zoomAdapter._id)
      expect(updated!.active).toBe(true)
      expect(mockAdapterStart).toHaveBeenCalled()
    })

    test('does not start an adapter of a different type', async () => {
      const slackAdapter = new Adapter({ type: 'slack', conversation })
      await slackAdapter.save()

      await JobHandlers.preStartAdapter({ attrs: { data: { conversationId: conversation._id, adapterType: 'zoom' } } })

      const updated = await Adapter.findById(slackAdapter._id)
      expect(updated!.active).toBe(false)
      expect(mockAdapterStart).not.toHaveBeenCalled()
    })

    test('skips an adapter that is already active', async () => {
      const zoomAdapter = new Adapter({ type: 'zoom', conversation, active: true })
      await zoomAdapter.save()

      await JobHandlers.preStartAdapter({ attrs: { data: { conversationId: conversation._id, adapterType: 'zoom' } } })

      expect(mockAdapterStart).not.toHaveBeenCalled()
    })

    test('does not throw if conversation not found', async () => {
      const fakeId = '000000000000000000000000'
      await expect(
        JobHandlers.preStartAdapter({ attrs: { data: { conversationId: fakeId, adapterType: 'zoom' } } })
      ).resolves.not.toThrow()
      expect(mockAdapterStart).not.toHaveBeenCalled()
    })

    test('does not start adapters for a Draft conversation', async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { draft: true })
      const zoomAdapter = new Adapter({ type: 'zoom', conversation })
      await zoomAdapter.save()

      await JobHandlers.preStartAdapter({ attrs: { data: { conversationId: conversation._id, adapterType: 'zoom' } } })

      const updated = await Adapter.findById(zoomAdapter._id)
      expect(updated!.active).toBe(false)
      expect(mockAdapterStart).not.toHaveBeenCalled()
    })

    test('does not start adapters for a conversation that is already active', async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { active: true })
      const zoomAdapter = new Adapter({ type: 'zoom', conversation })
      await zoomAdapter.save()

      await JobHandlers.preStartAdapter({ attrs: { data: { conversationId: conversation._id, adapterType: 'zoom' } } })

      const updated = await Adapter.findById(zoomAdapter._id)
      expect(updated!.active).toBe(false)
      expect(mockAdapterStart).not.toHaveBeenCalled()
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

    const dispatchTestAgentType = {
      start: jest.fn(),
      stop: jest.fn(),
      evaluate: jest.fn(),
      onConversationEvent: jest.fn().mockResolvedValue([]),
      capabilities: () => ({ read: [{ type: 'ownConversation' as const }], write: [{ type: 'ownConversation' as const }] }),
      name: 'Test dispatch agent',
      description: 'A test agent',
      maxTokens: 2000,
      defaultTriggers: undefined,
      priority: 10,
      llmTemplateVars: {},
      defaultLLMTemplates: {},
      defaultLLMPlatform,
      defaultLLMModel
    }

    beforeAll(() => {
      config.disablePostEventAnalysis = false
      setAgentTypes({ testDispatchAgent: dispatchTestAgentType })
    })

    afterAll(() => {
      config.disablePostEventAnalysis = true
      setAgentTypes(defaultAgentTypes)
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

    test('notifies the agent when the conversation it belongs to stops', async () => {
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
        agentType: 'testDispatchAgent',
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

  describe('openConversationWindow', () => {
    let scheduleSpy: jest.SpyInstance

    const dispatchTestAgentType = {
      start: jest.fn(),
      stop: jest.fn(),
      evaluate: jest.fn(),
      onConversationEvent: jest.fn().mockResolvedValue([]),
      capabilities: () => ({ read: [{ type: 'ownConversation' as const }], write: [{ type: 'ownConversation' as const }] }),
      name: 'Test dispatch agent',
      description: 'A test agent',
      maxTokens: 2000,
      defaultTriggers: undefined,
      priority: 10,
      llmTemplateVars: {},
      defaultLLMTemplates: {},
      defaultLLMPlatform,
      defaultLLMModel
    }

    beforeAll(() => {
      setAgentTypes({ testDispatchAgent: dispatchTestAgentType })
    })

    afterAll(() => {
      setAgentTypes(defaultAgentTypes)
    })

    beforeEach(() => {
      scheduleSpy = jest.spyOn(schedule, 'conversationEvent').mockResolvedValue(undefined)
    })

    // preEventMinutes left undefined means "don't set it" (unconfigured), not "15" — a default
    // parameter would instead substitute 15 for an explicit attachAgent(undefined) call.
    async function attachAgent(preEventMinutes?: number) {
      if (preEventMinutes !== undefined) {
        await Conversation.findByIdAndUpdate(conversation._id, { preEventMinutes })
      }
      const agent = new Agent({ agentType: 'testDispatchAgent', conversation: conversation._id, active: false })
      await agent.save()
      await Conversation.findByIdAndUpdate(conversation._id, { $push: { agents: agent._id } })
      return agent
    }

    test("dispatches to this conversation's own agent even though it is not active yet", async () => {
      const agent = await attachAgent(15)

      await JobHandlers.openConversationWindow({
        attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
      })

      expect(scheduleSpy).toHaveBeenCalledWith({
        agentId: agent._id.toString(),
        event: expect.objectContaining({
          type: 'conversationWindowOpened',
          phase: 'preEvent',
          conversationId: conversation._id.toString()
        })
      })
    })

    test('starts the recurring countdown once the window opens', async () => {
      const countdownSpy = jest.spyOn(schedule, 'startConversationWindowCountdown').mockResolvedValue(undefined)
      await attachAgent(15)

      await JobHandlers.openConversationWindow({
        attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
      })

      expect(countdownSpy).toHaveBeenCalledWith({ conversationId: conversation._id.toString(), phase: 'preEvent' })
    })

    test('skips when preEventMinutes is not configured', async () => {
      await attachAgent()

      await JobHandlers.openConversationWindow({
        attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
      })

      expect(scheduleSpy).not.toHaveBeenCalled()
    })

    test('skips once the conversation has already started', async () => {
      await attachAgent(15)
      await Conversation.findByIdAndUpdate(conversation._id, { active: true, startTime: new Date() })

      await JobHandlers.openConversationWindow({
        attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
      })

      expect(scheduleSpy).not.toHaveBeenCalled()
    })

    test('skips a draft conversation, which auto-start will never start', async () => {
      await attachAgent(15)
      await Conversation.findByIdAndUpdate(conversation._id, { draft: true })

      await JobHandlers.openConversationWindow({
        attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
      })

      expect(scheduleSpy).not.toHaveBeenCalled()
    })

    test('skips an unimplemented phase', async () => {
      await attachAgent(15)

      await JobHandlers.openConversationWindow({
        attrs: { data: { conversationId: conversation._id, phase: 'postEvent' } }
      })

      expect(scheduleSpy).not.toHaveBeenCalled()
    })

    test('does not throw if conversation not found', async () => {
      const fakeId = '000000000000000000000000'
      await expect(
        JobHandlers.openConversationWindow({ attrs: { data: { conversationId: fakeId, phase: 'preEvent' } } })
      ).resolves.not.toThrow()
    })

    describe('conversationWindowCountdown', () => {
      let cancelSpy: jest.SpyInstance

      beforeEach(() => {
        cancelSpy = jest.spyOn(schedule, 'cancelConversationWindowCountdown').mockResolvedValue(undefined)
      })

      test('dispatches with freshly computed elapsed/remaining time', async () => {
        const preEventMinutes = 15
        const scheduledTime = new Date(Date.now() + 10 * 60 * 1000) // 10 min from now
        await Conversation.findByIdAndUpdate(conversation._id, { preEventMinutes, scheduledTime })
        const agent = await attachAgent()

        await JobHandlers.conversationWindowCountdown({
          attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
        })

        expect(scheduleSpy).toHaveBeenCalledWith({
          agentId: agent._id.toString(),
          event: expect.objectContaining({
            type: 'conversationWindowCountdown',
            phase: 'preEvent',
            conversationId: conversation._id.toString()
          })
        })
        // Window opened 5 min ago (10 min until start, 15 min preEventMinutes); remaining is
        // ~10 min until scheduledTime. Generous bounds to absorb test execution time.
        const [[{ event }]] = scheduleSpy.mock.calls.slice(-1)
        expect(event.elapsedMs).toBeGreaterThan(4.9 * 60 * 1000)
        expect(event.elapsedMs).toBeLessThan(5.1 * 60 * 1000)
        expect(event.remainingMs).toBeGreaterThan(9.9 * 60 * 1000)
        expect(event.remainingMs).toBeLessThan(10.1 * 60 * 1000)
        expect(cancelSpy).not.toHaveBeenCalled()
      })

      /* A manual "start now" (or a moderator resuming a transcript) can set startTime before
         scheduledTime — see preEventWindow.ts. Once a conversation has actually started, the
         preEvent window is over regardless of what scheduledTime still says, so the countdown
         should stop rather than keep ticking. */
      test('self-cancels once the conversation has started, even before scheduledTime', async () => {
        await Conversation.findByIdAndUpdate(conversation._id, {
          preEventMinutes: 15,
          scheduledTime: new Date(Date.now() + 2 * 60 * 1000), // 2 min until the advertised start
          active: true,
          startTime: new Date() // started early, e.g. via "start now"
        })
        await attachAgent()

        await JobHandlers.conversationWindowCountdown({
          attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
        })

        expect(scheduleSpy).not.toHaveBeenCalled()
        expect(cancelSpy).toHaveBeenCalledWith(conversation._id.toString(), 'preEvent')
      })

      test('self-cancels once scheduledTime itself has passed', async () => {
        await Conversation.findByIdAndUpdate(conversation._id, {
          preEventMinutes: 15,
          scheduledTime: new Date(Date.now() - 60 * 1000), // advertised start just passed
          active: true,
          startTime: new Date(Date.now() - 5 * 60 * 1000)
        })
        await attachAgent()

        await JobHandlers.conversationWindowCountdown({
          attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
        })

        expect(scheduleSpy).not.toHaveBeenCalled()
        expect(cancelSpy).toHaveBeenCalledWith(conversation._id.toString(), 'preEvent')
      })

      test('self-cancels once the conversation has fully ended', async () => {
        await Conversation.findByIdAndUpdate(conversation._id, {
          preEventMinutes: 15,
          scheduledTime: new Date(Date.now() + 10 * 60 * 1000),
          active: false,
          startTime: new Date(Date.now() - 60 * 60 * 1000),
          endTime: new Date()
        })
        await attachAgent()

        await JobHandlers.conversationWindowCountdown({
          attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
        })

        expect(scheduleSpy).not.toHaveBeenCalled()
        expect(cancelSpy).toHaveBeenCalledWith(conversation._id.toString(), 'preEvent')
      })

      test('self-cancels when preEventMinutes is no longer configured', async () => {
        await Conversation.findByIdAndUpdate(conversation._id, { scheduledTime: new Date(Date.now() + 10 * 60 * 1000) })
        await attachAgent()

        await JobHandlers.conversationWindowCountdown({
          attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
        })

        expect(scheduleSpy).not.toHaveBeenCalled()
        expect(cancelSpy).toHaveBeenCalledWith(conversation._id.toString(), 'preEvent')
      })

      test('self-cancels for an unimplemented phase', async () => {
        await Conversation.findByIdAndUpdate(conversation._id, {
          preEventMinutes: 15,
          scheduledTime: new Date(Date.now() + 10 * 60 * 1000)
        })
        await attachAgent()

        await JobHandlers.conversationWindowCountdown({
          attrs: { data: { conversationId: conversation._id, phase: 'postEvent' } }
        })

        expect(scheduleSpy).not.toHaveBeenCalled()
        expect(cancelSpy).toHaveBeenCalledWith(conversation._id.toString(), 'postEvent')
      })

      test('self-cancels if the conversation is gone', async () => {
        const fakeId = '000000000000000000000000'

        await JobHandlers.conversationWindowCountdown({ attrs: { data: { conversationId: fakeId, phase: 'preEvent' } } })

        expect(cancelSpy).toHaveBeenCalledWith(fakeId, 'preEvent')
      })
    })

    describe('activates agents for pregame chat/DM responsiveness', () => {
      const preEventCapabilities = () => ({ read: [], write: [], activeDuringPhases: ['preEvent' as const] })

      const perMessageType = {
        start: jest.fn(),
        stop: jest.fn(),
        evaluate: jest.fn(),
        name: 'Test perMessage agent, not opted in to preEvent',
        description: 'A test agent',
        maxTokens: 2000,
        defaultTriggers: { perMessage: { channels: ['chat'] } },
        priority: 10,
        llmTemplateVars: {},
        defaultLLMTemplates: {},
        defaultLLMPlatform,
        defaultLLMModel
      }
      const optedInPerMessageType = {
        ...perMessageType,
        start: jest.fn(),
        name: 'Test perMessage agent, opted in to preEvent',
        capabilities: preEventCapabilities
      }
      const optedInPerMessageAndPeriodicType = {
        ...perMessageType,
        start: jest.fn(),
        name: 'Test perMessage+periodic agent (mirrors eventAssistant), opted in to preEvent',
        defaultTriggers: { perMessage: { channels: ['chat'] }, periodic: { timerPeriod: 180, proactive: true } },
        capabilities: preEventCapabilities
      }
      const periodicOnlyType = {
        ...perMessageType,
        start: jest.fn(),
        name: 'Test periodic-only agent, not opted in to preEvent',
        defaultTriggers: { periodic: { timerPeriod: 120 } }
      }
      const brokenStartType = {
        ...perMessageType,
        start: jest.fn().mockRejectedValue(new Error('boom')),
        name: 'Test agent whose start() always throws, opted in to preEvent',
        capabilities: preEventCapabilities
      }

      let periodicScheduleSpy: jest.SpyInstance

      beforeAll(() => {
        setAgentTypes({
          testPerMessage: perMessageType,
          testOptedInPerMessage: optedInPerMessageType,
          testOptedInPerMessageAndPeriodic: optedInPerMessageAndPeriodicType,
          testPeriodicOnly: periodicOnlyType,
          testBrokenStart: brokenStartType
        })
      })

      afterAll(() => {
        setAgentTypes(defaultAgentTypes)
      })

      beforeEach(() => {
        periodicScheduleSpy = jest.spyOn(schedule, 'periodicAgent').mockReset().mockResolvedValue(undefined)
      })

      async function attachTypedAgent(agentType: string) {
        await Conversation.findByIdAndUpdate(conversation._id, { preEventMinutes: 15 })
        const agent = new Agent({ agentType, conversation: conversation._id, active: false })
        await agent.save()
        await Conversation.findByIdAndUpdate(conversation._id, { $push: { agents: agent._id } })
        return agent
      }

      test('leaves a perMessage-triggered agent inactive when it has not opted in to preEvent', async () => {
        const agent = await attachTypedAgent('testPerMessage')

        await JobHandlers.openConversationWindow({
          attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
        })

        const updated = await Agent.findById(agent._id)
        expect(updated!.active).toBe(false)
        expect(perMessageType.start).not.toHaveBeenCalled()
      })

      test('activates a perMessage-triggered agent that opts in to preEvent', async () => {
        const agent = await attachTypedAgent('testOptedInPerMessage')

        await JobHandlers.openConversationWindow({
          attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
        })

        const updated = await Agent.findById(agent._id)
        expect(updated!.active).toBe(true)
        expect(optedInPerMessageType.start).toHaveBeenCalled()
      })

      test('activates an opted-in perMessage+periodic agent and schedules its periodic trigger too', async () => {
        const agent = await attachTypedAgent('testOptedInPerMessageAndPeriodic')

        await JobHandlers.openConversationWindow({
          attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
        })

        const updated = await Agent.findById(agent._id)
        expect(updated!.active).toBe(true)
        // Unlike the old perMessage-inferred heuristic, an explicit preEvent opt-in starts
        // whatever triggers the agent actually has — periodic included — via agentService.
        // startAgent(). An agent that wants perMessage reachability without its periodic/
        // proactive logic running early needs to guard that itself (see eventAssistant's own
        // onConversationEvent phase handling).
        expect(periodicScheduleSpy).toHaveBeenCalled()
      })

      test('leaves a periodic-only agent inactive when it has not opted in to preEvent', async () => {
        const agent = await attachTypedAgent('testPeriodicOnly')

        await JobHandlers.openConversationWindow({
          attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
        })

        const updated = await Agent.findById(agent._id)
        expect(updated!.active).toBe(false)
        expect(periodicOnlyType.start).not.toHaveBeenCalled()
        expect(periodicScheduleSpy).not.toHaveBeenCalled()
      })

      test('one agent failing to start does not block the others or the dispatch', async () => {
        const dispatchSpy = jest.spyOn(agentDispatcher, 'dispatch').mockResolvedValue(undefined)
        await attachTypedAgent('testBrokenStart')
        const workingAgent = await attachTypedAgent('testOptedInPerMessage')

        await expect(
          JobHandlers.openConversationWindow({
            attrs: { data: { conversationId: conversation._id, phase: 'preEvent' } }
          })
        ).resolves.not.toThrow()

        const updatedWorkingAgent = await Agent.findById(workingAgent._id)
        expect(updatedWorkingAgent!.active).toBe(true)
        expect(dispatchSpy).toHaveBeenCalled()
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
