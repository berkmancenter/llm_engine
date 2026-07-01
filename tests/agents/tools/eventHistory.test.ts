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
import { getTools } from '../../../src/agents/tools/registry.js'
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

    it('returns a string for completely unrelated queries (no threshold — always returns top-k)', async () => {
      const result = await searchTopicTool().invoke({ query: 'quantum physics subatomic particles' })
      console.log('search_topic_transcripts (off-topic):', result.slice(0, 100))
      // No score threshold — tool always returns best matches, so result is always a string
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

  describe('activeConversationId (series history for eventAssistant)', () => {
    let scopedTools
    const scopedGetEventList = () => scopedTools.find((t) => t.name === 'get_event_list')
    const scopedSearchTopic = () => scopedTools.find((t) => t.name === 'search_topic_transcripts')
    const scopedSearchConv = () => scopedTools.find((t) => t.name === 'search_conversation_transcript')

    beforeEach(() => {
      // Tools scoped to the series, excluding conv2 (the "current" event)
      const topicRefs: TopicRef[] = [{ id: topic._id.toString(), name: topic.name }]
      scopedTools = createEventHistoryTools(topicRefs, { activeConversationId: conv2._id.toString() })
    })

    it('get_event_list omits the excluded (current) event', async () => {
      const result = JSON.parse(await scopedGetEventList().invoke({}))
      const names = result.map((r) => r.name)
      expect(names).toContain('Part-Time Work Panel')
      expect(names).not.toContain('Aliens and Cinema')
    })

    it('search_topic_transcripts excludes chunks from the current event', async () => {
      // conv2 (aliens) is excluded, so an aliens query should not surface conv2 content
      const result = await scopedSearchTopic().invoke({ query: 'aliens film cinema extraterrestrial' })
      console.log('search_topic_transcripts (excluded current):', result.slice(0, 200))
      if (result !== 'No relevant content found.') {
        expect(result).not.toContain('Aliens and Cinema')
      }
    })

    it('search_topic_transcripts still finds content from other past events', async () => {
      const result = await scopedSearchTopic().invoke({ query: 'part-time work flexibility employers' })
      expect(result).not.toBe('No relevant content found.')
      expect(result.toLowerCase()).toMatch(/part.time|work|employer|flexib/)
    })

    it('search_conversation_transcript refuses the excluded (current) event', async () => {
      const result = await scopedSearchConv().invoke({
        conversationId: conv2._id.toString(),
        query: 'anything'
      })
      expect(result).toMatch(/current event/i)
    })

    it('honors activeConversationId end-to-end when built through the tool registry', async () => {
      // Verifies the registry forwards activeConversationId into createEventHistoryTools, not just
      // that the factory returns tools — exercises the same path the eventAssistant uses at runtime.
      const registryTools = getTools(['event_history'], {
        topics: [{ id: topic._id.toString(), name: topic.name }],
        activeConversationId: conv2._id.toString()
      })
      const getEventList = registryTools.find((t) => t.name === 'get_event_list')
      const result = JSON.parse(await getEventList!.invoke({}))
      const names = result.map((r) => r.name)
      expect(names).toContain('Part-Time Work Panel')
      expect(names).not.toContain('Aliens and Cinema')
    })
  })

  describe('chunk prefix — [Event:] without activeConversationId, [Past Event:] with it', () => {
    it('search_topic_transcripts uses [Event:] prefix when no activeConversationId set', async () => {
      const result = await searchTopicTool().invoke({ query: 'aliens film cinema' })
      expect(result).not.toBe('No relevant content found.')
      expect(result).toContain('[Event:')
      expect(result).not.toContain('[Past Event:')
    })

    it('search_conversation_transcript uses [Event:] prefix when no activeConversationId set', async () => {
      const result = await searchConvTool().invoke({
        conversationId: conv1._id.toString(),
        query: 'part-time work employers'
      })
      expect(result).not.toBe('No relevant content found in that event.')
      expect(result).toContain('[Event:')
      expect(result).not.toContain('[Past Event:')
    })
  })

  describe('search_topic_transcripts – no score threshold', () => {
    it('returns content for a broad discovery query that would have failed the old 0.8 threshold', async () => {
      // Prior to the fix this tool applied a 0.8 cosine-distance threshold and returned nothing
      // for broad/meta queries. With the threshold removed, the top-k results are always returned.
      const result = await searchTopicTool().invoke({ query: 'what happened at this event' })
      console.log('search_topic_transcripts (broad query):', result.slice(0, 200))
      expect(result).not.toBe('No relevant content found.')
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Additional describes with their own setup — test specific bug-fix behaviors
// ---------------------------------------------------------------------------

describe('get_event_list – Chroma-indexed conversation filtering', () => {
  let topic; let user

  beforeEach(async () => {
    user = await createUser('Chroma Filter Test User')
    topic = await createPublicTopic()
  })

  it('excludes conversations that have no indexed transcript data in Chroma', async () => {
    const conv1 = await createConversation(
      { name: 'Indexed Part-Time Work' },
      user,
      topic,
      new Date('2025-01-01T18:00:00Z')
    )
    const conv2 = await createConversation(
      { name: 'Indexed Aliens' },
      user,
      topic,
      new Date('2025-02-01T18:00:00Z')
    )
    await createConversation({ name: 'Not Indexed Event' }, user, topic, new Date('2025-03-01T18:00:00Z'))

    await loadPartTimeWorkTranscript(conv1, true)
    await loadAliensTranscript(conv2, true)
    // third conversation intentionally NOT indexed

    const topicRefs: TopicRef[] = [{ id: topic._id.toString(), name: topic.name }]
    const tools = createEventHistoryTools(topicRefs)
    const result = JSON.parse(await tools.find((t) => t.name === 'get_event_list')!.invoke({}))

    const names = result.map((r) => r.name)
    expect(names).toContain('Indexed Part-Time Work')
    expect(names).toContain('Indexed Aliens')
    expect(names).not.toContain('Not Indexed Event')
    expect(result).toHaveLength(2)
  })

  it('falls back to returning all conversations when no Chroma data exists for the topic', async () => {
    // Neither conversation is indexed — the topic collection won't exist in Chroma.
    // In this state getIndexedConversationIds returns an empty Set and the tool falls back
    // to all conversations (same behavior as before the Chroma-filtering feature was added).
    await createConversation({ name: 'Event A' }, user, topic, new Date('2025-01-01T18:00:00Z'))
    await createConversation({ name: 'Event B' }, user, topic, new Date('2025-02-01T18:00:00Z'))

    const topicRefs: TopicRef[] = [{ id: topic._id.toString(), name: topic.name }]
    const tools = createEventHistoryTools(topicRefs)
    const result = JSON.parse(await tools.find((t) => t.name === 'get_event_list')!.invoke({}))

    expect(result).toHaveLength(2)
  })
})

describe('get_event_list – ordinal session ordering (most-recent-first)', () => {
  let topic; let user; let convOlder; let convNewer; let currentConv

  beforeEach(async () => {
    user = await createUser('Ordinal Test User')
    topic = await createPublicTopic()

    const now = new Date()
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

    // The "2 sessions ago" event
    convOlder = await createConversation({ name: 'Aliens Session' }, user, topic, fourteenDaysAgo)
    await loadAliensTranscript(convOlder, true)

    // The "1 session ago" event
    convNewer = await createConversation({ name: 'Part-Time Work Session' }, user, topic, sevenDaysAgo)
    await loadPartTimeWorkTranscript(convNewer, true)

    // The "current" event — not indexed; excluded via activeConversationId
    currentConv = await createConversation({ name: 'Current Session' }, user, topic, now)
  })

  it('returns past events sorted most-recent-first, excluding the current event', async () => {
    const topicRefs: TopicRef[] = [{ id: topic._id.toString(), name: topic.name }]
    const tools = createEventHistoryTools(topicRefs, {
      activeConversationId: currentConv._id.toString()
    })
    const result = JSON.parse(await tools.find((t) => t.name === 'get_event_list')!.invoke({}))

    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Part-Time Work Session') // 1 session ago (more recent)
    expect(result[1].name).toBe('Aliens Session') // 2 sessions ago (older)
    expect(result.map((r) => r.name)).not.toContain('Current Session')
  })

  it('index [0] is 1 session ago and index [1] is 2 sessions ago', async () => {
    const topicRefs: TopicRef[] = [{ id: topic._id.toString(), name: topic.name }]
    const tools = createEventHistoryTools(topicRefs, {
      activeConversationId: currentConv._id.toString()
    })
    const result = JSON.parse(await tools.find((t) => t.name === 'get_event_list')!.invoke({}))

    expect(result[0].id).toBe(convNewer._id.toString())
    expect(result[1].id).toBe(convOlder._id.toString())
  })

  it('the event at index [1] (2 sessions ago) has searchable transcript content', async () => {
    const topicRefs: TopicRef[] = [{ id: topic._id.toString(), name: topic.name }]
    const tools = createEventHistoryTools(topicRefs, {
      activeConversationId: currentConv._id.toString()
    })
    const eventList = JSON.parse(await tools.find((t) => t.name === 'get_event_list')!.invoke({}))
    const twoSessionsAgoId = eventList[1].id

    const result = await tools.find((t) => t.name === 'search_conversation_transcript')!.invoke({
      conversationId: twoSessionsAgoId,
      query: 'aliens film cinema'
    })
    console.log('ordinal 2-sessions-ago transcript:', result.slice(0, 200))

    expect(result).not.toBe('No relevant content found in that event.')
    expect(result.toLowerCase()).toMatch(/alien|film|cinema/)
  })
})

describe('get_event_list – calendar date filtering', () => {
  let topic; let user; let convRecent; let convMidMonth; let convOld

  beforeEach(async () => {
    user = await createUser('Calendar Test User')
    topic = await createPublicTopic()

    const now = new Date()
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000)
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000)

    convRecent = await createConversation({ name: 'Recent Event' }, user, topic, oneDayAgo)
    convMidMonth = await createConversation({ name: 'Mid-Month Event' }, user, topic, eightDaysAgo)
    convOld = await createConversation({ name: 'Older Event' }, user, topic, fifteenDaysAgo)

    await loadAliensTranscript(convRecent, true)
    await loadPartTimeWorkTranscript(convMidMonth, true)
    await loadAliensTranscript(convOld, true)
  })

  it('returns only events on or after a since date', async () => {
    const now = new Date()
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)

    const topicRefs: TopicRef[] = [{ id: topic._id.toString(), name: topic.name }]
    const tools = createEventHistoryTools(topicRefs)
    const result = JSON.parse(
      await tools.find((t) => t.name === 'get_event_list')!.invoke({
        since: threeDaysAgo.toISOString().slice(0, 10)
      })
    )

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Recent Event')
  })

  it('returns only events within a since/until window, mimicking a "last week" lookup', async () => {
    const now = new Date()
    // Window: 4–12 days ago, which contains only the 8-day-ago event
    const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000)
    const twelveDaysAgo = new Date(now.getTime() - 12 * 24 * 60 * 60 * 1000)

    const topicRefs: TopicRef[] = [{ id: topic._id.toString(), name: topic.name }]
    const tools = createEventHistoryTools(topicRefs)
    const result = JSON.parse(
      await tools.find((t) => t.name === 'get_event_list')!.invoke({
        since: twelveDaysAgo.toISOString().slice(0, 10),
        until: fourDaysAgo.toISOString().slice(0, 10)
      })
    )

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Mid-Month Event')
    expect(result[0].id).toBe(convMidMonth._id.toString())
  })
})
