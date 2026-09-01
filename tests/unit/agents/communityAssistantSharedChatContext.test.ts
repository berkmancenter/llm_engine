import { jest } from '@jest/globals'

/* respond() calls out to the real LLM via getAgentStructuredResponse for the final answer.
   Mocking it here lets us inspect the exact prompt string it was given, without a live model.
   checkBotIntent (used on the group-chat path) is bypassed by mentioning the bot by name, which
   short-circuits to a plain string match before it would otherwise call the LLM. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAgentStructuredResponse = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getAgentStructuredResponse: mockGetAgentStructuredResponse,
  getChatPromptResponse: jest.fn()
}))

const { default: communityAssistant } = await import('../../../src/agents/communityAssistant/communityAssistant.js')

const BOT_NAME = 'Berkie'

function buildContext(channels: Array<{ name: string; direct?: boolean }>, messages: unknown[] = []) {
  return {
    _id: 'agent-1',
    agentConfig: { botName: BOT_NAME, tools: [] as string[], topicIds: [] as string[] },
    conversation: { _id: 'conv-1', channels, messages, behaviorPolicy: undefined },
    getLLM: async () => ({ fakeLlm: true })
  }
}

function chatMessage(body: string, pseudonym: string) {
  return {
    channels: ['chat'],
    fromAgent: false,
    bodyType: undefined,
    body,
    pseudonym,
    createdAt: new Date(),
    updatedAt: new Date()
  }
}

describe('communityAssistant shared chat history context', () => {
  beforeEach(() => {
    mockGetAgentStructuredResponse.mockReset()
    mockGetAgentStructuredResponse.mockResolvedValue('a reply')
  })

  test('omits the Shared Chat History block for a plain group-chat message', async () => {
    const context = buildContext([{ name: 'chat' }], [chatMessage('the venue is the Cerulean Room', 'Alice')])
    const userMessage = { _id: 'm1', body: `hey ${BOT_NAME}, what is on the agenda?`, channels: ['chat'] }

    await communityAssistant.respond.call(context, { messages: [] }, userMessage)

    const [, , , userPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(userPrompt).not.toContain('## Shared Chat History')
  })

  test('injects the Shared Chat History block for a DM', async () => {
    const context = buildContext(
      [{ name: 'chat' }, { name: 'dm-user1', direct: true }],
      [chatMessage('the venue is the Cerulean Room', 'Alice')]
    )
    const userMessage = { _id: 'm2', body: 'where is our next meetup?', channels: ['dm-user1'] }

    await communityAssistant.respond.call(context, { messages: [] }, userMessage)

    const [, , , userPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(userPrompt).toContain('## Shared Chat History')
    expect(userPrompt).toContain('Cerulean Room')
  })
})
