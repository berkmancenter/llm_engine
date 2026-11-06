/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createEventAssistantConversation, createPublicTopic, createUser } from '../../utils/agentTestHelpers.js'
import Channel from '../../../src/models/channel.model.js'
import Message from '../../../src/models/message.model.js'
import Agent from '../../../src/models/user.model/agent.model/index.js'
import { agentResponseToMessageData } from '../../../src/services/message.service.js'
import { ConversationEvent } from '../../../src/types/index.types.js'
import type { AgentDocument } from '../../../src/models/user.model/agent.model/index.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('eventAssistant')
const testTimeout = 90000

/* Live-LLM coverage of the warm-up question — format/gating and the race-resolution guarantee
   are already covered with a mocked LLM (eventAssistant.onConversationEvent.test.ts) and at the
   model level (agent.model.test.ts's setGeneratedContentIfAbsent suite). This exists to read
   what the model actually produces, and to exercise the real generation path end to end. */
describe('eventAssistant warm-up question (live LLM, for manual review)', () => {
  function buildPreEventConversationObj(overrides: Record<string, unknown> = {}) {
    return {
      scheduledTime: new Date(Date.now() + 5 * 60 * 1000), // 5 min until start
      preEventMinutes: 15, // window opened 10 min ago
      ...overrides
    }
  }

  async function addAttendeeChannel(conversation, agent, name: string) {
    const attendee = await createUser(name)
    const dmChannel = await Channel.create({
      name: `direct-${attendee._id}-${agent._id}`,
      direct: true,
      participants: [attendee, agent]
    })
    conversation.channels.push(dmChannel)
    await conversation.save()
    return { attendee, dmChannel }
  }

  function countdownTickEvent(conversation, overrides: Record<string, unknown> = {}): ConversationEvent {
    return {
      type: 'conversationWindowCountdown',
      conversationId: conversation._id.toString(),
      phase: 'preEvent',
      elapsedMs: 60000,
      remainingMs: 240000,
      ...overrides
    } as ConversationEvent
  }

  // Warm-up delivery is driven by conversationWindowCountdown ticking once a minute, not a
  // direct participantJoined handler (see sendWarmUpQuestionsToNewJoiners in eventAssistant.ts):
  // it reuses the tick already running for three facts rather than a second delivery mechanism,
  // and incidentally lands a little after the channel's own intro rather than on top of it.
  async function triggerWarmUpTick(conversation, agent) {
    const responses = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, countdownTickEvent(conversation))
    return responses.filter((r) => (r.message as { type?: string })?.type === 'warmUpQuestion')
  }

  async function joinAsNewAttendee(conversation, agent, name = 'New Attendee') {
    const { dmChannel } = await addAttendeeChannel(conversation, agent, name)
    const warmUps = await triggerWarmUpTick(conversation, agent)
    const warmUp = warmUps.find((r) => r.channels?.[0]?.name === dmChannel.name)
    expect(warmUp).toBeDefined()
    expect(warmUp!.channels).toHaveLength(1)
    return warmUp!
  }

  it(
    'generates a text question (the default) on conversationWindowOpened and sends the cached question on the next tick',
    async () => {
      const owner = await createUser('Organizer')
      const topic = await createPublicTopic()
      const conversation = await createEventAssistantConversation(
        buildPreEventConversationObj({
          name: 'Where Are All the Aliens?',
          description: 'A talk about the Fermi paradox and why we have not found extraterrestrial life.'
        }),
        owner,
        topic,
        new Date(),
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const agent = conversation.agents[0] as AgentDocument

      const windowEvent: ConversationEvent = {
        type: 'conversationWindowOpened',
        conversationId: conversation._id.toString(),
        phase: 'preEvent'
      }
      const windowResponses = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, windowEvent)
      expect(windowResponses).toEqual([])

      const refreshedAgent = await Agent.findById(agent._id)
      const cached = refreshedAgent!.generatedContent?.warmUpQuestion as { text: string; options?: string[] } | undefined
      expect(cached?.text).toBeTruthy()
      expect(cached?.options).toBeUndefined()

      const warmUp = await joinAsNewAttendee(conversation, agent, 'Attendee One')

      expect(warmUp.message).toEqual({ text: cached!.text, type: 'warmUpQuestion' })
      expect(warmUp.replyFormat).toEqual({ type: 'text' })

      console.log(`WARM-UP QUESTION (pre-generated, text):\n${cached!.text}`)
    },
    testTimeout
  )

  it(
    'generates a singleChoice question on conversationWindowOpened when explicitly configured',
    async () => {
      const owner = await createUser('Organizer')
      const topic = await createPublicTopic()
      const conversation = await createEventAssistantConversation(
        buildPreEventConversationObj({
          name: 'Where Are All the Aliens?',
          description: 'A talk about the Fermi paradox and why we have not found extraterrestrial life.'
        }),
        owner,
        topic,
        new Date(),
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const agent = conversation.agents[0] as AgentDocument
      agent.agentConfig = { ...agent.agentConfig, warmUpQuestion: { format: 'singleChoice' } }
      await agent.save()

      const windowEvent: ConversationEvent = {
        type: 'conversationWindowOpened',
        conversationId: conversation._id.toString(),
        phase: 'preEvent'
      }
      const windowResponses = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, windowEvent)
      expect(windowResponses).toEqual([])

      const refreshedAgent = await Agent.findById(agent._id)
      const cached = refreshedAgent!.generatedContent?.warmUpQuestion as { text: string; options?: string[] } | undefined
      expect(cached?.text).toBeTruthy()
      expect(cached?.options?.length).toBeGreaterThanOrEqual(2)
      expect(cached?.options?.length).toBeLessThanOrEqual(4)

      const warmUp = await joinAsNewAttendee(conversation, agent, 'Attendee One')

      expect(warmUp.message).toEqual({ text: cached!.text, type: 'warmUpQuestion' })
      expect(warmUp.replyFormat?.type).toBe('singleChoice')
      expect(warmUp.replyFormat?.options?.map((o) => o.value)).toEqual(cached!.options)

      console.log(
        `WARM-UP QUESTION (pre-generated, singleChoice):\n${cached!.text}\nOptions: ${JSON.stringify(cached!.options)}`
      )
    },
    testTimeout
  )

  it(
    'asks the identical question across concurrent generation attempts when nothing was pre-generated',
    async () => {
      const owner = await createUser('Organizer')
      const topic = await createPublicTopic()
      const conversation = await createEventAssistantConversation(
        buildPreEventConversationObj({
          name: 'Where Are All the Aliens?',
          description: 'A talk about the Fermi paradox and why we have not found extraterrestrial life.'
        }),
        owner,
        topic,
        new Date(),
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const agent = conversation.agents[0] as AgentDocument

      await addAttendeeChannel(conversation, agent, 'Attendee One')
      await addAttendeeChannel(conversation, agent, 'Attendee Two')

      // Nothing is pre-generated and nothing has been persisted yet, so both concurrent ticks
      // race straight into generation for both channels — this is the actual race
      // setGeneratedContentIfAbsent exists to resolve.
      const [firstBatch, secondBatch] = await Promise.all([
        triggerWarmUpTick(conversation, agent),
        triggerWarmUpTick(conversation, agent)
      ])

      const texts = [...firstBatch, ...secondBatch].map((r) => (r.message as { text: string }).text)
      expect(texts.length).toBeGreaterThanOrEqual(2)
      expect(new Set(texts).size).toBe(1)

      console.log(`WARM-UP QUESTION (concurrent generation, no pre-generation):\n${texts[0]}`)
    },
    testTimeout
  )

  it(
    'does not resend the warm-up question to a participant who already received one',
    async () => {
      const owner = await createUser('Organizer')
      const topic = await createPublicTopic()
      const conversation = await createEventAssistantConversation(
        buildPreEventConversationObj({ name: 'Where Are All the Aliens?' }),
        owner,
        topic,
        new Date(),
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const agent = conversation.agents[0] as AgentDocument

      const warmUp = await joinAsNewAttendee(conversation, agent, 'Attendee One')
      // onConversationEvent only builds the response; persisting it (what the real
      // conversationEvent job handler does via message.service.ts) is what the dedup check
      // reads, so the next tick below needs that write to have actually happened.
      const messageData = agentResponseToMessageData(warmUp, agent)
      await Message.create({ ...messageData, channels: messageData.channels?.map((c) => c.name) })

      const secondTick = await triggerWarmUpTick(conversation, agent)
      expect(secondTick).toEqual([])
    },
    testTimeout
  )

  it(
    'generates an open-ended text question with no options when so configured',
    async () => {
      const owner = await createUser('Organizer')
      const topic = await createPublicTopic()
      const conversation = await createEventAssistantConversation(
        buildPreEventConversationObj({
          name: 'Where Are All the Aliens?',
          description: 'A talk about the Fermi paradox and why we have not found extraterrestrial life.'
        }),
        owner,
        topic,
        new Date(),
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const agent = conversation.agents[0] as AgentDocument
      agent.agentConfig = { ...agent.agentConfig, warmUpQuestion: { format: 'text' } }
      await agent.save()

      const warmUp = await joinAsNewAttendee(conversation, agent, 'Attendee One')

      expect(warmUp.replyFormat).toEqual({ type: 'text' })
      expect((warmUp.message as { text: string }).text).toBeTruthy()

      console.log(`WARM-UP QUESTION (text format):\n${(warmUp.message as { text: string }).text}`)
    },
    testTimeout
  )

  it(
    'uses an organizer-supplied warm-up question verbatim, with the configured options',
    async () => {
      const owner = await createUser('Organizer')
      const topic = await createPublicTopic()
      const conversation = await createEventAssistantConversation(
        buildPreEventConversationObj({ name: 'Where Are All the Aliens?' }),
        owner,
        topic,
        new Date(),
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const agent = conversation.agents[0] as AgentDocument
      agent.agentConfig = {
        ...agent.agentConfig,
        warmUpQuestion: {
          source: 'organizer',
          format: 'singleChoice',
          text: 'What brought you to this event today?',
          options: ['Curiosity', 'A friend invited me', 'Professional interest']
        }
      }
      await agent.save()

      const warmUp = await joinAsNewAttendee(conversation, agent, 'Attendee One')

      expect(warmUp.message).toEqual({ text: 'What brought you to this event today?', type: 'warmUpQuestion' })
      expect(warmUp.replyFormat).toEqual({
        type: 'singleChoice',
        options: [
          { value: 'Curiosity', label: 'Curiosity' },
          { value: 'A friend invited me', label: 'A friend invited me' },
          { value: 'Professional interest', label: 'Professional interest' }
        ]
      })
    },
    testTimeout
  )

  it(
    'grounds the generated question in rich conversationContext',
    async () => {
      const owner = await createUser('Organizer')
      const topic = await createPublicTopic()
      const conversation = await createEventAssistantConversation(
        buildPreEventConversationObj({
          name: 'Where Are All the Aliens?',
          description: 'A talk about the Fermi paradox and why we have not found extraterrestrial life.',
          conversationContext: {
            conversationType: 'lecture',
            rationale: 'A new exoplanet survey was just published showing dozens of potentially habitable worlds.',
            centralQuestions: ['If habitable planets are common, why have we found no signs of life?'],
            knownTensions: ['Some astrobiologists argue we are looking for the wrong biosignatures entirely.'],
            desiredTakeaway: 'A sense of how close (or far) we actually are from answering this question.'
          }
        }),
        owner,
        topic,
        new Date(),
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const agent = conversation.agents[0] as AgentDocument

      const warmUp = await joinAsNewAttendee(conversation, agent, 'Attendee One')

      console.log(
        `WARM-UP QUESTION (rich conversationContext):\n${(warmUp.message as { text: string }).text}\n` +
          `Options: ${JSON.stringify(warmUp.replyFormat?.options)}`
      )
    },
    testTimeout
  )
})
