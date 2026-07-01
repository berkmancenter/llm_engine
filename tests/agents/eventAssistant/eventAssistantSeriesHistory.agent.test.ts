/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createUser,
  createConversation,
  createDirectMessage,
  createEventAssistantWithSeriesHistoryConversation,
  loadPartTimeWorkTranscript,
  loadTestTranscript
} from '../../utils/agentTestHelpers.js'
import { newPublicTopic, insertTopics } from '../../fixtures/topic.fixture.js'

// A short live transcript for the CURRENT event: on-topic for the part-time-work series (so the
// question is not classified OFF_TOPIC) but deliberately free of the prior speaker's name.
const CURRENT_EVENT_TRANSCRIPT = [
  '00:05 | Host: welcome back to our ongoing series on part time work and flexible employment',
  '00:12 | Host: today is a follow up session about building a business with part time teams',
  '00:20 | Host: send along your questions about part time work strategies'
].join('\n')

jest.setTimeout(300000)

const testConfig = setupAgentTest('eventAssistant')
const testTimeout = 180000

describe('eventAssistant series history', () => {
  test('eventAssistant agent config defaults seriesHistory to false (organizer opt-in)', () => {
    expect(defaultAgentTypes.eventAssistant.agentConfig.seriesHistory).toBe(false)
  })

  describe('answerQuestion with seriesHistory enabled', () => {
    let agent
    let conversation
    let user1
    let topic
    const pastEventStart = new Date('2025-03-01T18:00:00Z')
    const currentEventStart = new Date(Date.now() - 15 * 60 * 1000)

    beforeEach(async () => {
      user1 = await createUser('Curious Cat')
      // Insert the topic directly so it exists in the DB with a known _id — the agent resolves its
      // containing series via Topic.findById(conversation.topic) at runtime.
      topic = newPublicTopic()
      await insertTopics([topic])

      // A PRIOR event in the same series, with its transcript + presenter metadata in the
      // topic ("series") collection. Jessica Drain is fictional — a correct mention can only
      // come from searching this past event's transcript, not from the model's general knowledge.
      const pastEvent = await createConversation(
        {
          name: 'Why your company should consider part-time work',
          description: 'Entrepreneur Jessica Drain on structuring jobs around part-time work and flexibility.',
          presenters: [
            { name: 'Jessica Drain', bio: 'Entrepreneur and advocate for flexible, part-time work arrangements.' }
          ]
        },
        user1,
        topic,
        pastEventStart
      )
      await loadPartTimeWorkTranscript(pastEvent, true)

      // The CURRENT event — a later session in the SAME part-time-work series, with seriesHistory
      // enabled. Its live transcript is on-topic but never names the prior speaker, so a correct
      // "Jessica" answer can only come from searching the prior event via the series tools.
      conversation = await createEventAssistantWithSeriesHistoryConversation(
        {
          name: 'Part-time work: follow-up Q&A',
          description: 'A follow-up session in our series on part-time work and flexible employment.'
        },
        user1,
        topic,
        currentEventStart,
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      ;[agent] = conversation.agents
      await loadTestTranscript(conversation, CURRENT_EVENT_TRANSCRIPT, false)
    })

    it(
      'answers a question about a prior event in the series using the event_history tools',
      async () => {
        const msg = await createDirectMessage(
          'I missed the earlier session in this series. Who was the speaker that gave the main talk about part-time work?',
          user1,
          conversation
        )
        console.log(`Q: ${msg.body}`)

        // web_search stays enabled (the production default) — this also verifies the series-history
        // tools win over the absolute web-search mandate for a question about a prior event, since
        // the prior speaker's name lives only in the private series transcript, not on the web.
        const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [] }, msg)

        expect(responses).toHaveLength(1)
        const answer = responses[0].messageType === 'json' ? responses[0].message.text : responses[0].message
        console.log(`A: ${answer}`)

        // "Jessica" only exists in the prior event's transcript/metadata — its presence proves the
        // series-history tools were reachable and used across events.
        expect(answer.toLowerCase()).toMatch(/jessica/)
      },
      testTimeout
    )
  })
})
