import { jest } from '@jest/globals'

/* runInterventionAnalysis is shared by proactiveGroupAgent and checkinHandler. Both the
   backgroundReading argument and extraTemplateVars.additionalContext add their own section to the
   USER prompt only when given, leaving every other caller's prompt (and every caller that
   supplies neither) untouched. The LLM chain is mocked, so we inspect the exact template and vars
   handed to it. */

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

// None of these tests use a goal that declares tools, so this is never actually called —
// mocked only so importing interventionHandler.js doesn't pull in the real registry.
jest.unstable_mockModule('../src/agents/tools/registry.js', () => ({
  getTools: mockFn().mockResolvedValue([]),
  buildToolsGuidance: mockFn().mockResolvedValue('')
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

async function run(backgroundReading?: string, extraTemplateVars?: Record<string, string>) {
  return runInterventionAnalysis.call(
    makeContext(),
    history,
    'SYSTEM',
    {} as never,
    null,
    undefined,
    extraTemplateVars,
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

  it('leaves the prompt unchanged when no extraTemplateVars is supplied', async () => {
    await run()

    const [, , userTemplate, vars] = mockGetChatPromptResponse.mock.calls[0]
    expect(userTemplate).toBe(USER_TEMPLATE)
    expect(vars).not.toHaveProperty('additionalContext')
  })

  it('prepends an Additional Context section when extraTemplateVars.additionalContext is supplied', async () => {
    await run(undefined, { additionalContext: 'What is our budget ceiling?' })

    const [, , userTemplate, vars] = mockGetChatPromptResponse.mock.calls[0]
    expect(userTemplate).toBe(`## Additional Context:\n{additionalContext}\n\n${USER_TEMPLATE}`)
    expect(vars.additionalContext).toBe('What is our budget ceiling?')
  })

  it('prepends both sections, background reading first, when both are supplied', async () => {
    await run(PASSAGES, { additionalContext: 'What is our budget ceiling?' })

    const [, , userTemplate] = mockGetChatPromptResponse.mock.calls[0]
    expect(userTemplate).toBe(
      `## Background Reading:\n{backgroundReading}\n\n## Additional Context:\n{additionalContext}\n\n${USER_TEMPLATE}`
    )
  })
})
