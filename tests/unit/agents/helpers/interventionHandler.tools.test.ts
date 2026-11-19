import { jest } from '@jest/globals'

/* runInterventionAnalysis resolves ConversationGoal.tools generically via the shared tool
   registry (src/agents/tools/registry.ts) instead of each tool-needing goal special-casing its
   own retrieval in the calling agent. A tick where no active goal declares tools must stay on
   the plain, non-tool-calling path, byte-identical to before this mechanism existed.

   Tools are resolved per goal (one registry key at a time, cached), not as one batched union
   call — so each resolved tool's real LangChain name can be attributed back to the goal whose
   own registry key produced it. That's what lets the generic "was this goal's own retrieval
   actually grounded" check tell apart "goal A's own tool ran" from "some other eligible goal's
   tool happened to run instead". Mocks below are keyed by the single registry name each
   resolveKey() call passes, to actually exercise that per-key resolution. */

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

type FakeResolved = { tools: Array<{ name: string }>; resolvedNames: string[] }

// The real registry names used by resurface_past_discussion, mapped to the real LangChain tool
// name(s) each one resolves to — a different namespace, which is the whole point being tested.
const FAKE_REGISTRY: Record<string, FakeResolved> = {
  event_history: { tools: [{ name: 'search_topic_transcripts' }], resolvedNames: ['event_history'] },
  open_threads: { tools: [{ name: 'list_open_threads' }], resolvedNames: ['open_threads'] },
  resource_search: { tools: [{ name: 'search_resources' }], resolvedNames: ['resource_search'] }
}
const EMPTY_RESOLVED: FakeResolved = { tools: [], resolvedNames: [] }

// getTools is now called once per registry key (see resolveKey in interventionHandler.ts), so
// the mock must branch on which single key it was asked for, not return one blanket value.
function useFakeRegistry(overrides: Record<string, FakeResolved> = {}) {
  const registry = { ...FAKE_REGISTRY, ...overrides }
  mockGetTools.mockImplementation(async (names: string[]) => registry[names[0]] ?? EMPTY_RESOLVED)
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

  it('resolves each declared registry key individually and switches to the tool-enabled call', async () => {
    useFakeRegistry()
    const context = makeContext({ agentConfig: { topicIds: ['t1'] }, conversationId: 'conv-1' })

    await run([makeGoal('resurface_past_discussion', ['event_history', 'open_threads'])], context)

    expect(mockGetTools).toHaveBeenCalledWith(['event_history'], expect.objectContaining({ topicIds: ['t1'] }))
    expect(mockGetTools).toHaveBeenCalledWith(['open_threads'], expect.objectContaining({ topicIds: ['t1'] }))
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    const [, boundTools] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(boundTools.map((t) => t.name).sort()).toEqual(['list_open_threads', 'search_topic_transcripts'])
  })

  it("caches a registry key shared by two goals instead of re-resolving it for the second goal's own request", async () => {
    useFakeRegistry()

    await run([makeGoal('a', ['event_history']), makeGoal('b', ['event_history', 'resource_search'])])

    expect(mockGetTools).toHaveBeenCalledTimes(2)
    expect(mockGetTools).toHaveBeenCalledWith(['event_history'], expect.anything())
    expect(mockGetTools).toHaveBeenCalledWith(['resource_search'], expect.anything())
  })

  it('binds the deduped union of every resolved tool, even when two goals share one', async () => {
    useFakeRegistry()

    await run([makeGoal('a', ['event_history']), makeGoal('b', ['event_history', 'resource_search'])])

    const [, boundTools] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(boundTools.map((t) => t.name).sort()).toEqual(['search_resources', 'search_topic_transcripts'])
  })

  it('appends tool guidance to the system prompt when tools resolve to something', async () => {
    useFakeRegistry()
    mockBuildToolsGuidance.mockResolvedValue('Guidance about event_history.')

    await run([makeGoal('resurface_past_discussion', ['event_history'])])

    const [, , systemPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(systemPrompt).toBe('SYSTEM\n\nGuidance about event_history.')
  })

  it('builds guidance only from names that actually resolved, not every name requested', async () => {
    useFakeRegistry({ resource_search: EMPTY_RESOLVED })

    await run([makeGoal('goal_a', ['event_history']), makeGoal('goal_b', ['resource_search'])])

    expect(mockBuildToolsGuidance).toHaveBeenCalledWith(['event_history'], expect.anything())
  })

  it('leaves the system prompt unchanged when a declared tool resolves to nothing (e.g. no topicIds)', async () => {
    useFakeRegistry({ event_history: EMPTY_RESOLVED })

    await run([makeGoal('resurface_past_discussion', ['event_history'])])

    expect(mockGetAgentStructuredResponse).not.toHaveBeenCalled()
    const [, systemPrompt] = mockGetChatPromptResponse.mock.calls[0]
    expect(systemPrompt).toBe('SYSTEM')
  })

  it('passes through a tool-dependent goal chosen with its own declared tool actually invoked', async () => {
    useFakeRegistry()
    mockGetAgentStructuredResponse.mockResolvedValue({
      ...DECISION,
      goalId: 'resurface_past_discussion',
      toolTrace: { invoked: true, calls: [{ name: 'search_topic_transcripts', args: {} }] }
    })

    const result = await run([makeGoal('resurface_past_discussion', ['event_history'])])

    expect(result.goalId).toBe('resurface_past_discussion')
    expect(result.declineReason).toBeUndefined()
  })

  it('discards a tool-dependent goal chosen without any tool actually being invoked', async () => {
    useFakeRegistry()
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

  // The precise case this mechanism exists for: two eligible goals each declare a DIFFERENT
  // tool. The model calls goal B's tool but ends up choosing goal A — goal A's own retrieval
  // never actually happened, so it must be discarded even though *a* tool call occurred this
  // tick. Checking "was any tool invoked" (rather than "was THIS goal's own tool invoked") would
  // wrongly let this through.
  it("discards goal A when only goal B's declared tool was actually invoked this tick", async () => {
    useFakeRegistry()
    mockGetAgentStructuredResponse.mockResolvedValue({
      ...DECISION,
      goalId: 'goal_a',
      sharedChatMessage: 'Should never be sent.',
      toolTrace: { invoked: true, calls: [{ name: 'search_resources', args: {} }] }
    })

    const result = await run([makeGoal('goal_a', ['event_history']), makeGoal('goal_b', ['resource_search'])])

    expect(result.shouldIntervene).toBe(false)
    expect(result.goalId).toBe('none')
    expect(result.sharedChatMessage).toBeNull()
    expect(result.declineReason).toBe('tool_goal_ungrounded')
  })

  it("passes through goal A when its own declared tool was invoked, even with goal B's tool also bound", async () => {
    useFakeRegistry()
    mockGetAgentStructuredResponse.mockResolvedValue({
      ...DECISION,
      goalId: 'goal_a',
      toolTrace: { invoked: true, calls: [{ name: 'search_topic_transcripts', args: {} }] }
    })

    const result = await run([makeGoal('goal_a', ['event_history']), makeGoal('goal_b', ['resource_search'])])

    expect(result.goalId).toBe('goal_a')
    expect(result.declineReason).toBeUndefined()
  })

  it('discards a tool-dependent goal chosen when no tools resolved at all (falls back to the plain call)', async () => {
    useFakeRegistry({ event_history: EMPTY_RESOLVED })
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
