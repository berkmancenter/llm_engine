import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import { buildEventHistoryToolsPrompt } from '../../../src/agents/tools/eventHistory.js'
import setupIntTest from '../../utils/setupIntTest.js'

/* respond() calls out to the real LLM via getAgentStructuredResponse for the final answer.
   Mocking it here lets us inspect the exact system prompt string it was given, without a live model. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAgentStructuredResponse = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getAgentStructuredResponse: mockGetAgentStructuredResponse,
  getChatPromptResponse: jest.fn()
}))

const { default: communityAssistant } = await import('../../../src/agents/communityAssistant/communityAssistant.js')

// The event_history tool factory/prompt-builder load topics from Mongo even with an empty
// topicIds filter (falls back to "all public topics"), so the enabled-tools test below needs a
// real connection.
setupIntTest()

const BOT_NAME = 'Berkie'

function buildContext(
  tools: string[] = [],
  agentConfigOverrides: Record<string, unknown> = {},
  conversationId = 'conv-1',
  useRealNames = false
) {
  return {
    _id: 'agent-1',
    agentConfig: { botName: BOT_NAME, tools, topicIds: [] as string[], ...agentConfigOverrides },
    conversation: {
      _id: conversationId,
      channels: [{ name: 'chat' }],
      messages: [],
      behaviorPolicy: undefined,
      useRealNames
    },
    getLLM: async () => ({ fakeLlm: true })
  }
}

describe('communityAssistant tool-selection guidance (issue #622)', () => {
  beforeEach(() => {
    mockGetAgentStructuredResponse.mockReset()
    mockGetAgentStructuredResponse.mockResolvedValue('a reply')
  })

  test('tightens the "answer from history alone" escape hatch so it requires a complete answer', async () => {
    const context = buildContext([])
    const userMessage = { _id: 'm1', body: `${BOT_NAME}, who should be our next speaker?`, channels: ['chat'] }

    await communityAssistant.respond.call(context, { messages: [] }, userMessage)

    const [, , systemPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(systemPrompt).toMatch(/complete, direct.*answer/i)
    expect(systemPrompt).toMatch(/who should be our next speaker/i)
    expect(systemPrompt).toMatch(/from our recent conversation/i)
  })

  test('surfaces event_history guidance, including the event-summary follow-up routing rule, when enabled', async () => {
    const context = buildContext(['event_history'])
    const userMessage = { _id: 'm2', body: `${BOT_NAME}, tell me more about the portion by Alan Raul`, channels: ['chat'] }

    await communityAssistant.respond.call(context, { messages: [] }, userMessage)

    const [, , systemPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(systemPrompt).toMatch(/event-wrapped-up summaries/i)
    expect(systemPrompt).toMatch(/get_event_list/)
    expect(systemPrompt).toMatch(/search_conversation_transcript/)
  })

  test('surfaces member_bios guidance by default', async () => {
    const context = buildContext([])
    const userMessage = { _id: 'm3', body: `${BOT_NAME}, who here works on AI policy?`, channels: ['chat'] }

    await communityAssistant.respond.call(context, { messages: [] }, userMessage)

    const [, , systemPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(systemPrompt).toMatch(/search_members/)
    expect(systemPrompt).toMatch(/untrusted user-supplied text/)
  })

  test('honors an explicit memberBioSearch: false override', async () => {
    const context = buildContext([], { memberBioSearch: false })
    const userMessage = { _id: 'm4', body: `${BOT_NAME}, who here works on AI policy?`, channels: ['chat'] }

    await communityAssistant.respond.call(context, { messages: [] }, userMessage)

    const [, , systemPrompt] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(systemPrompt).not.toMatch(/search_members/)
  })
})

describe('buildEventHistoryToolsPrompt communityAssistant guidance (issue #622)', () => {
  test('tells the model to route event-summary follow-ups to event_history over the wider archive', async () => {
    const prompt = await buildEventHistoryToolsPrompt(false)
    expect(prompt).toMatch(/event-wrapped-up summaries/i)
    expect(prompt).toMatch(/specific past event.*not the wider BKC archive/i)
    expect(prompt).toMatch(/get_event_list/)
    expect(prompt).toMatch(/search_conversation_transcript/)
    expect(prompt).toMatch(/fall back to the archive tools/i)
  })

  test('past-event-scoped guidance (hasActiveConversation=true) is unaffected', async () => {
    const prompt = await buildEventHistoryToolsPrompt(true)
    expect(prompt).not.toMatch(/event-wrapped-up summaries/i)
  })
})
