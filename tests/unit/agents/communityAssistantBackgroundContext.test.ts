import { jest } from '@jest/globals'

/* respond() calls out to the real LLM via getAgentStructuredResponse for the final answer, and to
   getBackgroundContextForQuestion (the up-front, threshold-gated RAG hybrid) to decide whether to
   splice a Background Reading section into the user prompt. Mocking both lets us inspect the exact
   gating/injection behavior deterministically, without a live model or live Chroma collection.
   createResourceSearchTools/buildResourceSearchToolsPrompt are stubbed too since they share the
   mocked module — registry.ts's resource_search factory/prompt builder consume them as well. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAgentStructuredResponse = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetBackgroundContextForQuestion = jest.fn<(...args: any[]) => Promise<string>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getAgentStructuredResponse: mockGetAgentStructuredResponse,
  getChatPromptResponse: jest.fn()
}))

jest.unstable_mockModule('../src/agents/tools/resourceSearch.js', () => ({
  default: () => [],
  buildResourceSearchToolsPrompt: async () => null,
  getBackgroundContextForQuestion: mockGetBackgroundContextForQuestion
}))

const { default: communityAssistant } = await import('../../../src/agents/communityAssistant/communityAssistant.js')

const BOT_NAME = 'Berkie'

function buildContext(tools: string[], resources: unknown[] = [{ fileName: 'reading.pdf' }]) {
  return {
    _id: 'agent-1',
    agentConfig: { botName: BOT_NAME, tools, topicIds: [] as string[] },
    conversation: { _id: 'conv-1', channels: [{ name: 'chat' }], messages: [], behaviorPolicy: undefined, resources },
    getLLM: async () => ({ fakeLlm: true })
  }
}

describe('communityAssistant background-reading hybrid (up-front RAG gate)', () => {
  beforeEach(() => {
    mockGetAgentStructuredResponse.mockReset()
    mockGetAgentStructuredResponse.mockResolvedValue('a reply')
    mockGetBackgroundContextForQuestion.mockReset()
  })

  test('injects a Background Reading section when resource_search is enabled and content clears the bar', async () => {
    mockGetBackgroundContextForQuestion.mockResolvedValue('Source ID: 0\nTitle: Fake Paper\nSnippet: fabricated content')
    const context = buildContext(['resource_search'])
    const userMessage = { _id: 'm1', body: `${BOT_NAME}, what does the reading say?`, channels: ['chat'] }

    await communityAssistant.respond.call(context, { messages: [] }, userMessage)

    expect(mockGetBackgroundContextForQuestion).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('what does the reading say?')
    )
    const [, , , userPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(userPrompt).toContain('## Background Reading:')
    expect(userPrompt).toContain('fabricated content')
  })

  test('omits the Background Reading section when nothing clears the relevance bar', async () => {
    mockGetBackgroundContextForQuestion.mockResolvedValue('')
    const context = buildContext(['resource_search'])
    const userMessage = { _id: 'm2', body: `${BOT_NAME}, what's a good pasta recipe?`, channels: ['chat'] }

    await communityAssistant.respond.call(context, { messages: [] }, userMessage)

    const [, , , userPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(userPrompt).not.toContain('## Background Reading:')
  })

  test('never calls getBackgroundContextForQuestion when resource_search is not in the tools list', async () => {
    const context = buildContext(['web_search'])
    const userMessage = { _id: 'm3', body: `${BOT_NAME}, what does the reading say?`, channels: ['chat'] }

    await communityAssistant.respond.call(context, { messages: [] }, userMessage)

    expect(mockGetBackgroundContextForQuestion).not.toHaveBeenCalled()
    const [, , , userPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(userPrompt).not.toContain('## Background Reading:')
  })

  test('never calls getBackgroundContextForQuestion when no resource has an uploaded PDF', async () => {
    const context = buildContext(['resource_search'], [{ title: 'Stub resource, no PDF uploaded yet' }])
    const userMessage = { _id: 'm4', body: `${BOT_NAME}, what does the reading say?`, channels: ['chat'] }

    await communityAssistant.respond.call(context, { messages: [] }, userMessage)

    expect(mockGetBackgroundContextForQuestion).not.toHaveBeenCalled()
    const [, , , userPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(userPrompt).not.toContain('## Background Reading:')
  })
})
