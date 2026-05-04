/* eslint-disable no-console */
import mongoose from 'mongoose'
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createUser,
  createConversation,
  createPublicTopic,
  createMessage,
  loadPartTimeWorkTranscript,
  loadAliensTranscript
} from '../../utils/agentTestHelpers.js'
import { Agent, Channel } from '../../../src/models/index.js'
import { ConversationHistory } from '../../../src/types/index.types.js'
import { newPublicTopic, insertTopics } from '../../fixtures/topic.fixture.js'

jest.setTimeout(300000)

const testConfig = setupAgentTest('eventHistorian')

const BOT_NAME = 'Berkie'

describe('eventHistorian agent tests', () => {
  let agent
  let conversation
  let topic
  let user1
  let user2
  let user3

  async function createEventHistorianConversation() {
    const conv = await createConversation({ name: 'Event Historian Test Conversation' }, user1, topic)
    const testAgent = new Agent({
      agentType: 'eventHistorian',
      conversation: conv,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel,
      agentConfig: { botName: BOT_NAME }
    })
    const channels = await Channel.create([{ name: 'eventHistorian' }])
    conv.channels.push(...channels)
    await testAgent.save()
    conv.agents.push(testAgent)
    await conv.save()
    await test
    await testAgent.start()
    return { conv, testAgent }
  }

  beforeEach(async () => {
    topic = await createPublicTopic()
    user1 = await createUser('Alice')
    user2 = await createUser('Bob')
    user3 = await createUser('Carol')
    const result = await createEventHistorianConversation()
    conversation = result.conv
    agent = result.testAgent
  })

  function buildHistory(messages): ConversationHistory {
    return {
      start: new Date(Date.now() - 60 * 60 * 1000),
      end: new Date(),
      messages
    }
  }

  async function ask(body, user = user1) {
    console.log(`Q (${user.pseudonyms[0].pseudonym}): ${body}`)
    return createMessage(body, user, conversation, ['historian'])
  }

  async function respond(history: ConversationHistory, userMessage) {
    const responses = await defaultAgentTypes.eventHistorian.respond.call(agent, history, userMessage)
    console.log(`A: ${responses[0]?.message}`)
    return responses
  }

  it('responds to a direct @mention with no prior history', async () => {
    const msg = await ask(`@${BOT_NAME} what is the capital of France?`)
    const responses = await respond(buildHistory([]), msg)

    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBeDefined()
    expect(responses[0].message.toLowerCase()).toContain('paris')
  })

  it('responds sensibly with multi-user history containing consecutive user messages', async () => {
    // Simulate a multi-user group chat where multiple users post back-to-back
    // without any agent response in between — this creates consecutive 'user' role
    // messages that previously triggered placeholder injection
    const t = Date.now()
    const history = buildHistory([
      await createMessage(
        'Anyone know a good way to learn TypeScript?',
        user1,
        conversation,
        ['historian'],
        new Date(t - 5000)
      ),
      await createMessage(
        'I found the official docs really helpful',
        user2,
        conversation,
        ['historian'],
        new Date(t - 4000)
      ),
      await createMessage(
        'Same, plus the TS playground is great for experimenting',
        user3,
        conversation,
        ['historian'],
        new Date(t - 3000)
      ),
      await createMessage('What about books?', user2, conversation, ['historian'], new Date(t - 2000)),
      await createMessage(
        'Programming TypeScript by Boris Cherny is solid',
        user1,
        conversation,
        ['historian'],
        new Date(t - 1000)
      )
    ])

    const msg = await ask(`@${BOT_NAME} can you summarize the best ways to learn TypeScript?`)
    const responses = await respond(history, msg)

    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBeDefined()
    // Should synthesize the conversation — mention at least one concrete resource
    expect(responses[0].message.toLowerCase()).toMatch(/docs|playground|book|typescript/)
  })

  it('uses prior conversation context when answering a follow-up', async () => {
    // Agent's own prior response should appear as 'assistant' role in history
    const t = Date.now()
    const agentPriorResponse = {
      body: 'The Eiffel Tower is located in Paris, France.',
      bodyType: 'text',
      conversation: conversation._id,
      pseudonym: BOT_NAME,
      pseudonymId: new mongoose.Types.ObjectId(),
      owner: agent._id,
      channels: ['historian'],
      fromAgent: true,
      visible: true,
      createdAt: new Date(t - 2000),
      updatedAt: new Date(t - 2000),
      upVotes: [],
      downVotes: [],
      pause: false
    }

    const history = buildHistory([
      await createMessage(`@${BOT_NAME} where is the Eiffel Tower?`, user1, conversation, ['historian'], new Date(t - 3000)),
      agentPriorResponse,
      await createMessage('Interesting!', user2, conversation, ['historian'], new Date(t - 1000))
    ])

    const msg = await ask(`@${BOT_NAME} how tall is it?`)
    const responses = await respond(history, msg)

    // Should reference the Eiffel Tower from context without needing it re-stated
    expect(responses[0].message.toLowerCase()).toMatch(/\d+\s*(meter|metre|feet|foot|m\b|ft\b)/)
  })

  describe('answers event history questions using event history tools', () => {
    let eventTopic
    let partTimeConv
    let aliensConv
    let eventHistorian
    let eventConversation

    beforeEach(async () => {
      // Create a dedicated topic holding the event series
      eventTopic = newPublicTopic()
      await insertTopics([eventTopic])

      // Two past events in that series with realistic dates in the current year
      partTimeConv = await createConversation(
        {
          name: 'Why your company should consider part-time work',
          description: `No one wants to work anymore." Entrepreneur Jessica Drain believes otherwise—instead it's that businesses aren't structuring jobs to attract and retain the widest number of people possible, including those with a limited number of hours to give to a career. 

Speaking about her own experience as a single mother and professional, Jessica delineates how she's grown a seven-figure business in part-time hours with a small team of part-time employees, and how recent research shows that jobs with lower hour requirements improve employee recruitment, retention, and productivity – not the other way around.  A career marketer and graphic designer, Jessica has helped businesses brand and market themselves for almost two decades.

In 2018, she and her sister innovated a new tool for the sewing world – SewTites® Magnetic Sewing Pins™ – and founded a company with the same name.

Since then, Jessica has led the company to a 7-figure annual business – all in part-time hours with a small team of part-time employees.

A single mom of two children with primary custody, she is passionate about finding value in and creating work for people who don’t have the desire or ability to work full-time hours but still want and need to earn a living.`,
          presenters: [{ name: 'Jessica Drain', bio: 'Entrepreneur and advocate for flexible work arrangements' }]
        },
        user1,
        eventTopic,
        new Date('2026-01-15T18:00:00Z')
      )
      aliensConv = await createConversation(
        {
          name: 'Where are all the aliens?',
          description: `The universe is incredibly old, astoundingly vast and populated by trillions of planets -- so where are all the aliens? Astronomer Stephen Webb has an explanation: we're alone in the universe. In a mind-expanding talk, he spells out the remarkable barriers a planet would need to clear in order to host an extraterrestrial civilization -- and makes a case for the beauty of our potential cosmic loneliness. "The silence of the universe is shouting, 'We're the creatures who got lucky,'" Webb says.`,
          presenters: [
            {
              name: 'Stephen Webb',
              bio: 'Stephen Webb is a physicist and author of numerous popular science and math books, as well as academic publications.'
            }
          ]
        },
        user1,
        eventTopic,
        new Date('2026-03-10T18:00:00Z')
      )

      // Load transcripts into both per-conversation and topic-level vector stores
      await loadPartTimeWorkTranscript(partTimeConv, true)
      await loadAliensTranscript(aliensConv, true)

      // Create an eventHistorian agent configured to know about this event series
      eventConversation = await createConversation({ name: 'Event Historian Test' }, user1, topic)
      eventHistorian = new Agent({
        agentType: 'eventHistorian',
        conversation: eventConversation,
        llmPlatform: testConfig.llmPlatform,
        llmModel: testConfig.llmModel,
        agentConfig: { botName: BOT_NAME, topicIds: [eventTopic._id.toString()] }
      })
      const channels = await Channel.create([{ name: 'historian' }])
      eventConversation.channels.push(...channels)
      await eventHistorian.save()
      eventConversation.agents.push(eventHistorian)
      await eventConversation.save()
      await eventHistorian.start()
    })

    async function askEventHistorian(body: string) {
      console.log(`Q: ${body}`)
      const msg = await createMessage(body, user1, eventConversation, ['historian'])
      const responses = await defaultAgentTypes.eventHistorian.respond.call(eventHistorian, buildHistory([]), msg)
      console.log(`A: ${responses[0]?.message}`)
      return responses
    }

    it('lists all events since January with one-sentence summaries', async () => {
      const responses = await askEventHistorian(
        `@${BOT_NAME} give me a one sentence summary and name of all events since January 2026`
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      // Should name both events that exist in the series
      expect(responses[0].message).toContain('Why your company should consider part-time work')
      expect(responses[0].message).toContain('Where are all the aliens?')
    })

    it('identifies a speaker on extraterrestrials and UFOs', async () => {
      const responses = await askEventHistorian(`@${BOT_NAME} who was the speaker we had that talked about UFOs and aliens?`)

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      expect(responses[0].message.toLowerCase()).toMatch(/Webb/i)
    })

    it('identifies which events covered part-time work and flexible employment', async () => {
      const responses = await askEventHistorian(`@${BOT_NAME} which events covered part-time work or flexible employment?`)

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      expect(responses[0].message).toContain('Why your company should consider part-time work')
      expect(responses[0].message.toLowerCase()).toMatch(/part.time|flexib|work/)
    })

    it('retrieves what a specific presenter said on a specific topic at a specific event', async () => {
      const responses = await askEventHistorian(
        `@${BOT_NAME} what did Jessica say about working 40 hours per week at the part-time work event?`
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      // Jessica's transcript explicitly challenges the 40-hour full-time norm
      expect(responses[0].message.toLowerCase()).toMatch(/40 hours|fulltime|full.time|framework|hundred years/)
    })
  })

  describe('uses all public topics when topicIds is not configured', () => {
    let eventTopic
    let partTimeConv
    let aliensConv
    let eventHistorianNoTopicIds
    let eventConversation

    beforeEach(async () => {
      // Create a public topic — not passed to agentConfig, should be auto-discovered
      eventTopic = newPublicTopic()
      await insertTopics([eventTopic])

      partTimeConv = await createConversation(
        {
          name: 'Why your company should consider part-time work',
          description: 'Talk by Jessica Drain about building a seven-figure business with part-time employees.',
          presenters: [{ name: 'Jessica Drain', bio: 'Entrepreneur and advocate for flexible work arrangements' }]
        },
        user1,
        eventTopic,
        new Date('2026-01-15T18:00:00Z')
      )
      aliensConv = await createConversation(
        {
          name: 'Where are all the aliens?',
          description: 'Astronomer Stephen Webb makes the case that we may be alone in the universe.',
          presenters: [{ name: 'Stephen Webb', bio: 'Physicist and popular science author.' }]
        },
        user1,
        eventTopic,
        new Date('2026-03-10T18:00:00Z')
      )

      await loadPartTimeWorkTranscript(partTimeConv, true)
      await loadAliensTranscript(aliensConv, true)

      // Agent created with NO topicIds — should fall back to all public topics
      eventConversation = await createConversation({ name: 'Event Historian No TopicIds Test' }, user1, topic)
      eventHistorianNoTopicIds = new Agent({
        agentType: 'eventHistorian',
        conversation: eventConversation,
        llmPlatform: testConfig.llmPlatform,
        llmModel: testConfig.llmModel,
        agentConfig: { botName: BOT_NAME }
      })
      const channels = await Channel.create([{ name: 'historian' }])
      eventConversation.channels.push(...channels)
      await eventHistorianNoTopicIds.save()
      eventConversation.agents.push(eventHistorianNoTopicIds)
      await eventConversation.save()
      await eventHistorianNoTopicIds.start()
    })

    async function askNoTopicIds(body: string) {
      console.log(`Q: ${body}`)
      const msg = await createMessage(body, user1, eventConversation, ['historian'])
      const responses = await defaultAgentTypes.eventHistorian.respond.call(eventHistorianNoTopicIds, buildHistory([]), msg)
      console.log(`A: ${responses[0]?.message}`)
      return responses
    }

    it('lists events from auto-discovered public topics', async () => {
      const responses = await askNoTopicIds(
        `@${BOT_NAME} give me a one sentence summary and name of all events since January 2026`
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      expect(responses[0].message).toContain('Why your company should consider part-time work')
      expect(responses[0].message).toContain('Where are all the aliens?')
    })

    it('answers a speaker question using auto-discovered topics', async () => {
      const responses = await askNoTopicIds(`@${BOT_NAME} who was the speaker that talked about aliens?`)

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      expect(responses[0].message.toLowerCase()).toMatch(/webb/i)
    })
  })
})
