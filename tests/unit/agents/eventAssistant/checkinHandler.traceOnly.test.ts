import { jest } from '@jest/globals'

/* processParticipant (checkinHandler.ts) used to return null whenever a participant's analysis
   ran but didn't lead to a check-in (no directMessage, or a hallucinated citation), discarding
   the model's reasoning entirely. It now returns a traceOnly response carrying that reasoning
   instead, so eventAssistant's own formatTraceOutput can surface it — same pattern as
   proactiveGroupAgent. detectPrivateInterventionOpportunity is mocked, so no real LLM call
   happens. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDetectPrivateInterventionOpportunity = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/interventionHandler.js', () => ({
  detectPrivateInterventionOpportunity: mockDetectPrivateInterventionOpportunity
}))

const { processParticipant } = await import('../../../../src/agents/eventAssistant/checkinHandler.js')

const GOAL = {
  id: 'test_goal',
  label: 'Test goal',
  description: 'A goal with no special requirements, for test use only.',
  channel: 'dm' as const,
  triggers: { conditions: [], minConfidence: 60 },
  guardrails: [],
  outputContract: { format: 'text' as const },
  examples: []
}

function makeChannel() {
  return { name: 'direct-user-1-agent-1', direct: true, participants: [] }
}

function makeContext() {
  return {
    _id: 'agent-1',
    agentType: 'eventAssistant',
    agentConfig: {},
    conversation: {
      channels: [makeChannel()],
      behaviorPolicy: undefined,
      conversationContext: undefined,
      startTime: new Date()
    },
    getLLM: async () => ({})
  }
}

function history() {
  return { start: new Date(Date.now() - 600_000), end: new Date(), messages: [] }
}

async function run() {
  return processParticipant.call(
    makeContext(),
    makeChannel(),
    history(),
    [GOAL],
    history(),
    history(),
    'No event signals.',
    ''
  )
}

describe('checkinHandler processParticipant', () => {
  beforeEach(() => {
    mockDetectPrivateInterventionOpportunity.mockReset()
  })

  it('returns null (no traceOnly) when rate limited for this participant', async () => {
    mockDetectPrivateInterventionOpportunity.mockResolvedValue(null)

    const result = await run()

    expect(result).toBeNull()
  })

  it('returns a traceOnly response carrying reasoning when no check-in was warranted', async () => {
    mockDetectPrivateInterventionOpportunity.mockResolvedValue({
      shouldIntervene: false,
      goalId: 'none',
      reasoning: 'Nothing concerning in their recent messages.',
      directMessage: null,
      confidenceScore: 10
    })

    const result = await run()

    expect(result).not.toBeNull()
    expect(result.traceOnly).toBe(true)
    expect(result.visible).toBe(false)
    expect((result.message as { type: string }).type).toBe('checkin')
    expect(result.reasoning).toBe('Nothing concerning in their recent messages.')
  })

  it('returns a traceOnly response, not null, when a cited cross-participant claim is hallucinated', async () => {
    mockDetectPrivateInterventionOpportunity.mockResolvedValue({
      shouldIntervene: true,
      goalId: 'test_goal',
      reasoning: 'They seem to be echoing a sentiment others raised.',
      directMessage: 'A few others mentioned feeling the same.',
      confidenceScore: 90,
      sourceMessages: [{ participant: 'Someone', text: 'a message that was never actually sent' }]
    })

    const result = await run()

    expect(result).not.toBeNull()
    expect(result.traceOnly).toBe(true)
    expect(result.reasoning).toBe('They seem to be echoing a sentiment others raised.')
  })

  it('returns a real, visible response when a check-in is warranted', async () => {
    mockDetectPrivateInterventionOpportunity.mockResolvedValue({
      shouldIntervene: true,
      goalId: 'test_goal',
      reasoning: 'A clear, individual pattern worth acknowledging.',
      directMessage: 'Just checking in — how are you finding it so far?',
      confidenceScore: 90
    })

    const result = await run()

    expect(result).not.toBeNull()
    expect(result.traceOnly).toBeUndefined()
    expect(result.visible).toBe(true)
    expect((result.message as { text: string }).text).toBe('Just checking in — how are you finding it so far?')
  })
})
