import { jest } from '@jest/globals'

/* runInterventionAnalysis resolves ConversationGoal.tools generically via the shared tool
   registry (src/agents/tools/registry.ts) instead of each tool-needing goal special-casing its
   own retrieval in the calling agent. A tick where no active goal declares tools must stay on
   the plain, non-tool-calling path, byte-identical to before this mechanism existed. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAgentStructuredResponse = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetTools = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockBuildToolsGuidance = jest.fn<(...args: any[]) => Promise<string>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFn = () => jest.fn<(...args: any[]) => any>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse,
  getAgentStructuredResponse: mockGetAgentStructuredResponse
}))

jest.unstable_mockModule('../src/agents/tools/registry.js', () => ({
  getTools: mockGetTools,
  buildToolsGuidance: mockBuildToolsGuidance
}))

jest.unstable_mockModule('../src/agents/helpers/transcript.js', () => ({
  default: {
    getTranscript: mockFn().mockReturnValue(''),
    searchTranscript: mockFn().mockResolvedValue({ chunks: '' })
  }
}))

const { runInterventionAnalysis } = await import('../../../../src/agents/helpers/interventionHandler.js')

function makeContext(overrides: { agentConfig?: Record<string, unknown>; conversationId?: string } = {}) {
  return {
    name: 'Agent',
    llmTemplates: { user: undefined },
    agentConfig: overrides.agentConfig,
    conversation: { name: 'Topic', channels: [], messages: [], _id: overrides.conversationId },
    getLLM: async () => ({})
  }
}

function makeGoal(id: string, tools?: string[]) {
  return {
    id,
    label: id,
    description: id,
    channel: 'groupChat' as const,
    triggers: { conditions: [], minConfidence: 50 },
    guardrails: [],
    outputContract: { format: 'text' as const },
    examples: ['example'],
    ...(tools ? { tools } : {})
  }
}

const history = { start: new Date(), end: new Date(), messages: [] }
const DECISION = { shouldIntervene: true, goalId: 'x', reasoning: 'r', confidenceScore: 100 }

async function run(activeGoals: ReturnType<typeof makeGoal>[], context: ReturnType<typeof makeContext> = makeContext()) {
  return runInterventionAnalysis.call(
    context,
    history,
    'SYSTEM',
    {} as never,
    null,
    undefined,
    undefined,
    activeGoals,
    undefined,
    'groupChat'
  )
}

describe('runInterventionAnalysis tool resolution', () => {
  beforeEach(() => {
    mockGetChatPromptResponse.mockReset()
    mockGetAgentStructuredResponse.mockReset()
    mockGetTools.mockReset()
    mockBuildToolsGuidance.mockReset()
    mockGetChatPromptResponse.mockResolvedValue({ ...DECISION })
    mockGetAgentStructuredResponse.mockResolvedValue({ ...DECISION, toolTrace: { invoked: true, calls: [] } })
    mockBuildToolsGuidance.mockResolvedValue('')
  })

  it('stays on the plain call and never touches the tool registry when no active goal declares tools', async () => {
    await run([makeGoal('synthesize_discussion')])

    expect(mockGetTools).not.toHaveBeenCalled()
    expect(mockGetAgentStructuredResponse).not.toHaveBeenCalled()
    expect(mockGetChatPromptResponse).toHaveBeenCalled()
  })

  it('resolves the declared tools and switches to the tool-enabled call when a goal needs them', async () => {
    mockGetTools.mockResolvedValue({ tools: [{ name: 'list_open_threads' }], resolvedNames: ['open_threads'] })
    const context = makeContext({ agentConfig: { topicIds: ['t1'] }, conversationId: 'conv-1' })

    await run([makeGoal('resurface_past_discussion', ['event_history', 'open_threads'])], context)

    expect(mockGetTools).toHaveBeenCalledWith(
      expect.arrayContaining(['event_history', 'open_threads']),
      expect.objectContaining({ topicIds: ['t1'], activeConversationId: 'conv-1' })
    )
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    expect(mockGetAgentStructuredResponse).toHaveBeenCalledWith(
      expect.anything(),
      [{ name: 'list_open_threads' }],
      expect.any(String),
      expect.any(String),
      expect.anything(),
      undefined,
      20,
      { returnToolTrace: true }
    )
  })

  it('dedupes tool names declared by more than one active goal', async () => {
    mockGetTools.mockResolvedValue({ tools: [{ name: 'event_history' }], resolvedNames: ['event_history'] })

    await run([makeGoal('a', ['event_history']), makeGoal('b', ['event_history', 'resource_search'])])

    const [names] = mockGetTools.mock.calls[0]
    expect(names.sort()).toEqual(['event_history', 'resource_search'])
  })

  it('appends tool guidance to the system prompt when tools resolve to something', async () => {
    mockGetTools.mockResolvedValue({ tools: [{ name: 'event_history' }], resolvedNames: ['event_history'] })
    mockBuildToolsGuidance.mockResolvedValue('Guidance about event_history.')

    await run([makeGoal('resurface_past_discussion', ['event_history'])])

    const [, , systemPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(systemPrompt).toBe('SYSTEM\n\nGuidance about event_history.')
  })

  it('builds guidance only from names that actually resolved, not every name requested', async () => {
    mockGetTools.mockResolvedValue({ tools: [{ name: 'event_history' }], resolvedNames: ['event_history'] })

    await run([makeGoal('goal_a', ['event_history']), makeGoal('goal_b', ['resource_search'])])

    expect(mockBuildToolsGuidance).toHaveBeenCalledWith(['event_history'], expect.anything())
  })

  it('leaves the system prompt unchanged when a declared tool resolves to nothing (e.g. no topicIds)', async () => {
    mockGetTools.mockResolvedValue({ tools: [], resolvedNames: [] })

    await run([makeGoal('resurface_past_discussion', ['event_history'])])

    expect(mockGetAgentStructuredResponse).not.toHaveBeenCalled()
    const [, systemPrompt] = mockGetChatPromptResponse.mock.calls[0]
    expect(systemPrompt).toBe('SYSTEM')
  })

  it('passes through a tool-dependent goal chosen with an actual tool call', async () => {
    mockGetTools.mockResolvedValue({ tools: [{ name: 'event_history' }], resolvedNames: ['event_history'] })
    mockGetAgentStructuredResponse.mockResolvedValue({
      ...DECISION,
      goalId: 'resurface_past_discussion',
      toolTrace: { invoked: true, calls: [{ name: 'event_history', args: {} }] }
    })

    const result = await run([makeGoal('resurface_past_discussion', ['event_history'])])

    expect(result.goalId).toBe('resurface_past_discussion')
    expect(result.declineReason).toBeUndefined()
  })

  it('discards a tool-dependent goal chosen without any tool actually being invoked', async () => {
    mockGetTools.mockResolvedValue({ tools: [{ name: 'event_history' }], resolvedNames: ['event_history'] })
    mockGetAgentStructuredResponse.mockResolvedValue({
      ...DECISION,
      goalId: 'resurface_past_discussion',
      sharedChatMessage: 'Should never be sent.',
      toolTrace: { invoked: false, calls: [] }
    })

    const result = await run([makeGoal('resurface_past_discussion', ['event_history'])])

    expect(result.shouldIntervene).toBe(false)
    expect(result.goalId).toBe('none')
    expect(result.sharedChatMessage).toBeNull()
    expect(result.declineReason).toBe('tool_goal_ungrounded')
  })

  it("discards goal A when only goal B's declared tool was actually invoked this tick", async () => {
    mockGetTools.mockResolvedValue({
      tools: [{ name: 'event_history' }, { name: 'resource_search' }],
      resolvedNames: ['event_history', 'resource_search']
    })
    mockGetAgentStructuredResponse.mockResolvedValue({
      ...DECISION,
      goalId: 'goal_a',
      sharedChatMessage: 'Should never be sent.',
      toolTrace: { invoked: true, calls: [{ name: 'resource_search', args: {} }] }
    })

    const result = await run([makeGoal('goal_a', ['event_history']), makeGoal('goal_b', ['resource_search'])])

    expect(result.shouldIntervene).toBe(false)
    expect(result.goalId).toBe('none')
    expect(result.sharedChatMessage).toBeNull()
    expect(result.declineReason).toBe('tool_goal_ungrounded')
  })

  it("passes through goal A when its own declared tool was invoked, even with goal B's tool also resolved", async () => {
    mockGetTools.mockResolvedValue({
      tools: [{ name: 'event_history' }, { name: 'resource_search' }],
      resolvedNames: ['event_history', 'resource_search']
    })
    mockGetAgentStructuredResponse.mockResolvedValue({
      ...DECISION,
      goalId: 'goal_a',
      toolTrace: { invoked: true, calls: [{ name: 'event_history', args: {} }] }
    })

    const result = await run([makeGoal('goal_a', ['event_history']), makeGoal('goal_b', ['resource_search'])])

    expect(result.goalId).toBe('goal_a')
    expect(result.declineReason).toBeUndefined()
  })

  it('discards a tool-dependent goal chosen when no tools resolved at all (falls back to the plain call)', async () => {
    mockGetTools.mockResolvedValue({ tools: [], resolvedNames: [] })
    mockGetChatPromptResponse.mockResolvedValue({
      ...DECISION,
      goalId: 'resurface_past_discussion',
      sharedChatMessage: 'Should never be sent.'
    })

    const result = await run([makeGoal('resurface_past_discussion', ['event_history'])])

    expect(result.goalId).toBe('none')
    expect(result.declineReason).toBe('tool_goal_ungrounded')
  })

  it('does not discard a goal with no declared tools even without a tool call', async () => {
    const result = await run([makeGoal('x')])

    expect(result.goalId).toBe('x')
    expect(result.declineReason).toBeUndefined()
  })
})
