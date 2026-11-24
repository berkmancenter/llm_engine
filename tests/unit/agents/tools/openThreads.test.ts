import { jest } from '@jest/globals'

/* The live group-chat fallback (below) needs getChatPromptResponse mocked, which under ESM must
   be registered before any import of the module graph — so every import here is dynamic, even
   for the tier-1 tests above it that don't touch the mock. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getSinglePromptResponse: jest.fn(),
  getRAGAugmentedResponse: jest.fn(),
  getChatPromptResponse: mockGetChatPromptResponse,
  shouldUseStructuredOutput: jest.fn(),
  pingLLM: jest.fn(),
  getStructuredResponseChain: jest.fn(),
  getAgentStructuredResponse: jest.fn(),
  extractToolCallTraceFromAgentResult: jest.fn(),
  extractCompleteSentences: jest.fn(),
  streamAgentAndReportChunks: jest.fn()
}))

const { default: createOpenThreadsTools } = await import('../../../../src/agents/tools/openThreads.js')
const { default: setupIntTest } = await import('../../../utils/setupIntTest.js')
const { createUser, createPublicTopic, createConversation } = await import('../../../utils/agentTestHelpers.js')
const { newPublicTopic, insertTopics } = await import('../../../fixtures/topic.fixture.js')
const { Message, Conversation } = await import('../../../../src/models/index.js')

setupIntTest()

// Defaults well past the tool's own recency cutoff, so a bare call reads as genuinely dormant
// chat history rather than something still in view — pass an explicit baseDate to test the
// cutoff itself.
const seedChatMessages = async (
  conversationId: unknown,
  bodies: string[],
  baseDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
) => {
  const msgs = await Message.insertMany(
    bodies.map((body, i) => ({
      conversation: conversationId,
      channels: ['chat'],
      body,
      pseudonym: 'Member',
      pseudonymId: conversationId,
      createdAt: new Date(baseDate.getTime() + i * 1000)
    }))
  )
  await Conversation.findByIdAndUpdate(conversationId, { $push: { messages: { $each: msgs.map((m) => m._id) } } })
}

describe('openThreads tools', () => {
  const listTool = (topicIds: string[], activeConversationId?: string) =>
    createOpenThreadsTools({ topicIds, activeConversationId })[0]

  it('reports no open threads when no past conversation has any', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    await createConversation({ name: 'Kickoff Session' }, user, topic, new Date('2025-03-01T18:00:00Z'))

    const result = await listTool([topic._id.toString()]).invoke({})
    expect(result).toBe('No open threads are available yet.')
  })

  it('excludes a past conversation whose openThreads array is empty', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    await createConversation(
      { name: 'Kickoff Session', postEventAnalysis: { openThreads: [] } },
      user,
      topic,
      new Date('2025-03-01T18:00:00Z')
    )

    const result = await listTool([topic._id.toString()]).invoke({})
    expect(result).toBe('No open threads are available yet.')
  })

  it('lists each open thread with its conversation name, date, and id', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    const pastConversation = await createConversation(
      {
        name: 'Budget Review',
        endTime: new Date('2025-03-01T19:00:00Z'),
        postEventAnalysis: { openThreads: ['What is our ceiling for the Hendricks grant?'] }
      },
      user,
      topic,
      new Date('2025-03-01T18:00:00Z')
    )

    const result = await listTool([topic._id.toString()]).invoke({})
    expect(result).toBe(
      `[Budget Review — 2025-03-01 — id: ${pastConversation._id.toString()}] What is our ceiling for the Hendricks grant?`
    )
  })

  it('includes every open thread from a conversation with more than one', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    await createConversation(
      {
        name: 'Budget Review',
        endTime: new Date('2025-03-01T19:00:00Z'),
        postEventAnalysis: { openThreads: ['First open question', 'Second open question'] }
      },
      user,
      topic,
      new Date('2025-03-01T18:00:00Z')
    )

    const result = await listTool([topic._id.toString()]).invoke({})
    const lines = result.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('First open question')
    expect(lines[1]).toContain('Second open question')
  })

  it('orders past conversations most-recent-first', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    await createConversation(
      {
        name: 'Older Session',
        endTime: new Date('2025-01-01T19:00:00Z'),
        postEventAnalysis: { openThreads: ['Older question'] }
      },
      user,
      topic,
      new Date('2025-01-01T18:00:00Z')
    )
    await createConversation(
      {
        name: 'Newer Session',
        endTime: new Date('2025-04-01T19:00:00Z'),
        postEventAnalysis: { openThreads: ['Newer question'] }
      },
      user,
      topic,
      new Date('2025-04-01T18:00:00Z')
    )

    const result = await listTool([topic._id.toString()]).invoke({})
    const lines = result.split('\n')
    expect(lines[0]).toContain('Newer Session')
    expect(lines[0]).toContain('Newer question')
    expect(lines[1]).toContain('Older Session')
    expect(lines[1]).toContain('Older question')
  })

  it('only includes conversations from the requested topics', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    const otherTopic = newPublicTopic()
    await insertTopics([otherTopic])

    await createConversation(
      {
        name: 'In Series',
        endTime: new Date('2025-03-01T19:00:00Z'),
        postEventAnalysis: { openThreads: ['In-series question'] }
      },
      user,
      topic,
      new Date('2025-03-01T18:00:00Z')
    )
    await createConversation(
      {
        name: 'Different Series',
        endTime: new Date('2025-03-15T19:00:00Z'),
        postEventAnalysis: { openThreads: ['Unrelated question'] }
      },
      user,
      otherTopic,
      new Date('2025-03-15T18:00:00Z')
    )

    const result = await listTool([topic._id.toString()]).invoke({})
    expect(result).toContain('In-series question')
    expect(result).not.toContain('Unrelated question')
  })

  it('excludes a past conversation that concluded too recently', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    await createConversation(
      {
        name: 'Just Wrapped Up',
        endTime: new Date(Date.now() - 60 * 60 * 1000), // ended an hour ago
        postEventAnalysis: { openThreads: ['Still too fresh to resurface'] }
      },
      user,
      topic
    )

    const result = await listTool([topic._id.toString()]).invoke({})
    expect(result).toBe('No open threads are available yet.')
  })

  it('caps results at the safety limit, dropping the oldest past conversations first', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    const totalConversations = 21 // one more than the tool's own cap (OPEN_THREADS_LIMIT = 20)
    await Promise.all(
      Array.from({ length: totalConversations }, (_, i) => {
        // i=0 is the oldest (200 days ago), i=20 the most recent (180 days ago) — all well past
        // the recency floor either way.
        const startTime = new Date(Date.now() - (200 - i) * 24 * 60 * 60 * 1000)
        return createConversation(
          {
            name: `Session ${i}`,
            endTime: new Date(startTime.getTime() + 60 * 60 * 1000),
            postEventAnalysis: { openThreads: [`Question ${i}`] }
          },
          user,
          topic,
          startTime
        )
      })
    )

    const result = await listTool([topic._id.toString()]).invoke({})
    const lines = result.split('\n')
    expect(lines).toHaveLength(20)
    expect(result).not.toContain('Question 0')
    expect(result).toContain('Question 20')
  })
})

describe('list_open_threads live group-chat fallback', () => {
  beforeEach(() => {
    mockGetChatPromptResponse.mockReset()
  })

  it('falls back to a live extraction over this conversation’s own chat history when no past conversation has any', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    const conversation = await createConversation({ name: 'Ongoing Chat' }, user, topic)
    const messageDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
    await seedChatMessages(conversation._id, ['Does anyone know our actual budget ceiling for this?'], messageDate)
    mockGetChatPromptResponse.mockResolvedValue({ openThreads: ['What is our actual budget ceiling?'] })

    const [tool] = createOpenThreadsTools({
      topicIds: [topic._id.toString()],
      activeConversationId: conversation._id.toString()
    })
    const result = await tool.invoke({})

    expect(result).toBe(
      `[Earlier in this chat — ${messageDate
        .toISOString()
        .slice(0, 10)} — id: ${conversation._id.toString()}] What is our actual budget ceiling?`
    )
    const [, , , inputParams] = mockGetChatPromptResponse.mock.calls[0]
    expect((inputParams as { sharedChat: string }).sharedChat).toContain(
      'Does anyone know our actual budget ceiling for this?'
    )
  })

  it('reports no open threads when the live fallback also finds nothing', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    const conversation = await createConversation({ name: 'Ongoing Chat' }, user, topic)
    await seedChatMessages(conversation._id, ['Just saying hi!'])
    mockGetChatPromptResponse.mockResolvedValue({ openThreads: [] })

    const [tool] = createOpenThreadsTools({
      topicIds: [topic._id.toString()],
      activeConversationId: conversation._id.toString()
    })
    const result = await tool.invoke({})

    expect(result).toBe('No open threads are available yet.')
  })

  it('excludes chat messages newer than the minimum thread age from the live fallback', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    const conversation = await createConversation({ name: 'Ongoing Chat' }, user, topic)
    await seedChatMessages(conversation._id, ['Does anyone know our actual budget ceiling for this?'])
    await seedChatMessages(conversation._id, ['Did anyone catch the game last night?'], new Date())
    mockGetChatPromptResponse.mockResolvedValue({ openThreads: [] })

    const [tool] = createOpenThreadsTools({
      topicIds: [topic._id.toString()],
      activeConversationId: conversation._id.toString()
    })
    await tool.invoke({})

    const [, , , inputParams] = mockGetChatPromptResponse.mock.calls[0]
    const { sharedChat } = inputParams as { sharedChat: string }
    expect(sharedChat).toContain('Does anyone know our actual budget ceiling for this?')
    expect(sharedChat).not.toContain('Did anyone catch the game last night?')
  })

  it('excludes chat messages older than the maximum thread age from the live fallback', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    const conversation = await createConversation({ name: 'Ongoing Chat' }, user, topic)
    await seedChatMessages(
      conversation._id,
      ['Does anyone remember what we decided about the venue deposit?'],
      new Date(Date.now() - 75 * 24 * 60 * 60 * 1000) // well past the 60-day cap
    )
    await seedChatMessages(conversation._id, ['Does anyone know our actual budget ceiling for this?'])
    mockGetChatPromptResponse.mockResolvedValue({ openThreads: [] })

    const [tool] = createOpenThreadsTools({
      topicIds: [topic._id.toString()],
      activeConversationId: conversation._id.toString()
    })
    await tool.invoke({})

    const [, , , inputParams] = mockGetChatPromptResponse.mock.calls[0]
    const { sharedChat } = inputParams as { sharedChat: string }
    expect(sharedChat).toContain('Does anyone know our actual budget ceiling for this?')
    expect(sharedChat).not.toContain('Does anyone remember what we decided about the venue deposit?')
  })

  it('prioritizes a past conversation’s own open threads over the live chat fallback', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    const pastConversation = await createConversation(
      {
        name: 'Prior Session',
        endTime: new Date('2025-03-01T19:00:00Z'),
        postEventAnalysis: { openThreads: ['What is our actual budget ceiling?'] }
      },
      user,
      topic,
      new Date('2025-03-01T18:00:00Z')
    )
    const conversation = await createConversation({ name: 'Ongoing Chat' }, user, topic)
    await seedChatMessages(conversation._id, ['Totally different topic that should never be used.'])

    const [tool] = createOpenThreadsTools({
      topicIds: [topic._id.toString()],
      activeConversationId: conversation._id.toString()
    })
    const result = await tool.invoke({})

    expect(result).toBe(
      `[Prior Session — 2025-03-01 — id: ${pastConversation._id.toString()}] What is our actual budget ceiling?`
    )
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  it('reuses a recent live extraction instead of calling the model again on the next tick', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    const conversation = await createConversation({ name: 'Ongoing Chat' }, user, topic)
    await seedChatMessages(conversation._id, ['Does anyone know our actual budget ceiling for this?'])
    mockGetChatPromptResponse.mockResolvedValue({ openThreads: ['What is our actual budget ceiling?'] })
    const [tool] = createOpenThreadsTools({
      topicIds: [topic._id.toString()],
      activeConversationId: conversation._id.toString()
    })

    const first = await tool.invoke({})
    const second = await tool.invoke({})

    expect(second).toBe(first)
    expect(mockGetChatPromptResponse).toHaveBeenCalledTimes(1)
  })

  it('sends only the most recent 200 chat messages in the window to the live extraction', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    const conversation = await createConversation({ name: 'Ongoing Chat' }, user, topic)
    const bodies = Array.from({ length: 201 }, (_, i) => `Message number ${i}.`)
    await seedChatMessages(conversation._id, bodies)
    mockGetChatPromptResponse.mockResolvedValue({ openThreads: [] })
    const [tool] = createOpenThreadsTools({
      topicIds: [topic._id.toString()],
      activeConversationId: conversation._id.toString()
    })

    await tool.invoke({})

    const [, , , inputParams] = mockGetChatPromptResponse.mock.calls[0]
    const { sharedChat } = inputParams as { sharedChat: string }
    expect(sharedChat).not.toContain('Message number 0.')
    expect(sharedChat).toContain('Message number 1.')
    expect(sharedChat).toContain('Message number 200.')
  })
})

describe('list_open_threads grounding artifact', () => {
  const listToolFor = (topicIds: string[], activeConversationId?: string) =>
    createOpenThreadsTools({ topicIds, activeConversationId })[0]

  const invokeAsToolCall = async (tool: Awaited<ReturnType<typeof createOpenThreadsTools>>[number]) =>
    (await tool.invoke({ id: 'call-1', name: tool.name, args: {}, type: 'tool_call' })) as {
      content: string
      artifact?: { grounding?: boolean }
    }

  beforeEach(() => {
    mockGetChatPromptResponse.mockReset()
  })

  it('marks a past-conversation listing as not grounding on its own, since it still needs a transcript excerpt', async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    await createConversation(
      {
        name: 'Budget Review',
        endTime: new Date('2025-03-01T19:00:00Z'),
        postEventAnalysis: { openThreads: ['What is our ceiling for the Hendricks grant?'] }
      },
      user,
      topic,
      new Date('2025-03-01T18:00:00Z')
    )

    const message = await invokeAsToolCall(listToolFor([topic._id.toString()]))

    expect(message.content).toContain('What is our ceiling for the Hendricks grant?')
    expect(message.artifact).toEqual({ grounding: false })
  })

  it('marks an empty listing as not grounding', async () => {
    const topic = await createPublicTopic()

    const message = await invokeAsToolCall(listToolFor([topic._id.toString()]))

    expect(message.content).toBe('No open threads are available yet.')
    expect(message.artifact).toEqual({ grounding: false })
  })

  it("marks a live chat candidate as grounding, since it was drawn from this chat's real messages", async () => {
    const user = await createUser('Test User')
    const topic = await createPublicTopic()
    const conversation = await createConversation({ name: 'Ongoing Chat' }, user, topic)
    await seedChatMessages(conversation._id, ['Does anyone know our actual budget ceiling for this?'])
    mockGetChatPromptResponse.mockResolvedValue({ openThreads: ['What is our actual budget ceiling?'] })

    const message = await invokeAsToolCall(listToolFor([topic._id.toString()], conversation._id.toString()))

    expect(message.content).toContain('[Earlier in this chat')
    expect(message.artifact).toEqual({ grounding: true })
  })
})
