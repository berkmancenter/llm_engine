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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRunSocraticStage = jest.fn<(...args: any[]) => Promise<any>>()

// runInterventionAnalysis never resolves to null (see interventionHandler.ts) — a below-threshold
// or shouldIntervene: false decision still comes back as a real analysis object, just with
// goalId/sharedChatMessage normalized to 'none'/null, so its reasoning survives into the trace.
const NO_INTERVENTION = {
  shouldIntervene: false,
  goalId: 'none',
  reasoning: 'nothing notable',
  confidenceScore: 0,
  sharedChatMessage: null
}

jest.unstable_mockModule('../src/agents/helpers/socraticPipeline.js', () => ({
  default: mockRunSocraticStage
}))

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
      resources:
        'resources' in overrides
          ? overrides.resources
          : [{ fileName: 'reading.pdf', title: 'Governing the Commons', authors: ['Elinor Ostrom'] }],
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
    mockRunInterventionAnalysis.mockResolvedValue(NO_INTERVENTION)
    mockGetBackgroundContext.mockResolvedValue(PASSAGES)
    mockRunSocraticStage.mockResolvedValue({ message: 'A pipeline question?', source: 'writer' })
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
    expect((responses[0].message as { text: string }).text).toBe('A question?')
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
    expect(responses).toHaveLength(1)
    expect(responses[0].traceOnly).toBe(true)
  })

  it('returns a socratic_probe intervention when passages were retrieved', async () => {
    mockRunInterventionAnalysis.mockResolvedValue({
      shouldIntervene: true,
      goalId: 'socratic_probe',
      reasoning: 'r',
      sharedChatMessage: 'question',
      sourceLabel: 'Governing the Commons',
      concept: 'fabricated passage',
      loadedWord: null,
      confidenceScore: 95
    })

    const responses = await proactiveGroupAgent.respond.call(makeAgent(), history())

    expect(responses).toHaveLength(1)
    expect((responses[0].message as { text: string }).text).toBe('A pipeline question?')
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

  it('skips the prefetch when neither chat nor transcript has text to query with, dropping socratic_probe', async () => {
    const responses = await proactiveGroupAgent.respond.call(makeAgent({ messages: [] }), history())

    expect(mockGetBackgroundContext).not.toHaveBeenCalled()
    expect(responses).toEqual([])
    expect(mockRunInterventionAnalysis).not.toHaveBeenCalled()
  })

  it('builds the query from the transcript when chat is quiet, so a silent chat does not starve the prefetch', async () => {
    const messages = [
      chatMessage('Ostrom argues trust emerges from repeated interaction', 5000, { channels: ['transcript'] })
    ]

    await proactiveGroupAgent.respond.call(makeAgent({ messages }), history())

    expect(mockGetBackgroundContext).toHaveBeenCalledWith('conv-1', expect.stringContaining('Ostrom argues trust emerges'))
  })

  it('combines chat and transcript text, most recent last, when both have content', async () => {
    const messages = [
      chatMessage('older transcript line', 9000, { channels: ['transcript'] }),
      chatMessage('newer chat line', 1000, { channels: ['chat'] })
    ]

    await proactiveGroupAgent.respond.call(makeAgent({ messages }), history())

    const query = mockGetBackgroundContext.mock.calls[0][1] as string
    expect(query).toBe('older transcript line\nnewer chat line')
  })
})

describe('proactiveGroupAgent socratic_probe question pipeline', () => {
  const decision = (slots: Record<string, unknown> = {}) => ({
    shouldIntervene: true,
    goalId: 'socratic_probe',
    reasoning: 'r',
    sharedChatMessage: 'question',
    sourceLabel: 'Governing the Commons',
    concept: 'fabricated passage',
    loadedWord: null,
    confidenceScore: 90,
    ...slots
  })
  const stageInput = () => mockRunSocraticStage.mock.calls[0][0]
  const chat = (...bodies: string[]) =>
    bodies.map((b, i) => chatMessage(b, 1000 * (bodies.length - i), { pseudonym: 'Curious Badger' }))

  beforeEach(() => {
    jest.clearAllMocks()
    mockRunInterventionAnalysis.mockReset()
    mockRunSocraticStage.mockReset()
    mockRunSocraticStage.mockResolvedValue({ message: 'A pipeline question?', source: 'writer' })
    mockGetBackgroundContext.mockResolvedValue(PASSAGES)
  })

  it('posts the pipeline message instead of the decision call message, passing slots and passage', async () => {
    mockRunInterventionAnalysis.mockResolvedValue(decision())

    const responses = await proactiveGroupAgent.respond.call(makeAgent({ messages: chat('I like quotas') }), history())

    expect(responses).toHaveLength(1)
    expect((responses[0].message as { text: string }).text).toBe('A pipeline question?')
    expect(stageInput()).toEqual(
      expect.objectContaining({
        slots: { sourceLabel: 'Governing the Commons', concept: 'fabricated passage', loadedWord: null },
        passage: PASSAGES,
        participantNames: expect.arrayContaining(['Curious Badger', 'Badger'])
      })
    )
  })

  it('never posts a decision with goal none, even with shouldIntervene and a message', async () => {
    mockRunInterventionAnalysis.mockResolvedValue(
      decision({ goalId: 'none', sharedChatMessage: 'A message the model wrote itself' })
    )

    const responses = await proactiveGroupAgent.respond.call(
      makeAgent({ goals: ['socratic_probe', 'synthesize_discussion'] }),
      history()
    )

    expect(responses).toHaveLength(1)
    expect(responses[0].traceOnly).toBe(true)
    expect(responses[0].visible).toBe(false)
    expect(mockRunSocraticStage).not.toHaveBeenCalled()
  })

  it('still posts a non-none goal message', async () => {
    mockRunInterventionAnalysis.mockResolvedValue(
      decision({ goalId: 'synthesize_discussion', sharedChatMessage: 'A summary question?' })
    )

    const responses = await proactiveGroupAgent.respond.call(
      makeAgent({ goals: ['socratic_probe', 'synthesize_discussion'] }),
      history()
    )

    expect(responses).toHaveLength(1)
    expect((responses[0].message as { text: string }).text).toBe('A summary question?')
    expect(mockRunSocraticStage).not.toHaveBeenCalled()
  })

  it('asks the decision call for slots only when socratic_probe is eligible', async () => {
    mockRunInterventionAnalysis.mockResolvedValue(NO_INTERVENTION)
    await proactiveGroupAgent.respond.call(makeAgent({ goals: ['socratic_probe', 'synthesize_discussion'] }), history())
    const withSocratic = mockRunInterventionAnalysis.mock.calls[0][2]
    expect(Object.keys(withSocratic.shape)).toEqual(expect.arrayContaining(['sourceLabel', 'concept', 'loadedWord']))
    expect(mockRunInterventionAnalysis.mock.calls[0][1]).toContain('"concept"')

    mockRunInterventionAnalysis.mockClear()
    await proactiveGroupAgent.respond.call(makeAgent({ goals: ['synthesize_discussion'] }), history())
    expect(Object.keys(mockRunInterventionAnalysis.mock.calls[0][2].shape)).not.toContain('concept')
  })

  it.each([
    ['a concept not in the passage', { concept: 'moderator burnout' }],
    ['a concept with a finding verb', { concept: 'trust fell' }],
    ['a source that matches no reading', { sourceLabel: 'Somebody Else' }],
    ['a missing concept', { concept: null }]
  ])('stays silent, without running the stage, on %s', async (_label, slots) => {
    mockRunInterventionAnalysis.mockResolvedValue(decision(slots))

    const responses = await proactiveGroupAgent.respond.call(makeAgent(), history())

    expect(responses).toHaveLength(1)
    expect(responses[0].traceOnly).toBe(true)
    expect(mockRunSocraticStage).not.toHaveBeenCalled()
  })

  it('drops a loaded word the group has not repeated, keeps one it has', async () => {
    mockRunInterventionAnalysis.mockResolvedValue(decision({ loadedWord: 'healthy' }))
    await proactiveGroupAgent.respond.call(makeAgent({ messages: chat('a healthy forum') }), history())
    expect(stageInput().slots.loadedWord).toBeNull()

    mockRunSocraticStage.mockClear()
    await proactiveGroupAgent.respond.call(makeAgent({ messages: chat('a healthy forum', 'healthy means busy') }), history())
    expect(stageInput().slots.loadedWord).toBe('healthy')
  })

  it('passes human chat and the agents own recent posts separately', async () => {
    mockRunInterventionAnalysis.mockResolvedValue(decision())
    const messages = [
      ...chat('I like quotas'),
      chatMessage('Earlier agent question?', 10 * 60 * 1000, { fromAgent: true, pseudonym: AGENT_NAME })
    ]
    await proactiveGroupAgent.respond.call(makeAgent({ messages }), history())

    expect(stageInput().humanChatLines).toEqual(['I like quotas'])
    expect(stageInput().recentPosts).toEqual(['Earlier agent question?'])
  })

  it('stays silent when the stage returns nothing', async () => {
    mockRunInterventionAnalysis.mockResolvedValue(decision())
    mockRunSocraticStage.mockResolvedValue(null)

    const responses = await proactiveGroupAgent.respond.call(makeAgent(), history())
    expect(responses).toHaveLength(1)
    expect(responses[0].traceOnly).toBe(true)
  })

  it('does not run the stage for other goals', async () => {
    mockRunInterventionAnalysis.mockResolvedValue({
      ...decision(),
      goalId: 'synthesize_discussion',
      sharedChatMessage: 'hello'
    })

    const responses = await proactiveGroupAgent.respond.call(
      makeAgent({ goals: ['synthesize_discussion', 'socratic_probe'] }),
      history()
    )

    expect((responses[0].message as { text: string }).text).toBe('hello')
    expect(mockRunSocraticStage).not.toHaveBeenCalled()
  })
})
