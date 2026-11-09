/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createEventAssistantConversation, createPublicTopic, createUser } from '../../utils/agentTestHelpers.js'
import Agent from '../../../src/models/user.model/agent.model/index.js'
import Channel from '../../../src/models/channel.model.js'
import Message from '../../../src/models/message.model.js'
import { ConversationEvent } from '../../../src/types/index.types.js'
import type { AgentDocument } from '../../../src/models/user.model/agent.model/index.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('moderatorNotifier')
const testTimeout = 90000

/* Live-LLM coverage of the actual generated themes — format/gating is already covered with a
   mocked LLM in tests/unit/agents/moderatorNotifier/moderatorNotifier.onConversationEvent.test.ts.
   createModeratorNotifierConversation (agentTestHelpers.js) only attaches a standalone
   moderatorNotifier agent, with no eventAssistant agent to own the warm-up prompts/answers this
   feature reads — so this builds the pair manually instead. */
describe('moderatorNotifier warm-up themes on conversationStarted (live LLM, for manual review)', () => {
  async function addModeratorNotifierAgent(conversation) {
    const moderatorChannel = await Channel.create({ name: 'moderator' })
    conversation.channels.push(moderatorChannel)
    const agent = new Agent({
      agentType: 'moderatorNotifier',
      conversation,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel
    })
    await agent.save()
    conversation.agents.push(agent)
    await conversation.save()
    await agent.start()
    return { agent, moderatorChannel }
  }

  async function addWarmUpAnswer(conversation, eventAssistantAgent, attendeeName: string, answerText: string) {
    const attendee = await createUser(attendeeName)
    const dmChannel = await Channel.create({
      name: `direct-${attendee._id}-${eventAssistantAgent._id}`,
      direct: true,
      participants: [attendee, eventAssistantAgent]
    })
    conversation.channels.push(dmChannel)
    await conversation.save()

    const prompt = await Message.create({
      body: { type: 'warmUpQuestion', text: 'What brought you here today?' },
      bodyType: 'json',
      prompt: { type: 'text' },
      conversation: conversation._id,
      pseudonym: eventAssistantAgent.pseudonyms[0].pseudonym,
      pseudonymId: eventAssistantAgent.pseudonyms[0]._id,
      channels: [dmChannel.name],
      fromAgent: true,
      visible: true
    })
    await Message.create({
      body: answerText,
      bodyType: 'text',
      conversation: conversation._id,
      pseudonym: attendee.pseudonyms[0].pseudonym,
      pseudonymId: attendee.pseudonyms[0]._id,
      owner: attendee._id,
      channels: [dmChannel.name],
      fromAgent: false,
      answersPrompt: prompt._id,
      visible: true
    })
  }

  async function setUpConversation(overrides: Record<string, unknown> = {}) {
    const owner = await createUser('Organizer')
    const topic = await createPublicTopic()
    const conversation = await createEventAssistantConversation(
      {
        name: 'Where Are All the Aliens?',
        description: 'A talk about the Fermi paradox and why we have not found extraterrestrial life.',
        preEventMinutes: 15,
        ...overrides
      },
      owner,
      topic,
      new Date(),
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const eventAssistantAgent = conversation.agents[0] as AgentDocument
    const { agent: moderatorNotifierAgent, moderatorChannel } = await addModeratorNotifierAgent(conversation)
    return { conversation, eventAssistantAgent, moderatorNotifierAgent, moderatorChannel }
  }

  function startedEvent(conversation): ConversationEvent {
    return { type: 'conversationStarted', conversationId: conversation._id.toString() }
  }

  it(
    'clusters warm-up answers into themes and posts them to the moderator channel',
    async () => {
      const { conversation, eventAssistantAgent, moderatorNotifierAgent, moderatorChannel } = await setUpConversation()

      await addWarmUpAnswer(conversation, eventAssistantAgent, 'Attendee One', 'I think we are just not looking hard enough')
      await addWarmUpAnswer(
        conversation,
        eventAssistantAgent,
        'Attendee Two',
        'Honestly I doubt intelligent life exists at all'
      )
      await addWarmUpAnswer(
        conversation,
        eventAssistantAgent,
        'Attendee Three',
        'Our telescopes probably are not sensitive enough yet'
      )

      const responses = await defaultAgentTypes.moderatorNotifier.onConversationEvent.call(
        moderatorNotifierAgent,
        startedEvent(conversation)
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].messageType).toBe('json')
      expect(responses[0].channels).toHaveLength(1)
      expect(responses[0].channels[0].name).toBe(moderatorChannel.name)

      const { questionResults } = responses[0].message as {
        questionResults: {
          questionType: string
          question: string
          format: string
          results: { label: string; count: number }[]
        }
      }
      expect(questionResults.questionType).toBe('warmUpQuestion')
      expect(questionResults.question).toBe('What brought you here today?')
      expect(questionResults.format).toBe('text')
      expect(questionResults.results.length).toBeGreaterThan(0)
      for (const result of questionResults.results) {
        expect(result.count).toBeGreaterThan(0)
      }

      console.log(`WARM-UP RESULTS (moderator channel):\n${JSON.stringify(questionResults, null, 2)}`)
    },
    testTimeout
  )

  it(
    'still reports a theme from a single warm-up answer (no minimum-respondent floor for moderators)',
    async () => {
      const { conversation, eventAssistantAgent, moderatorNotifierAgent, moderatorChannel } = await setUpConversation()

      await addWarmUpAnswer(
        conversation,
        eventAssistantAgent,
        'Attendee One',
        'Mostly just curious what the speaker will say'
      )

      const responses = await defaultAgentTypes.moderatorNotifier.onConversationEvent.call(
        moderatorNotifierAgent,
        startedEvent(conversation)
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].channels[0].name).toBe(moderatorChannel.name)
      const { questionResults } = responses[0].message as { questionResults: { results: { label: string }[] } }
      expect(questionResults.results.length).toBeGreaterThan(0)

      console.log(`WARM-UP RESULTS (single answer):\n${JSON.stringify(questionResults, null, 2)}`)
    },
    testTimeout
  )

  it(
    'posts nothing when there are no warm-up answers',
    async () => {
      const { conversation, moderatorNotifierAgent } = await setUpConversation()

      const responses = await defaultAgentTypes.moderatorNotifier.onConversationEvent.call(
        moderatorNotifierAgent,
        startedEvent(conversation)
      )

      expect(responses).toEqual([])
    },
    testTimeout
  )
})
