/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createUser,
  createConversation,
  createDirectMessage,
  createEventAssistantWithSeriesHistoryConversation,
  loadPartTimeWorkTranscript,
  loadAliensTranscript,
  loadTestTranscript
} from '../../utils/agentTestHelpers.js'
import { newPublicTopic, insertTopics } from '../../fixtures/topic.fixture.js'

// A short live transcript for the CURRENT event — on-topic for a multi-session series about
// flexible work so that temporal questions aren't classified OFF_TOPIC, but deliberately free
// of any content from the two prior sessions (aliens / part-time work speaker details).
const CURRENT_EVENT_TRANSCRIPT = [
  '00:05 | Host: welcome back everyone, this is the third session of our ongoing series',
  '00:12 | Host: today we will be discussing upcoming plans and what we have learned so far',
  '00:20 | Host: feel free to ask any questions about the series or prior sessions'
].join('\n')

jest.setTimeout(300000)

const testConfig = setupAgentTest('eventAssistant')
const testTimeout = 180000

describe('eventAssistant temporal reference resolution (series history)', () => {
  let agent
  let conversation
  let user
  let topic
  let sessionA // 14 days ago — aliens transcript
  let sessionB // 7 days ago — part-time work transcript (Jessica Drain)

  beforeEach(async () => {
    user = await createUser('Temporal Query Tester')
    topic = newPublicTopic()
    await insertTopics([topic])

    const now = new Date()
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

    // Session A — 2 sessions ago. Aliens transcript: distinctive content about extraterrestrial
    // cinema. This name ("Cinema & Culture") is intentionally different from Session B so the
    // LLM can distinguish the events by name after calling get_event_list.
    sessionA = await createConversation(
      {
        name: 'Cinema and Culture: Aliens on Screen',
        description: 'Exploring how extraterrestrial life is depicted in popular film.'
      },
      user,
      topic,
      fourteenDaysAgo
    )
    await loadAliensTranscript(sessionA, true)

    // Session B — 1 session ago ("last week"). Part-time work transcript: Jessica Drain is a
    // fictional speaker whose name cannot come from model weights — only from the series transcript.
    sessionB = await createConversation(
      {
        name: 'Why your company should consider part-time work',
        description: 'Entrepreneur Jessica Drain on structuring jobs around part-time work and flexibility.',
        presenters: [{ name: 'Jessica Drain', bio: 'Entrepreneur and advocate for flexible, part-time work arrangements.' }]
      },
      user,
      topic,
      sevenDaysAgo
    )
    await loadPartTimeWorkTranscript(sessionB, true)

    // Current event — seriesHistory ON, excludes its own transcript from series search results.
    conversation = await createEventAssistantWithSeriesHistoryConversation(
      {
        name: 'Series follow-up: questions and reflections',
        description: 'A follow-up session to our ongoing multi-topic series.'
      },
      user,
      topic,
      now,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    ;[agent] = conversation.agents
    await loadTestTranscript(conversation, CURRENT_EVENT_TRANSCRIPT, false)
  })

  it(
    'answers "2 sessions ago" with content from Session A (aliens), not Session B',
    async () => {
      const msg = await createDirectMessage(
        'What was discussed 2 sessions ago?',
        user,
        conversation
      )
      console.log(`Q: ${msg.body}`)

      const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [] }, msg)

      expect(responses).toHaveLength(1)
      const answer = responses[0].messageType === 'json' ? responses[0].message.text : responses[0].message
      console.log(`A: ${answer}`)

      // Session A (14 days ago, index [1] in most-recent-first list) is "2 sessions ago".
      // The aliens transcript is the only source of this content — it cannot come from model weights.
      expect(answer.toLowerCase()).toMatch(/alien|cinema|extraterrestrial|film/)
    },
    testTimeout
  )

  it(
    'answers "last week" with content from Session B (part-time work / Jessica Drain)',
    async () => {
      const msg = await createDirectMessage(
        'What was the session last week about?',
        user,
        conversation
      )
      console.log(`Q: ${msg.body}`)

      const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [] }, msg)

      expect(responses).toHaveLength(1)
      const answer = responses[0].messageType === 'json' ? responses[0].message.text : responses[0].message
      console.log(`A: ${answer}`)

      // Session B (7 days ago) falls within "last week" by any reasonable calendar interpretation.
      // Jessica Drain is fictional — her name can only come from the series transcript.
      expect(answer.toLowerCase()).toMatch(/jessica|part.time|flexible|employment/)
    },
    testTimeout
  )
})
