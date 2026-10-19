import setupIntTest from '../../utils/setupIntTest.js'
import { insertUsers, registeredUser } from '../../fixtures/user.fixture.js'
import { publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { Agent, Conversation } from '../../../src/models/index.js'
import schedule from '../../../src/jobs/schedule.js'
import agentDispatcher from '../../../src/jobs/agentDispatcher.js'

/* Uses REAL Mongo documents and the REAL, unmocked capabilities.ts + access.assertCanRead
   chain (see agentDispatcher.numberCruncher.test.ts for why) to prove communityAssistant's
   topic-wide read grant is scoped to conversationStopped only — it must NOT also match
   participantJoined events from some other public-topic conversation, or this agent gets
   dispatched (and makes an LLM call) for every participant joining every public event,
   not just its own conversation. */

setupIntTest()

describe('agentDispatcher routes communityAssistant via its real capabilities', () => {
  let communityAgent
  let scheduleSpy: jest.SpyInstance

  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])

    // communityAssistant's own persistent community conversation — distinct from the
    // public event conversation that a participant actually joins or that stops.
    const adminConversation = new Conversation({
      name: 'Community',
      owner: registeredUser._id,
      topic: publicTopic._id,
      agents: [],
      messages: []
    })
    await adminConversation.save()

    communityAgent = new Agent({
      agentType: 'communityAssistant',
      conversation: adminConversation._id,
      active: true
    })
    await communityAgent.save()

    scheduleSpy = jest.spyOn(schedule, 'conversationEvent').mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('notifies communityAssistant when ANY public-topic conversation stops', async () => {
    await agentDispatcher.dispatch(
      { type: 'conversationStopped', conversationId: 'other-event-conv-id', topicId: publicTopic._id.toString() },
      { type: 'conversation', id: 'other-event-conv-id', topicId: publicTopic._id.toString(), topicIsPrivate: false }
    )

    expect(scheduleSpy).toHaveBeenCalledWith({
      agentId: communityAgent._id.toString(),
      event: { type: 'conversationStopped', conversationId: 'other-event-conv-id', topicId: publicTopic._id.toString() }
    })
  })

  it('does NOT notify communityAssistant when a DIFFERENT public-topic conversation gets a participant join', async () => {
    await agentDispatcher.dispatch(
      { type: 'participantJoined', conversationId: 'other-event-conv-id', userId: 'user-1', name: 'Alex' },
      { type: 'conversation', id: 'other-event-conv-id', topicId: publicTopic._id.toString(), topicIsPrivate: false }
    )

    expect(scheduleSpy).not.toHaveBeenCalled()
  })

  it('DOES notify communityAssistant when a participant joins ITS OWN conversation', async () => {
    const ownConversationId = communityAgent.conversation.toString()

    await agentDispatcher.dispatch(
      { type: 'participantJoined', conversationId: ownConversationId, userId: 'user-1', name: 'Alex' },
      { type: 'conversation', id: ownConversationId, topicId: publicTopic._id.toString(), topicIsPrivate: false }
    )

    expect(scheduleSpy).toHaveBeenCalledWith({
      agentId: communityAgent._id.toString(),
      event: { type: 'participantJoined', conversationId: ownConversationId, userId: 'user-1', name: 'Alex' }
    })
  })

  /* Known, accepted gap (not fixed here): access and subscription are separate checks.
     assertCanRead only answers "may this agent see its own conversation's events" — it has
     no visibility into agentConfig.notifications, so a job still gets scheduled (and a trace
     opened) for an event type this particular instance isn't actually subscribed to. The
     agent's own onConversationEvent handler is what no-ops on it, but only after the job
     already ran. See communityAssistant.agent.test.ts for that handler-level no-op. */
  it('still schedules a job for participantJoined on its OWN conversation even when notifications excludes it', async () => {
    communityAgent.agentConfig = { notifications: ['event_ended'] } // no 'participant_joined'
    await communityAgent.save()
    const ownConversationId = communityAgent.conversation.toString()

    await agentDispatcher.dispatch(
      { type: 'participantJoined', conversationId: ownConversationId, userId: 'user-1', name: 'Alex' },
      { type: 'conversation', id: ownConversationId, topicId: publicTopic._id.toString(), topicIsPrivate: false }
    )

    expect(scheduleSpy).toHaveBeenCalledWith({
      agentId: communityAgent._id.toString(),
      event: { type: 'participantJoined', conversationId: ownConversationId, userId: 'user-1', name: 'Alex' }
    })
  })
})
