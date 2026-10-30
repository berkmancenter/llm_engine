import { jest } from '@jest/globals'

/* Covers the socratic_probe reading prefetch in proactiveGroupAgent.respond(): when it fires,
   what query it builds, and how the passages are threaded to runInterventionAnalysis (as the
   trailing user-prompt argument, never in the system prompt). runInterventionAnalysis and
   getBackgroundContextForQuestion are mocked, so no LLM or Chroma is involved. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRunInterventionAnalysis = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetBackgroundContext = jest.fn<(...args: any[]) => Promise<string>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFn = () => jest.fn<(...args: any[]) => any>()

jest.unstable_mockModule('../src/agents/helpers/interventionHandler.js', () => ({
  runInterventionAnalysis: mockRunInterventionAnalysis,
  detectPrivateInterventionOpportunity: mockFn(),
  buildInterventionTypeSection: mockFn(),
  interventionLlmTemplateVars: { system: [], user: [] },
  USER_TEMPLATE: ''
}))

jest.unstable_mockModule('../src/agents/tools/resourceSearch.js', () => ({
  default: () => [],
  buildResourceSearchToolsPrompt: async () => null,
  getBackgroundContextForQuestion: mockGetBackgroundContext
}))

jest.unstable_mockModule('../src/agents/helpers/transcript.js', () => ({
  default: {
    getTranscript: mockFn().mockReturnValue(''),
    searchTranscript: mockFn().mockResolvedValue({ chunks: '' }),
    loadEventMetadataIntoVectorStore: mockFn().mockResolvedValue(undefined),
    deleteTranscript: mockFn().mockResolvedValue(undefined)
  }
}))

const { default: proactiveGroupAgent } = await import('../../../../src/agents/proactiveGroupAgent/proactiveGroupAgent.js')

const AGENT_NAME = 'Proactive Group Agent'
const PASSAGES = 'Source ID: 0\nTitle: Governing the Commons\nSnippet: fabricated passage text'

function chatMessage(body: string, offsetMs = 0, overrides: Record<string, unknown> = {}) {
  const createdAt = new Date(Date.now() - offsetMs)
  return {
    fromAgent: false,
    visible: true,
    pseudonym: 'Some User',
    channels: ['chat'],
    body,
    createdAt,
    updatedAt: createdAt,
    ...overrides
  }
}

function makeAgent(
  overrides: {
    goals?: string[]
    resources?: unknown[]
    messages?: ReturnType<typeof chatMessage>[]
    initiativeLevel?: string
    startTime?: Date
  } = {}
) {
  return {
    name: AGENT_NAME,
    instanceName: AGENT_NAME,
    agentType: 'proactiveGroupAgent',
    _id: 'test-agent-id',
    agentConfig: { personality: null } as Record<string, unknown>,
    getLLM: mockFn().mockResolvedValue({}),
    conversation: {
      _id: 'conv-1',
      name: 'Test Conversation',
      startTime: overrides.startTime ?? new Date(Date.now() - 20 * 60 * 1000),
      goals: overrides.goals ?? ['socratic_probe'],
      resources: 'resources' in overrides ? overrides.resources : [{ fileName: 'reading.pdf' }],
      behaviorPolicy: {
        globalPolicy: { tone: 'warmSupportive', verbosity: 'brief', formality: 'semiFormal' },
        channels: {
          groupChat: {
            proactivePolicy: {
              initiativeLevel: overrides.initiativeLevel ?? 'moderatelyProactive',
              minContributionMinutes: 3
            }
          }
        }
      },
      channels: [{ name: 'chat', direct: false }],
      messages: overrides.messages ?? [chatMessage('I think trust is just about transparency')],
      conversationContext: undefined
    }
  }
}

function history(end = new Date()) {
  return { start: new Date(end.getTime() - 600_000), end, messages: [] }
}

const goalIdsArg = () => (mockRunInterventionAnalysis.mock.calls[0][6] as { id: string }[]).map((g) => g.id)
const readingArg = () => mockRunInterventionAnalysis.mock.calls[0][11] as string | undefined

describe('proactiveGroupAgent socratic_probe reading prefetch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRunInterventionAnalysis.mockResolvedValue(null)
    mockGetBackgroundContext.mockResolvedValue(PASSAGES)
  })

  it('prefetches when socratic_probe is active and resources have a fileName, passing passages as the user-prompt arg', async () => {
    const agent = makeAgent()

    await proactiveGroupAgent.respond.call(agent, history())

    expect(mockGetBackgroundContext).toHaveBeenCalledTimes(1)
    expect(mockGetBackgroundContext).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('trust is just about transparency')
    )
    expect(readingArg()).toBe(PASSAGES)
  })

  it('keeps passages out of the system prompt but tells the model the goal needs the section', async () => {
    await proactiveGroupAgent.respond.call(makeAgent(), history())

    const systemPrompt = mockRunInterventionAnalysis.mock.calls[0][1] as string
    expect(systemPrompt).not.toContain('fabricated passage text')
    expect(systemPrompt).toContain('## Background Reading:')
    expect(systemPrompt).toContain('If that section is absent, do not use "socratic_probe"')
  })

  it('does not add the reading rule to the system prompt when socratic_probe is inactive', async () => {
    await proactiveGroupAgent.respond.call(makeAgent({ goals: ['synthesize_discussion'] }), history())

    expect(mockRunInterventionAnalysis.mock.calls[0][1]).not.toContain('Background Reading')
  })

  it('does not prefetch when socratic_probe is not active', async () => {
    await proactiveGroupAgent.respond.call(makeAgent({ goals: ['synthesize_discussion'] }), history())

    expect(mockGetBackgroundContext).not.toHaveBeenCalled()
    expect(mockRunInterventionAnalysis).toHaveBeenCalled()
    expect(readingArg()).toBeUndefined()
  })

  it.each([
    ['resources is undefined', undefined],
    ['resources is empty', []],
    ['no resource has a fileName', [{ title: 'Link only' }]]
  ])('does not prefetch and skips the LLM call when %s and socratic_probe is the only goal', async (_label, resources) => {
    const responses = await proactiveGroupAgent.respond.call(makeAgent({ resources }), history())

    expect(responses).toEqual([])
    expect(mockGetBackgroundContext).not.toHaveBeenCalled()
    expect(mockRunInterventionAnalysis).not.toHaveBeenCalled()
  })

  it('removes socratic_probe from the goals, schema and system prompt when there are no resources, keeping other goals', async () => {
    await proactiveGroupAgent.respond.call(
      makeAgent({ resources: [], goals: ['socratic_probe', 'synthesize_discussion'] }),
      history()
    )

    expect(mockGetBackgroundContext).not.toHaveBeenCalled()
    expect(goalIdsArg()).toEqual(['synthesize_discussion'])
    const systemPrompt = mockRunInterventionAnalysis.mock.calls[0][1] as string
    expect(systemPrompt).not.toContain('socratic_probe')
    expect(systemPrompt).not.toContain('Background Reading')
    expect(readingArg()).toBeUndefined()
  })

  it('keeps socratic_probe alongside other goals when passages are retrieved', async () => {
    await proactiveGroupAgent.respond.call(makeAgent({ goals: ['socratic_probe', 'synthesize_discussion'] }), history())

    expect(goalIdsArg().sort()).toEqual(['socratic_probe', 'synthesize_discussion'])
    expect(readingArg()).toBe(PASSAGES)
  })

  it('does not prefetch when initiative is passive', async () => {
    const responses = await proactiveGroupAgent.respond.call(makeAgent({ initiativeLevel: 'passive' }), history())

    expect(responses).toEqual([])
    expect(mockGetBackgroundContext).not.toHaveBeenCalled()
    expect(mockRunInterventionAnalysis).not.toHaveBeenCalled()
  })

  it('does not prefetch when rate limited', async () => {
    const agent = makeAgent({ startTime: new Date(Date.now() - 60 * 1000) })

    const responses = await proactiveGroupAgent.respond.call(agent, history())

    expect(responses).toEqual([])
    expect(mockGetBackgroundContext).not.toHaveBeenCalled()
  })

  it('does not prefetch when no group chat goals are active', async () => {
    const responses = await proactiveGroupAgent.respond.call(makeAgent({ goals: [] }), history())

    expect(responses).toEqual([])
    expect(mockGetBackgroundContext).not.toHaveBeenCalled()
    expect(mockRunInterventionAnalysis).not.toHaveBeenCalled()
  })

  it('treats an empty prefetch result as no passages: sole goal skips the LLM call', async () => {
    mockGetBackgroundContext.mockResolvedValue('')

    const responses = await proactiveGroupAgent.respond.call(makeAgent(), history())

    expect(mockGetBackgroundContext).toHaveBeenCalled()
    expect(responses).toEqual([])
    expect(mockRunInterventionAnalysis).not.toHaveBeenCalled()
  })

  it('drops socratic_probe but keeps other goals when the prefetch returns an empty string', async () => {
    mockGetBackgroundContext.mockResolvedValue('')

    await proactiveGroupAgent.respond.call(makeAgent({ goals: ['socratic_probe', 'synthesize_discussion'] }), history())

    expect(goalIdsArg()).toEqual(['synthesize_discussion'])
    expect(readingArg()).toBeUndefined()
  })

  it('on a prefetch error with socratic_probe as the only goal, skips the LLM call', async () => {
    mockGetBackgroundContext.mockRejectedValue(new Error('chroma down'))

    const responses = await proactiveGroupAgent.respond.call(makeAgent(), history())

    expect(responses).toEqual([])
    expect(mockRunInterventionAnalysis).not.toHaveBeenCalled()
  })

  it('swallows a prefetch error, drops socratic_probe, and still returns another goal intervention', async () => {
    mockGetBackgroundContext.mockRejectedValue(new Error('chroma down'))
    mockRunInterventionAnalysis.mockResolvedValue({
      shouldIntervene: true,
      goalId: 'synthesize_discussion',
      reasoning: 'r',
      sharedChatMessage: 'A question?',
      confidenceScore: 90
    })

    const responses = await proactiveGroupAgent.respond.call(
      makeAgent({ goals: ['socratic_probe', 'synthesize_discussion'] }),
      history()
    )

    expect(readingArg()).toBeUndefined()
    expect(goalIdsArg()).toEqual(['synthesize_discussion'])
    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBe('A question?')
  })

  it('discards a socratic_probe result when no passages were retrieved (defensive)', async () => {
    mockGetBackgroundContext.mockResolvedValue('')
    mockRunInterventionAnalysis.mockResolvedValue({
      shouldIntervene: true,
      goalId: 'socratic_probe',
      reasoning: 'r',
      sharedChatMessage: 'What does Ostrom say about trust?',
      confidenceScore: 95
    })

    const responses = await proactiveGroupAgent.respond.call(
      makeAgent({ goals: ['socratic_probe', 'synthesize_discussion'] }),
      history()
    )

    expect(mockRunInterventionAnalysis).toHaveBeenCalled()
    expect(responses).toEqual([])
  })

  it('returns a socratic_probe intervention when passages were retrieved', async () => {
    mockRunInterventionAnalysis.mockResolvedValue({
      shouldIntervene: true,
      goalId: 'socratic_probe',
      reasoning: 'r',
      sharedChatMessage: 'In Ostrom, what role does monitoring play?',
      confidenceScore: 95
    })

    const responses = await proactiveGroupAgent.respond.call(makeAgent(), history())

    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBe('In Ostrom, what role does monitoring play?')
  })

  it('builds the query from the last few non-agent chat messages, each clipped and the total bounded', async () => {
    const messages = [
      chatMessage('oldest message that should be dropped', 9000),
      ...Array.from({ length: 5 }, (_, i) => chatMessage(`recent-${i} ${'x'.repeat(2000)}`, 5000 - i * 100)),
      chatMessage('agent post should be ignored', 10, { fromAgent: true, pseudonym: 'Other Agent' })
    ]

    await proactiveGroupAgent.respond.call(makeAgent({ messages }), history())

    const query = mockGetBackgroundContext.mock.calls[0][1] as string
    expect(query).not.toContain('oldest message')
    expect(query).not.toContain('agent post')
    expect(query).toContain('recent-4')
    expect(query.length).toBeLessThanOrEqual(1000)
  })

  it('skips the prefetch when the shared chat has no text to query with, dropping socratic_probe', async () => {
    const responses = await proactiveGroupAgent.respond.call(makeAgent({ messages: [] }), history())

    expect(mockGetBackgroundContext).not.toHaveBeenCalled()
    expect(responses).toEqual([])
    expect(mockRunInterventionAnalysis).not.toHaveBeenCalled()
  })
})
