/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createEventAssistantConversation, createPublicTopic, createUser } from '../../utils/agentTestHelpers.js'
import Channel from '../../../src/models/channel.model.js'
import Message from '../../../src/models/message.model.js'
import { ConversationEvent } from '../../../src/types/index.types.js'
import type { AgentDocument } from '../../../src/models/user.model/agent.model/index.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('eventAssistant')
const testTimeout = 90000

/* Live-LLM coverage of the actual generated recap — format/gating is already covered with a
   mocked LLM in tests/unit/agents/eventAssistant/eventAssistant.onConversationEvent.test.ts.
   This exists to actually read what the model produces from real pregame chat and warm-up
   answers, not just assert its shape. conversationStarted is fired by calling
   onConversationEvent directly (as the other eventAssistant live-LLM tests do), rather than
   through doStartConversation/agentDispatcher, since those are plumbing already covered by
   tests/services/conversation.service.test.ts's dispatch assertion. */
describe('eventAssistant pregame recap on conversationStarted (live LLM, for manual review)', () => {
  function startedEvent(conversation): ConversationEvent {
    return { type: 'conversationStarted', conversationId: conversation._id.toString() }
  }

  async function addPregameChatMessage(conversation, speakerName: string, text: string) {
    const speaker = await createUser(speakerName)
    await Message.create({
      body: text,
      bodyType: 'text',
      conversation: conversation._id,
      pseudonym: speaker.pseudonyms[0].pseudonym,
      pseudonymId: speaker.pseudonyms[0]._id,
      owner: speaker._id,
      channels: ['pregame'],
      fromAgent: false,
      visible: true
    })
  }

  async function addWarmUpAnswer(conversation, agent, attendeeName: string, answerText: string) {
    const attendee = await createUser(attendeeName)
    const dmChannel = await Channel.create({
      name: `direct-${attendee._id}-${agent._id}`,
      direct: true,
      participants: [attendee, agent]
    })
    conversation.channels.push(dmChannel)
    await conversation.save()

    const prompt = await Message.create({
      body: { type: 'warmUpQuestion', text: 'What brought you here today?' },
      bodyType: 'json',
      conversation: conversation._id,
      pseudonym: agent.pseudonyms[0].pseudonym,
      pseudonymId: agent.pseudonyms[0]._id,
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
        // onConversationEvent bails before any query when this isn't configured — a pregame
        // window must have existed for there to be anything to recap.
        preEventMinutes: 15,
        ...overrides
      },
      owner,
      topic,
      new Date(), // startTime set, same as doStartConversation would have done by this point
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    return { conversation, agent: conversation.agents[0] as AgentDocument }
  }

  it(
    'synthesizes pregame chat and warm-up answers into one recap posted to the live chat channel',
    async () => {
      const { conversation, agent } = await setUpConversation()

      await addPregameChatMessage(conversation, 'Attendee One', 'I think the Great Filter is already behind us')
      await addPregameChatMessage(conversation, 'Attendee Two', 'The Zoo Hypothesis is way more fun to think about')
      await addWarmUpAnswer(conversation, agent, 'Attendee Three', 'Mostly curiosity about whether we are alone')

      const responses = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, startedEvent(conversation))

      expect(responses).toHaveLength(1)
      expect(responses[0].messageType).toBe('json')
      expect(responses[0].message.type).toBe('pregameRecap')
      expect(responses[0].channels).toHaveLength(1)
      expect(responses[0].channels[0].name).toBe('chat')

      const text = responses[0].message.text as string
      expect(text.length).toBeGreaterThan(0)
      console.log(`PREGAME RECAP (chat + warm-up):\n${text}`)
    },
    testTimeout
  )

  it(
    'recaps from pregame chat alone when there were no warm-up answers',
    async () => {
      const { conversation, agent } = await setUpConversation()

      await addPregameChatMessage(conversation, 'Attendee One', 'Anyone else excited for this talk?')
      await addPregameChatMessage(conversation, 'Attendee Two', 'Been waiting for this one all week')

      const responses = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, startedEvent(conversation))

      expect(responses).toHaveLength(1)
      const text = responses[0].message.text as string
      console.log(`PREGAME RECAP (chat only):\n${text}`)
    },
    testTimeout
  )

  it(
    'recaps from warm-up answers alone when pregame chat was quiet',
    async () => {
      const { conversation, agent } = await setUpConversation()

      await addWarmUpAnswer(conversation, agent, 'Attendee One', 'I am hoping to learn something that changes my mind')
      await addWarmUpAnswer(conversation, agent, 'Attendee Two', 'Mostly here for the free swag, honestly')

      const responses = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, startedEvent(conversation))

      expect(responses).toHaveLength(1)
      const text = responses[0].message.text as string
      console.log(`PREGAME RECAP (warm-up only):\n${text}`)
    },
    testTimeout
  )

  it(
    'posts nothing when there is no pregame chat and no warm-up answers',
    async () => {
      const { conversation, agent } = await setUpConversation()

      const responses = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, startedEvent(conversation))

      expect(responses).toEqual([])
    },
    testTimeout
  )

  it(
    'treats a single warm-up answer as if there were none (the MIN_WARM_UP_RESPONDENTS floor)',
    async () => {
      const { conversation, agent } = await setUpConversation()

      await addPregameChatMessage(conversation, 'Attendee One', 'Looking forward to this!')
      await addWarmUpAnswer(conversation, agent, 'Attendee Two', 'Honestly just here because a friend invited me')

      const responses = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, startedEvent(conversation))

      expect(responses).toHaveLength(1)
      const text = (responses[0].message.text as string).toLowerCase()
      expect(text).not.toContain('friend invited me')
      console.log(`PREGAME RECAP (single warm-up answer should be withheld):\n${text}`)
    },
    testTimeout
  )

  it(
    'does not overclaim consensus from just two warm-up answers',
    async () => {
      const { conversation, agent } = await setUpConversation()

      await addWarmUpAnswer(conversation, agent, 'Attendee One', 'Honestly just here because a friend invited me')
      await addWarmUpAnswer(conversation, agent, 'Attendee Two', 'Curious whether the data backs up the hype')

      const responses = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, startedEvent(conversation))

      expect(responses).toHaveLength(1)
      const text = (responses[0].message.text as string).toLowerCase()
      expect(text).not.toMatch(/everyone|most people|the group feels|consensus/)
      console.log(`PREGAME RECAP (two warm-up answers, checking for overclaiming):\n${text}`)
    },
    testTimeout
  )
})
