import { jest } from '@jest/globals'

/* runInterventionAnalysis never returns null for a below-threshold or shouldIntervene: false
   decision — it returns the same analysis object with goalId/sharedChatMessage/directMessage
   normalized to 'none'/null/null, so the model's reasoning for declining survives for any caller
   that wants to show it (e.g. in a trace), while still reading as "don't intervene" to either of
   its two callers: proactiveGroupAgent (branches on goalId/sharedChatMessage) and checkinHandler,
   via detectPrivateInterventionOpportunity, which just forwards this return value (branches on
   directMessage alone). The LLM chain is mocked, so no real model call happens. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFn = () => jest.fn<(...args: any[]) => any>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse,
  getAgentStructuredResponse: mockFn()
}))

jest.unstable_mockModule('../src/agents/helpers/transcript.js', () => ({
  default: {
    getTranscript: mockFn().mockReturnValue(''),
    searchTranscript: mockFn().mockResolvedValue({ chunks: '' })
  }
}))

const { runInterventionAnalysis } = await import('../../../../src/agents/helpers/interventionHandler.js')

function makeContext() {
  return {
    name: 'Agent',
    llmTemplates: { user: undefined },
    conversation: { name: 'Topic', channels: [], messages: [] },
    getLLM: async () => ({})
  }
}

const history = { start: new Date(), end: new Date(), messages: [] }

async function run() {
  return runInterventionAnalysis.call(
    makeContext(),
    history,
    'SYSTEM',
    {} as never,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    'groupChat'
  )
}

describe('runInterventionAnalysis threshold handling', () => {
  beforeEach(() => {
    mockGetChatPromptResponse.mockReset()
  })

  it('never returns null — a below-threshold decision still comes back as an analysis object', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      shouldIntervene: true,
      goalId: 'synthesize_discussion',
      reasoning: 'A quiet moment, but not worth interrupting yet.',
      sharedChatMessage: 'Anyone want to weigh in?',
      directMessage: 'Hey, thoughts on this?',
      confidenceScore: 10 // below the default policy threshold of 60
    })

    const result = await run()

    expect(result).not.toBeNull()
    expect(result.reasoning).toBe('A quiet moment, but not worth interrupting yet.')
  })

  it('normalizes goalId/sharedChatMessage/directMessage so neither caller posts anything', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      shouldIntervene: true,
      goalId: 'synthesize_discussion',
      reasoning: 'Low confidence in this read.',
      sharedChatMessage: 'Anyone want to weigh in?',
      directMessage: 'Hey, thoughts on this?',
      confidenceScore: 10
    })

    const result = await run()

    expect(result.shouldIntervene).toBe(false)
    expect(result.goalId).toBe('none')
    expect(result.sharedChatMessage).toBeNull()
    expect(result.directMessage).toBeNull()
  })

  it('also normalizes when the model itself sets shouldIntervene: false', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      shouldIntervene: false,
      goalId: 'none',
      reasoning: 'Nothing worth surfacing right now.',
      sharedChatMessage: null,
      directMessage: null,
      confidenceScore: 95
    })

    const result = await run()

    expect(result.goalId).toBe('none')
    expect(result.reasoning).toBe('Nothing worth surfacing right now.')
  })

  it('returns the analysis unmodified when confidence clears the threshold', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      shouldIntervene: true,
      goalId: 'synthesize_discussion',
      reasoning: 'Clear opportunity to synthesize.',
      sharedChatMessage: 'Here is a summary of what I am hearing.',
      confidenceScore: 90
    })

    const result = await run()

    expect(result.goalId).toBe('synthesize_discussion')
    expect(result.sharedChatMessage).toBe('Here is a summary of what I am hearing.')
  })
})
