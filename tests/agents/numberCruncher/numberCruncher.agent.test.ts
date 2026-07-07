import mongoose from 'mongoose'
import { Channel } from '../../../src/models/index.js'
import setupIntTest from '../../utils/setupIntTest.js'
import numberCruncherAgentType from '../../../src/agents/numberCruncher/agent.js'
import renderBudgetAlertCard from '../../../src/adapters/slack/blocks/numberCruncher/budgetAlertCard.js'
import { AgentMessageActions } from '../../../src/types/index.types.js'

jest.setTimeout(15000)
setupIntTest()

const BUDGET_ENDPOINT_1 = 'https://api.example.com/budget/bedrock'
const BUDGET_ENDPOINT_2 = 'https://api.example.com/budget/openai'

function makeBudgetConfig(overrides = {}) {
  return {
    label: 'AWS Bedrock',
    endpoint: BUDGET_ENDPOINT_1,
    apiKey: 'test-api-key',
    thresholdPercent: 80,
    ...overrides
  }
}

function mockBudgetResponse(limit: string, remaining: string) {
  return {
    quota: { limit, limit_unit: 'USD', interval: '1', unit: 'month' },
    remaining_limit: remaining
  }
}

// Call the agent type's respond() directly, bound to a minimal agent context.
// This avoids the model wrapper's active/tracing/history guards which are
// orthogonal to what we're testing here.
async function callRespond(agentConfig, channels) {
  return numberCruncherAgentType.respond.call({ agentConfig, conversation: { channels } })
}

describe('numberCruncher agent type', () => {
  let channels

  beforeEach(async () => {
    channels = await Channel.insertMany([{ name: 'numberCruncher' }])
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('respond()', () => {
    it('posts an alert when a budget exceeds the threshold', async () => {
      jest.spyOn(global, 'fetch' as never).mockResolvedValueOnce({
        ok: true,
        json: async () => mockBudgetResponse('250.0', '30.0')
      } as never)

      // 220 used of 250 = 88%
      const responses = await callRespond({ budgets: [makeBudgetConfig({ thresholdPercent: 15 })] }, channels)

      expect(responses).toHaveLength(1)
      expect(responses[0].responseKind).toBe('budgetAlert')
      expect(responses[0].renderData.alerts).toHaveLength(1)
      expect(responses[0].renderData.alerts[0].label).toBe('AWS Bedrock')
      expect(responses[0].renderData.alerts[0].percentUsed).toBeCloseTo(88)
      expect(responses[0].renderData.alerts[0].used).toBeCloseTo(220)
      expect(responses[0].renderData.alerts[0].limit).toBeCloseTo(250)
    })

    it('does not post when all budgets are under threshold', async () => {
      jest.spyOn(global, 'fetch' as never).mockResolvedValueOnce({
        ok: true,
        json: async () => mockBudgetResponse('250.0', '200.0')
      } as never)

      // 50 used of 250 = 20%
      const responses = await callRespond({ budgets: [makeBudgetConfig({ thresholdPercent: 80 })] }, channels)

      expect(responses).toHaveLength(0)
    })

    it('posts alerts only for budgets that exceed the threshold', async () => {
      jest
        .spyOn(global, 'fetch' as never)
        .mockResolvedValueOnce({ ok: true, json: async () => mockBudgetResponse('250.0', '30.0') } as never) // 88% — over
        .mockResolvedValueOnce({ ok: true, json: async () => mockBudgetResponse('100.0', '60.0') } as never) // 40% — under

      const responses = await callRespond(
        {
          budgets: [
            makeBudgetConfig({ label: 'AWS Bedrock', endpoint: BUDGET_ENDPOINT_1, thresholdPercent: 80 }),
            makeBudgetConfig({ label: 'OpenAI', endpoint: BUDGET_ENDPOINT_2, thresholdPercent: 80 })
          ]
        },
        channels
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].renderData.alerts).toHaveLength(1)
      expect(responses[0].renderData.alerts[0].label).toBe('AWS Bedrock')
    })

    it('fires when usage is exactly at the threshold', async () => {
      jest.spyOn(global, 'fetch' as never).mockResolvedValueOnce({
        ok: true,
        json: async () => mockBudgetResponse('250.0', '50.0')
      } as never)

      // 200 used of 250 = exactly 80%
      const responses = await callRespond({ budgets: [makeBudgetConfig({ thresholdPercent: 80 })] }, channels)

      expect(responses).toHaveLength(1)
      expect(responses[0].renderData.alerts[0].percentUsed).toBeCloseTo(80)
    })

    it('returns empty when budgets config is missing', async () => {
      const responses = await callRespond({}, channels)
      expect(responses).toHaveLength(0)
    })

    it('returns empty when budgets array is empty', async () => {
      const responses = await callRespond({ budgets: [] }, channels)
      expect(responses).toHaveLength(0)
    })

    it('skips a budget endpoint that returns a non-ok response', async () => {
      jest
        .spyOn(global, 'fetch' as never)
        .mockResolvedValueOnce({ ok: false, status: 401 } as never)
        .mockResolvedValueOnce({ ok: true, json: async () => mockBudgetResponse('100.0', '5.0') } as never) // 95% — over

      const responses = await callRespond(
        {
          budgets: [
            makeBudgetConfig({ label: 'Failing', endpoint: BUDGET_ENDPOINT_1, thresholdPercent: 80 }),
            makeBudgetConfig({ label: 'OpenAI', endpoint: BUDGET_ENDPOINT_2, thresholdPercent: 80 })
          ]
        },
        channels
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].renderData.alerts[0].label).toBe('OpenAI')
    })

    it('skips a budget endpoint that throws a network error', async () => {
      jest
        .spyOn(global, 'fetch' as never)
        .mockRejectedValueOnce(new Error('network error') as never)
        .mockResolvedValueOnce({ ok: true, json: async () => mockBudgetResponse('100.0', '5.0') } as never)

      const responses = await callRespond(
        {
          budgets: [
            makeBudgetConfig({ label: 'Failing', endpoint: BUDGET_ENDPOINT_1, thresholdPercent: 80 }),
            makeBudgetConfig({ label: 'OpenAI', endpoint: BUDGET_ENDPOINT_2, thresholdPercent: 80 })
          ]
        },
        channels
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].renderData.alerts[0].label).toBe('OpenAI')
    })

    it('skips a budget endpoint that returns an unexpected response shape', async () => {
      jest.spyOn(global, 'fetch' as never).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ unexpected: 'shape' })
      } as never)

      const responses = await callRespond({ budgets: [makeBudgetConfig()] }, channels)
      expect(responses).toHaveLength(0)
    })

    it('sends the api key as a Bearer token', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValueOnce({
        ok: true,
        json: async () => mockBudgetResponse('250.0', '30.0')
      } as never)

      await callRespond({ budgets: [makeBudgetConfig({ apiKey: 'secret-key-123' })] }, channels)

      expect(fetchSpy).toHaveBeenCalledWith(
        BUDGET_ENDPOINT_1,
        expect.objectContaining({ headers: { Authorization: 'Bearer secret-key-123' } })
      )
    })

    it('includes a checkedAt timestamp in the render data', async () => {
      jest.spyOn(global, 'fetch' as never).mockResolvedValueOnce({
        ok: true,
        json: async () => mockBudgetResponse('250.0', '30.0')
      } as never)

      const before = new Date()
      const responses = await callRespond({ budgets: [makeBudgetConfig()] }, channels)
      const after = new Date()

      const checkedAt = new Date(responses[0].renderData.checkedAt)
      expect(checkedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(checkedAt.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('posts to the conversation channels', async () => {
      jest.spyOn(global, 'fetch' as never).mockResolvedValueOnce({
        ok: true,
        json: async () => mockBudgetResponse('250.0', '30.0')
      } as never)

      const responses = await callRespond({ budgets: [makeBudgetConfig()] }, channels)

      expect(responses[0].channels).toEqual(channels)
    })
  })

  describe('evaluate()', () => {
    it('always returns CONTRIBUTE', async () => {
      const evaluation = await numberCruncherAgentType.evaluate.call({})
      expect(evaluation.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('passes userMessage through', async () => {
      const msg = { body: 'hello', _id: new mongoose.Types.ObjectId() }
      const evaluation = await numberCruncherAgentType.evaluate.call({}, msg)
      expect(evaluation.userMessage).toBe(msg)
    })
  })
})

describe('renderBudgetAlertCard()', () => {
  it('renders a header block', () => {
    const blocks = renderBudgetAlertCard({
      alerts: [{ label: 'AWS Bedrock', used: 220, limit: 250, percentUsed: 88 }],
      checkedAt: new Date().toISOString()
    })

    expect(blocks.find((b) => b.type === 'header')).toBeDefined()
  })

  it('renders one section per alert', () => {
    const blocks = renderBudgetAlertCard({
      alerts: [
        { label: 'AWS Bedrock', used: 220, limit: 250, percentUsed: 88 },
        { label: 'OpenAI', used: 95, limit: 100, percentUsed: 95 }
      ],
      checkedAt: new Date().toISOString()
    })

    expect(blocks.filter((b) => b.type === 'section')).toHaveLength(2)
  })

  it('includes the label, percent, and amounts in the section text', () => {
    const blocks = renderBudgetAlertCard({
      alerts: [{ label: 'AWS Bedrock', used: 220, limit: 250, percentUsed: 88 }],
      checkedAt: new Date().toISOString()
    })

    const section = blocks.find((b) => b.type === 'section') as { text: { text: string } }
    expect(section.text.text).toContain('AWS Bedrock')
    expect(section.text.text).toContain('88%')
    expect(section.text.text).toContain('$220.00')
    expect(section.text.text).toContain('$250.00')
  })

  it('renders a divider and a footer context block', () => {
    const blocks = renderBudgetAlertCard({
      alerts: [{ label: 'AWS Bedrock', used: 220, limit: 250, percentUsed: 88 }],
      checkedAt: new Date().toISOString()
    })

    expect(blocks.some((b) => b.type === 'divider')).toBe(true)
    expect(blocks.some((b) => b.type === 'context')).toBe(true)
  })
})
