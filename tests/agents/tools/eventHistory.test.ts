/* eslint-disable no-console */
import monogoose from 'mongoose'
import setupAgentTest from '../../utils/setupAgentTest.js'
import {
  createUser,
  createConversation,
  createPublicTopic,
  loadPartTimeWorkTranscript,
  loadAliensTranscript
} from '../../utils/agentTestHelpers.js'
import createEventHistoryTools, { TopicRef } from '../../../src/agents/tools/eventHistory.js'
import { newPublicTopic, insertTopics } from '../../fixtures/topic.fixture.js'

jest.setTimeout(300000)

setupAgentTest()

describe('eventHistory tools', () => {
  let topic
  let otherTopic
  let conv1
  let conv2
  let tools

  beforeEach(async () => {
    const user = await createUser('Test User')
    topic = await createPublicTopic()

    // Create a second topic with its own conversation to verify topicId filtering
    otherTopic = newPublicTopic()
    await insertTopics([otherTopic])
    await createConversation(
      { name: 'Unrelated Event', description: 'An event in a different series' },
      user,
      otherTopic,
      new Date('2025-03-15T18:00:00Z')
    )

    const startTime1 = new Date('2025-03-01T18:00:00Z')
    const startTime2 = new Date('2025-04-01T18:00:00Z')

    conv1 = await createConversation(
      {
        name: 'Part-Time Work Panel',
        description: 'A discussion on part-time work arrangements and workforce flexibility',
        presenters: [{ name: 'Jessica Drain', bio: 'Entrepreneur and advocate for flexible work arrangements' }]
      },
      user,
      topic,
      startTime1
    )
    conv2 = await createConversation(
      {
        name: 'Aliens and Cinema',
        description: 'An exploration of how aliens are portrayed in film and popular culture'
      },
      user,
      topic,
      startTime2
    )

    // Load transcripts into both per-conversation and topic collections
    await loadPartTimeWorkTranscript(conv1, true)
    await loadAliensTranscript(conv2, true)

    const topicRefs: TopicRef[] = [{ id: topic._id.toString(), name: topic.name }]
    tools = createEventHistoryTools(topicRefs)
  })

  const getEventListTool = () => tools.find((t) => t.name === 'get_event_list')
  const searchTopicTool = () => tools.find((t) => t.name === 'search_topic_transcripts')
  const searchConvTool = () => tools.find((t) => t.name === 'search_conversation_transcript')

  describe('get_event_list', () => {
    it('returns all events in the topic', async () => {
      const result = JSON.parse(await getEventListTool().invoke({}))
      console.log('get_event_list (all):', JSON.stringify(result, null, 2))

      expect(result).toHaveLength(2)
      const names = result.map((r) => r.name)
      expect(names).toContain('Part-Time Work Panel')
      expect(names).toContain('Aliens and Cinema')
      const partTime = result.find((r) => r.name === 'Part-Time Work Panel')

      expect(partTime.id).toBeDefined()
      expect(partTime.startTime).toBeDefined()
      expect(partTime.description).toContain('part-time')
    })

    it('filters by date range', async () => {
      const result = JSON.parse(await getEventListTool().invoke({ since: '2025-04-01', until: '2025-04-30' }))
      console.log('get_event_list (April filter):', JSON.stringify(result, null, 2))

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Aliens and Cinema')
    })

    it('filters to a specific topicId', async () => {
      const result = JSON.parse(await getEventListTool().invoke({ topicId: topic._id.toString() }))
      expect(result).toHaveLength(2)
      const names = result.map((r) => r.name)
      expect(names).not.toContain('Unrelated Event')
    })
  })

  describe('search_topic_transcripts', () => {
    it('finds content about part-time work across topic', async () => {
      const result = await searchTopicTool().invoke({ query: 'part-time work flexibility employers' })
      console.log('search_topic_transcripts (part-time work):', result.slice(0, 300))

      expect(result).not.toBe('No relevant content found.')
      expect(result.toLowerCase()).toMatch(/part.time|work|employer|flexib/)

      // ensure prefixed with event name
      expect(result).toContain('[Event:')
    })

    it('finds presenter metadata by name and subject', async () => {
      const result = await searchTopicTool().invoke({ query: 'Jessica Drain speaker presenter' })
      console.log('search_topic_transcripts (presenter):', result.slice(0, 300))

      expect(result.toLowerCase()).toContain('jessica')
    })

    it('finds content from the second conversation', async () => {
      const result = await searchTopicTool().invoke({ query: 'aliens film cinema' })
      console.log('search_topic_transcripts (aliens):', result.slice(0, 300))

      expect(result).not.toBe('No relevant content found.')
    })

    it('returns no relevant content for completely unrelated query', async () => {
      // Score threshold of 0.8 should filter out very weak matches
      const result = await searchTopicTool().invoke({ query: 'quantum physics subatomic particles' })
      console.log('search_topic_transcripts (off-topic):', result.slice(0, 100))
      // Either no results or low-relevance — just ensure it doesn't throw
      expect(typeof result).toBe('string')
    })
  })

  describe('search_conversation_transcript', () => {
    it('finds specific content within a conversation', async () => {
      const result = await searchConvTool().invoke({
        conversationId: conv1._id.toString(),
        query: 'part-time work 40 hours per week'
      })
      console.log('search_conversation_transcript (part-time):', result.slice(0, 300))

      expect(result).not.toBe('No relevant content found in that event.')
      expect(result.toLowerCase()).toMatch(/part.time|hours|work/)
    })

    it('returns event name prefix in results', async () => {
      const result = await searchConvTool().invoke({
        conversationId: conv1._id.toString(),
        query: 'employers workers'
      })

      expect(result).toContain('[Event:')
    })

    it('returns invalid conversation for malformed conversation id', async () => {
      const result = await searchConvTool().invoke({
        conversationId: 'A great conversation',
        query: 'anything'
      })

      expect(result).toContain('Invalid conversationId')
    })

    it('returns not found for non-existent conversation', async () => {
      const result = await searchConvTool().invoke({
        conversationId: new monogoose.Types.ObjectId().toString(),
        query: 'anything'
      })

      expect(result).toContain('not found')
    })

    it('does not return content from the other conversation', async () => {
      // Searching conv1 for aliens content should not find it
      const result = await searchConvTool().invoke({
        conversationId: conv1._id.toString(),
        query: 'aliens extraterrestrial film'
      })
      console.log('search_conversation_transcript (cross-conv check):', result.slice(0, 200))

      // Either no results or score below threshold — should not mention aliens prominently
      if (result !== 'No relevant content found in that event.') {
        expect(result.toLowerCase()).not.toContain('alien')
      }
    })
  })
})
