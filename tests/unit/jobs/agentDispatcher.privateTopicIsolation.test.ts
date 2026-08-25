import setupIntTest from '../../utils/setupIntTest.js'
import { insertUsers, registeredUser } from '../../fixtures/user.fixture.js'
import { publicTopic, privateTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { Agent, Conversation } from '../../../src/models/index.js'
import schedule from '../../../src/jobs/schedule.js'
import agentDispatcher from '../../../src/jobs/agentDispatcher.js'

/* Safety check for the allTopics/allPublicTopics split: numberCruncher is the only
   agent meant to see private-topic events (agentDispatcher.numberCruncher.test.ts
   proves that positive case). This file proves the negative case for every other
   agent type using the REAL, unmocked capabilities.ts + access.assertCanRead chain —
   if allPublicTopics ever regressed to matching private topics, or a future agent
   type picked up too broad a grant by mistake, this is what would catch it. Only
   schedule.conversationEvent is mocked, so no real agenda job is scheduled. */

setupIntTest()

describe('agentDispatcher does not route private-topic events to allPublicTopics-only agents', () => {
  let scheduleSpy: jest.SpyInstance

  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic, privateTopic])
    scheduleSpy = jest.spyOn(schedule, 'conversationEvent').mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  async function createAgent(agentType: string) {
    const adminConversation = new Conversation({
      name: `${agentType}-admin`,
      owner: registeredUser._id,
      topic: publicTopic._id,
      agents: [],
      messages: []
    })
    await adminConversation.save()

    const agent = new Agent({ agentType, conversation: adminConversation._id, active: true })
    await agent.save()
    return agent
  }

  it.each(['vibesAnalyst', 'communityAssistant'])(
    'does not notify %s when a PRIVATE topic conversation stops',
    async (agentType) => {
      await createAgent(agentType)

      await agentDispatcher.dispatch(
        { type: 'conversationStopped', conversationId: 'stopped-conv-id', topicId: privateTopic._id.toString() },
        { type: 'conversation', id: 'stopped-conv-id', topicId: privateTopic._id.toString(), topicIsPrivate: true }
      )

      expect(scheduleSpy).not.toHaveBeenCalled()
    }
  )

  it.each(['vibesAnalyst', 'communityAssistant'])(
    'still notifies %s when a PUBLIC topic conversation stops',
    async (agentType) => {
      const agent = await createAgent(agentType)

      await agentDispatcher.dispatch(
        { type: 'conversationStopped', conversationId: 'stopped-conv-id', topicId: publicTopic._id.toString() },
        { type: 'conversation', id: 'stopped-conv-id', topicId: publicTopic._id.toString(), topicIsPrivate: false }
      )

      expect(scheduleSpy).toHaveBeenCalledWith({
        agentId: agent._id.toString(),
        event: { type: 'conversationStopped', conversationId: 'stopped-conv-id', topicId: publicTopic._id.toString() }
      })
    }
  )
})
