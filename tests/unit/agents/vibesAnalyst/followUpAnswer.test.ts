import { jest } from '@jest/globals'

/* answerFollowUp's only dependency is the LLM call; mocked here so the schema-parsing wiring
   can be checked deterministically, the same way curateCard.test.ts mocks it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse
}))

const { answerFollowUp } = await import('../../../../src/agents/vibesAnalyst/followUp.js')

describe('answerFollowUp', () => {
  beforeEach(() => {
    mockGetChatPromptResponse.mockReset()
  })

  it('passes the question and the metrics rows as JSON to the follow-up prompt', async () => {
    mockGetChatPromptResponse.mockResolvedValue({ answerable: true, text: '68 people lurked.' })
    const metricsContext = [{ posterCount: 12, lurkerCount: 68 }]

    const result = await answerFollowUp('how many lurked?', metricsContext, { fakeLlm: true })

    expect(result).toEqual({ answerable: true, text: '68 people lurked.' })
    const [llm, , , templateVars] = mockGetChatPromptResponse.mock.calls[0]
    expect(llm).toEqual({ fakeLlm: true })
    expect(templateVars).toEqual({ question: 'how many lurked?', metricsJson: JSON.stringify(metricsContext) })
  })
})
