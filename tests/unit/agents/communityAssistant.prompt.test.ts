import { jest } from '@jest/globals'
import setupIntTest from '../../utils/setupIntTest.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAgentStructuredResponse = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getAgentStructuredResponse: mockGetAgentStructuredResponse,
  getChatPromptResponse: jest.fn()
}))

const { default: communityAssistant } = await import('../../../src/agents/communityAssistant/communityAssistant.js')

setupIntTest()

const BOT_NAME = 'Berkie'

function buildContext(notifications: string[], periodicMemberIntros: boolean) {
  return {
    _id: 'agent-1',
    agentConfig: { botName: BOT_NAME, tools: [], topicIds: [] as string[], notifications, periodicMemberIntros },
    conversation: { _id: 'conv-1', channels: [{ name: 'chat' }], messages: [], behaviorPolicy: undefined },
    getLLM: async () => ({ fakeLlm: true })
  }
}

async function getSystemPrompt(context) {
  mockGetAgentStructuredResponse.mockReset()
  mockGetAgentStructuredResponse.mockResolvedValue('a reply')
  const userMessage = { _id: 'm-p', body: `${BOT_NAME}, how do you work?`, channels: ['chat'] }
  await communityAssistant.respond.call(context, { messages: [] }, userMessage)
  const [, , systemPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
  return systemPrompt as string
}

describe('communityAssistant participation note in system prompt', () => {
  test('includes both proactive behaviors when both are configured', async () => {
    const systemPrompt = await getSystemPrompt(buildContext(['event_ended'], true))
    expect(systemPrompt).toMatch(/post a summary when a community event wraps up/)
    expect(systemPrompt).toMatch(/periodically introduce members/)
  })

  test('includes only event summary when periodicMemberIntros is off', async () => {
    const systemPrompt = await getSystemPrompt(buildContext(['event_ended'], false))
    expect(systemPrompt).toMatch(/post a summary when a community event wraps up/)
    expect(systemPrompt).not.toMatch(/periodically introduce members/)
  })

  test('includes only member intros when event_ended notification is off', async () => {
    const systemPrompt = await getSystemPrompt(buildContext([], true))
    expect(systemPrompt).not.toMatch(/post a summary when a community event wraps up/)
    expect(systemPrompt).toMatch(/periodically introduce members/)
  })

  test('omits the proactive behavior clause entirely when both are disabled', async () => {
    const systemPrompt = await getSystemPrompt(buildContext([], false))
    expect(systemPrompt).not.toMatch(/You also/)
  })
})
