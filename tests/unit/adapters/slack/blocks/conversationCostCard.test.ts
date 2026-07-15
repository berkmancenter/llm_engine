import renderConversationCostCard from '../../../../../src/adapters/slack/blocks/numberCruncher/conversationCostCard.js'
import renderResponseBlocks from '../../../../../src/adapters/slack/blocks/index.js'
import { ConversationCostData } from '../../../../../src/types/index.types.js'

function makeAggregate(overrides: Record<string, unknown> = {}) {
  return {
    estimatedCostUSD: 1.2,
    totalPromptTokens: 150000,
    totalCompletionTokens: 3000,
    llmCallCount: 9,
    models: [
      { model: 'claude-sonnet', llmCalls: 9, promptTokens: 150000, completionTokens: 3000, estimatedCostUSD: 1.2, priced: true }
    ],
    agents: [{ agentType: 'eventAssistant', llmCalls: 9, estimatedCostUSD: 1.2 }],
    hasUnpricedCalls: false,
    ...overrides
  }
}

const data: ConversationCostData = {
  conversationName: 'The Future of Work',
  liveEvent: makeAggregate(),
  postEvent: makeAggregate({
    estimatedCostUSD: 0.2702,
    totalPromptTokens: 31500,
    totalCompletionTokens: 500,
    llmCallCount: 3,
    models: [{ model: 'gpt-test', llmCalls: 3, promptTokens: 31500, completionTokens: 500, estimatedCostUSD: 0.2702 }],
    agents: [{ agentType: 'vibesAnalyst', llmCalls: 3, estimatedCostUSD: 0.2702 }]
  }),
  total: makeAggregate({
    estimatedCostUSD: 1.4702,
    totalPromptTokens: 181500,
    totalCompletionTokens: 3500,
    llmCallCount: 12,
    models: [
      { model: 'claude-sonnet', llmCalls: 9, promptTokens: 150000, completionTokens: 3000, estimatedCostUSD: 1.2, priced: true },
      { model: 'gpt-test', llmCalls: 3, promptTokens: 31500, completionTokens: 500, estimatedCostUSD: 0.2702, priced: true }
    ],
    agents: [
      { agentType: 'eventAssistant', llmCalls: 9, estimatedCostUSD: 1.2 },
      { agentType: 'vibesAnalyst', llmCalls: 3, estimatedCostUSD: 0.2702 }
    ]
  }),
  checkedAt: '2026-07-13T18:30:00.000Z'
}

function textOf(blocks: unknown[]): string {
  return JSON.stringify(blocks)
}

describe('renderConversationCostCard', () => {
  it('renders header, combined estimate with caveat, phase breakdown, by-model/agent breakdowns, and footer', () => {
    const blocks = renderConversationCostCard(data)
    const text = textOf(blocks)

    expect(blocks[0]).toEqual(
      expect.objectContaining({
        type: 'header',
        text: expect.objectContaining({ text: expect.stringContaining('The Future of Work') })
      })
    )
    expect(text).toContain('~$1.47')
    expect(text).toContain('12 LLM calls')
    // Phase breakdown
    expect(text).toContain('During the event')
    expect(text).toContain('$1.20')
    expect(text).toContain('After it ended')
    expect(text).toContain('$0.27')
    // Combined by-model / by-agent breakdown (from `total`)
    expect(text).toContain('claude-sonnet')
    expect(text).toContain('150,000')
    expect(text).toContain('vibesAnalyst')
    expect(text).toContain('LangSmith estimate')
    // Footer is a context block
    expect(blocks[blocks.length - 1]).toEqual(expect.objectContaining({ type: 'context' }))
  })

  it('omits the model and agent sections when there is no breakdown', () => {
    const blocks = renderConversationCostCard({ ...data, total: { ...data.total, models: [], agents: [] } })
    const text = textOf(blocks)

    expect(text).not.toContain('By model')
    expect(text).not.toContain('By agent')
    expect(text).toContain('~$1.47')
  })

  it('omits the post-event line when nothing was spent after the event stopped', () => {
    const zeroPostEvent = {
      estimatedCostUSD: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      llmCallCount: 0,
      models: [],
      agents: [],
      hasUnpricedCalls: false
    }
    const blocks = renderConversationCostCard({ ...data, postEvent: zeroPostEvent, total: data.liveEvent })
    const text = textOf(blocks)

    expect(text).not.toContain('After it ended')
  })

  it('shows a caveat and marks the model row when a model could not be priced', () => {
    const total = {
      ...data.total,
      models: [
        ...data.total.models,
        { model: 'llama3-local', llmCalls: 2, promptTokens: 400, completionTokens: 80, estimatedCostUSD: 0, priced: false }
      ],
      hasUnpricedCalls: true
    }
    const blocks = renderConversationCostCard({ ...data, total })
    const text = textOf(blocks)

    expect(text).toContain('could not be priced')
    expect(text).toContain('llama3-local')
    expect(text).toContain('cost unknown')
    // The other, priced models still show a real dollar figure, not "cost unknown".
    expect(text).toContain('$1.20')
  })

  it('does not show the unpriced caveat when every model was priced', () => {
    const blocks = renderConversationCostCard(data)
    const text = textOf(blocks)

    expect(text).not.toContain('could not be priced')
    expect(text).not.toContain('cost unknown')
  })

  it('truncates long conversation names to fit Slack header limits', () => {
    const longName = 'x'.repeat(300)
    const blocks = renderConversationCostCard({ ...data, conversationName: longName })
    const header = blocks[0] as { text: { text: string } }

    expect(header.text.text.length).toBeLessThanOrEqual(150)
  })

  it('is registered in the block registry under conversationCostSummary', () => {
    const blocks = renderResponseBlocks('conversationCostSummary', data)

    expect(blocks).toBeDefined()
    expect(textOf(blocks!)).toContain('The Future of Work')
  })
})
