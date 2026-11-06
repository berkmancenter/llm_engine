/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createEventAssistantConversation, createPublicTopic, createUser } from '../../utils/agentTestHelpers.js'
import { ConversationEvent } from '../../../src/types/index.types.js'
import { PREGAME_CHANNEL } from '../../../src/conversations/eventAssistant.js'
import Message from '../../../src/models/message.model.js'
import { agentResponseToMessageData } from '../../../src/services/message.service.js'
import type { AgentDocument } from '../../../src/models/user.model/agent.model/index.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('eventAssistant')
const testTimeout = 90000

/* Live-LLM coverage of the actual generated content — format/gating is already covered with a
   mocked LLM in tests/unit/agents/eventAssistant/eventAssistant.onConversationEvent.test.ts.
   This exists to actually read what the model produces, not just assert its shape. */
describe('eventAssistant three facts on conversationWindowCountdown (live LLM, for manual review)', () => {
  async function postThreeFacts(conversation, agent) {
    const event: ConversationEvent = {
      type: 'conversationWindowCountdown',
      conversationId: conversation._id.toString(),
      phase: 'preEvent',
      elapsedMs: 60000,
      remainingMs: 240000
    }
    const responses = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, event)
    expect(responses).toHaveLength(1)
    expect(responses[0].messageType).toBe('json')
    expect(responses[0].message.type).toBe('threeFacts')
    expect(responses[0].channels).toHaveLength(1)
    expect(responses[0].channels[0].name).toBe(PREGAME_CHANNEL)

    const { facts, invitation } = responses[0].message as { facts: string[]; invitation: string }
    expect(facts.length).toBeGreaterThan(0)
    expect(facts.length).toBeLessThanOrEqual(3)
    expect(invitation).toBeTruthy()
    return `${facts.map((fact) => `- ${fact}`).join('\n')}\n${invitation}`
  }

  function buildPreEventConversationObj(overrides: Record<string, unknown> = {}) {
    return {
      scheduledTime: new Date(Date.now() + 5 * 60 * 1000), // 5 min until start
      preEventMinutes: 15, // window opened 10 min ago
      ...overrides
    }
  }

  it(
    'uses rich conversationContext to ground the facts in what the session is actually about',
    async () => {
      const owner = await createUser('Organizer')
      const topic = await createPublicTopic()
      const conversation = await createEventAssistantConversation(
        buildPreEventConversationObj({
          name: 'Where Are All the Aliens?',
          description: 'A talk about the Fermi paradox and why we have not found extraterrestrial life.',
          presenters: [{ name: 'Dr. Vega', bio: 'Astrobiologist studying exoplanet atmospheres for biosignatures.' }],
          conversationContext: {
            conversationType: 'lecture',
            rationale: 'A new exoplanet survey was just published showing dozens of potentially habitable worlds.',
            centralQuestions: ['If habitable planets are common, why have we found no signs of life?'],
            knownTensions: ['Some astrobiologists argue we are looking for the wrong biosignatures entirely.'],
            scope: { inScope: ['the Fermi paradox', 'biosignature detection'], outOfScope: ['UFO sightings'] },
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

      const text = await postThreeFacts(conversation, agent)
      console.log(`THREE FACTS (rich conversationContext):\n${text}`)
    },
    testTimeout
  )

  it(
    'falls back to mining the description when conversationContext is empty',
    async () => {
      const owner = await createUser('Organizer')
      const topic = await createPublicTopic()
      const conversation = await createEventAssistantConversation(
        buildPreEventConversationObj({
          name: 'Where Are All the Aliens?',
          description:
            'A new exoplanet survey just turned up dozens of potentially habitable worlds, reviving the ' +
            'decades-old Fermi paradox: if habitable planets are common, why have we found no signs of life? ' +
            'Some astrobiologists argue we have been looking for the wrong biosignatures entirely. This talk ' +
            'will not cover UFO sightings or speculative first-contact scenarios — the goal is to leave with a ' +
            'real sense of how close we actually are to answering the question.',
          presenters: [{ name: 'Dr. Vega', bio: 'Astrobiologist studying exoplanet atmospheres for biosignatures.' }]
          // No conversationContext at all — this is the common case until the smart event builder exists.
        }),
        owner,
        topic,
        new Date(),
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const agent = conversation.agents[0] as AgentDocument

      const text = await postThreeFacts(conversation, agent)
      console.log(`THREE FACTS (description-only fallback):\n${text}`)
    },
    testTimeout
  )

  it(
    'reflects the configured personality when one is set',
    async () => {
      const owner = await createUser('Organizer')
      const topic = await createPublicTopic()
      const conversation = await createEventAssistantConversation(
        buildPreEventConversationObj({
          name: 'Where Are All the Aliens?',
          description: 'A talk about the Fermi paradox and why we have not found extraterrestrial life.',
          presenters: [{ name: 'Dr. Vega', bio: 'Astrobiologist studying exoplanet atmospheres for biosignatures.' }]
        }),
        owner,
        topic,
        new Date(),
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const agent = conversation.agents[0] as AgentDocument
      agent.agentConfig = { ...agent.agentConfig, personality: 'sarcastic-expert' }
      await agent.save()

      const text = await postThreeFacts(conversation, agent)
      console.log(`THREE FACTS (sarcastic-expert personality):\n${text}`)
    },
    testTimeout
  )

  it(
    'does not post a second time once three facts already exist in the pregame channel',
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

      const firstTickEvent: ConversationEvent = {
        type: 'conversationWindowCountdown',
        conversationId: conversation._id.toString(),
        phase: 'preEvent',
        elapsedMs: 60000,
        remainingMs: 240000
      }
      const [response] = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, firstTickEvent)
      // onConversationEvent only builds the response; actually persisting it (what the real
      // conversationEvent job handler does via message.service.ts) is what the dedup check reads,
      // so the second tick below needs that write to have actually happened.
      const messageData = agentResponseToMessageData(response, agent)
      await Message.create({ ...messageData, channels: messageData.channels?.map((c) => c.name) })

      const secondTickEvent: ConversationEvent = {
        type: 'conversationWindowCountdown',
        conversationId: conversation._id.toString(),
        phase: 'preEvent',
        elapsedMs: 120000,
        remainingMs: 180000
      }
      const secondTick = await defaultAgentTypes.eventAssistant.onConversationEvent.call(agent, secondTickEvent)
      expect(secondTick).toEqual([])
    },
    testTimeout
  )

  describe('parseOutput', () => {
    it('flattens a threeFacts JSON message into plain text for adapters with no .text field to read', async () => {
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

      const agentMsg = new Message({
        body: { type: 'threeFacts', facts: ['Fact one', 'Fact two', 'Fact three'], invitation: 'Say hello below!' },
        bodyType: 'json',
        conversation: conversation._id,
        pseudonym: agent.pseudonyms[0].pseudonym,
        pseudonymId: agent.pseudonyms[0]._id
      })

      const translatedMsg = await defaultAgentTypes.eventAssistant.parseOutput(agentMsg)
      expect(translatedMsg).toMatchObject({
        ...agentMsg.toObject(),
        body: '- Fact one\n- Fact two\n- Fact three\nSay hello below!',
        bodyType: 'text'
      })
    })
  })
})
