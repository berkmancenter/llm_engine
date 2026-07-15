import setupIntTest from '../../utils/setupIntTest.js'
import { insertUsers, registeredUser } from '../../fixtures/user.fixture.js'
import { publicTopic, privateTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { Agent, Conversation } from '../../../src/models/index.js'
import schedule from '../../../src/jobs/schedule.js'
import agentDispatcher from '../../../src/jobs/agentDispatcher.js'

/* Unlike agentDispatcher.test.ts (which mocks Agent.find and access.assertCanRead
   directly to unit-test the dispatcher's own control flow), this file uses REAL
   Mongo documents and the REAL, unmocked capabilities.ts + access.assertCanRead
   chain — so it actually proves numberCruncher's allPublicTopics grant (added
   alongside its onConversationEvent handler) routes correctly. A typo or wrong
   grant type in capabilities.ts would pass every other numberCruncher test (which
   all fake the agent's capabilities object directly) but would be caught here.
   Only schedule.conversationEvent is mocked, so no real agenda job is scheduled —
   this test is about the routing DECISION, not running the job it schedules. */

setupIntTest()

describe('agentDispatcher routes conversationStopped to numberCruncher via its real capabilities', () => {
  let numberCruncherAgent
  let scheduleSpy: jest.SpyInstance

  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic, privateTopic])

    // numberCruncher's own admin conversation — distinct from the event
    // conversation being dispatched about.
    const adminConversation = new Conversation({
      name: 'Number Cruncher',
      owner: registeredUser._id,
      topic: publicTopic._id,
      agents: [],
      messages: []
    })
    await adminConversation.save()

    numberCruncherAgent = new Agent({
      agentType: 'numberCruncher',
      conversation: adminConversation._id,
      active: true
    })
    await numberCruncherAgent.save()

    scheduleSpy = jest.spyOn(schedule, 'conversationEvent').mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('notifies numberCruncher when a PUBLIC topic conversation stops', async () => {
    await agentDispatcher.dispatch(
      { type: 'conversationStopped', conversationId: 'stopped-conv-id', topicId: publicTopic._id.toString() },
      { type: 'conversation', id: 'stopped-conv-id', topicId: publicTopic._id.toString(), topicIsPrivate: false }
    )

    expect(scheduleSpy).toHaveBeenCalledWith({
      agentId: numberCruncherAgent._id.toString(),
      event: { type: 'conversationStopped', conversationId: 'stopped-conv-id', topicId: publicTopic._id.toString() }
    })
  })

  it('does NOT notify numberCruncher when a PRIVATE topic conversation stops', async () => {
    await agentDispatcher.dispatch(
      { type: 'conversationStopped', conversationId: 'stopped-conv-id', topicId: privateTopic._id.toString() },
      { type: 'conversation', id: 'stopped-conv-id', topicId: privateTopic._id.toString(), topicIsPrivate: true }
    )

    expect(scheduleSpy).not.toHaveBeenCalled()
  })
})
