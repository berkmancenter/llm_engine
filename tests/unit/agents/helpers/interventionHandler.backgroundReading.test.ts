import { jest } from '@jest/globals'

/* runInterventionAnalysis is shared by proactiveGroupAgent and checkinHandler. The optional
   backgroundReading argument must add a "## Background Reading:" section to the USER prompt only
   when given, leaving every other caller's prompt untouched. The LLM chain is mocked, so we
   inspect the exact template and vars handed to it. */

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

const { runInterventionAnalysis, USER_TEMPLATE } = await import('../../../../src/agents/helpers/interventionHandler.js')

const PASSAGES = 'Title: Governing the Commons\nSnippet: fabricated {braces} passage'

function makeContext() {
  return {
    name: 'Agent',
    llmTemplates: { user: undefined },
    conversation: { name: 'Topic', channels: [], messages: [] },
    getLLM: async () => ({})
  }
}

const history = { start: new Date(), end: new Date(), messages: [] }
const analysis = { shouldIntervene: true, goalId: 'x', reasoning: 'r', confidenceScore: 100 }

async function run(backgroundReading?: string) {
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
    'groupChat',
    undefined,
    undefined,
    backgroundReading
  )
}

describe('runInterventionAnalysis backgroundReading', () => {
  beforeEach(() => {
    mockGetChatPromptResponse.mockReset()
    mockGetChatPromptResponse.mockResolvedValue({ ...analysis })
  })

  it('prepends a Background Reading section to the user template and passes the text as a var', async () => {
    const result = await run(PASSAGES)

    const [, systemPrompt, userTemplate, vars] = mockGetChatPromptResponse.mock.calls[0]
    expect(userTemplate).toBe(`## Background Reading:\n{backgroundReading}\n\n${USER_TEMPLATE}`)
    expect(vars.backgroundReading).toBe(PASSAGES)
    expect(systemPrompt).toBe('SYSTEM')
    expect(result?.context).toContain('## Background Reading:\nTitle: Governing the Commons')
  })

  it.each([[undefined], ['']])('leaves the prompt unchanged when backgroundReading is %p', async (bg) => {
    await run(bg)

    const [, , userTemplate, vars] = mockGetChatPromptResponse.mock.calls[0]
    expect(userTemplate).toBe(USER_TEMPLATE)
    expect(vars).not.toHaveProperty('backgroundReading')
  })
})
