import { jest } from '@jest/globals'

/* The agent loop, the tool set, and the fact-checking pass are each tested in their own files.
   Here they are mocked so this file can check the wiring: that the tools reach the loop, that
   what those tools computed reaches the fact-checker alongside the metrics, and that an answer
   the fact-checker rejects never reaches the asker. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAgentStructuredResponse = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateTools = jest.fn<(...args: any[]) => any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockVerifyCuratedCard = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getAgentStructuredResponse: mockGetAgentStructuredResponse
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/tools.js', () => ({
  default: mockCreateTools
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/verifyCuration.js', () => ({
  default: mockVerifyCuratedCard
}))

const { default: answerWithOnDemandMetrics } = await import('../../../../src/agents/vibesAnalyst/onDemand.js')
const { default: logger } = await import('../../../../src/config/logger.js')
const { default: makeMetrics } = await import('../../../utils/metricsFixture.js')

describe('answerWithOnDemandMetrics', () => {
  const conversation = { _id: 'c1', name: 'Spring Town Hall', startTime: new Date('2026-07-01T12:00:00.000Z') }
  const metrics = makeMetrics()
  const llm = { fakeLlm: true }
  const fakeTools = [{ name: 'count_messages' }]

  // What a tool call would have recorded. The real array fills as the model calls tools; here
  // the mocked loop pushes into it so the fact-checking assertion has something to look for.
  const computation = {
    tool: 'count_messages',
    args: { toMinute: 10 },
    result: { messageCount: 31, posterCount: 12 }
  }

  let computations

  beforeEach(() => {
    jest.restoreAllMocks()
    computations = []
    mockCreateTools.mockReset()
    mockCreateTools.mockImplementation(() => ({ tools: fakeTools, computations }))
    mockGetAgentStructuredResponse.mockReset()
    mockGetAgentStructuredResponse.mockImplementation(async () => {
      computations.push(computation)
      return {
        reasoning: '31 messages in the first ten minutes',
        answerable: true,
        text: '31 messages landed in the first ten minutes.'
      }
    })
    mockVerifyCuratedCard.mockReset()
    mockVerifyCuratedCard.mockImplementation(async (card) => card)
  })

  it('answers from a computation the model ran over the event', async () => {
    const answer = await answerWithOnDemandMetrics('how busy were the first ten minutes?', conversation, metrics, llm)

    expect(answer).toBe('31 messages landed in the first ten minutes.')
    // The tools are bound to this one event, so another event's data can never enter the answer.
    expect(mockCreateTools).toHaveBeenCalledWith(conversation)
    const [passedLlm, passedTools, systemPrompt, userMessage] = mockGetAgentStructuredResponse.mock.calls[0]
    expect(passedLlm).toBe(llm)
    expect(passedTools).toBe(fakeTools)
    expect(systemPrompt).toContain('Vibes Analyst')
    expect(userMessage).toContain('how busy were the first ten minutes?')
    expect(userMessage).toContain('Spring Town Hall')
  })

  it('hands what the tools computed to the fact-checker alongside the metrics', async () => {
    await answerWithOnDemandMetrics('how busy were the first ten minutes?', conversation, metrics, llm)

    const [card, checkedMetrics, criticLlm] = mockVerifyCuratedCard.mock.calls[0]
    expect(card.standouts).toEqual([{ text: '31 messages landed in the first ten minutes.' }])
    // Without the computations the fact-checker would see a number backed by nothing and
    // correctly drop every on-demand answer.
    expect(checkedMetrics).toEqual({ ...metrics, onDemandComputations: [computation] })
    expect(criticLlm).toBe(llm)
  })

  it('withholds an answer the fact-checker could not back', async () => {
    mockVerifyCuratedCard.mockResolvedValue({ header: 'x', standouts: [] })

    const answer = await answerWithOnDemandMetrics('how busy were the first ten minutes?', conversation, metrics, llm)

    expect(answer).toBeNull()
  })

  it('returns nothing when the model reports the question is not answerable', async () => {
    mockGetAgentStructuredResponse.mockResolvedValue({ reasoning: 'no tool covers this', answerable: false, text: null })

    const answer = await answerWithOnDemandMetrics('what did the speaker mean?', conversation, metrics, llm)

    expect(answer).toBeNull()
    expect(mockVerifyCuratedCard).not.toHaveBeenCalled()
  })

  it('returns nothing and logs when the agent loop fails, rather than throwing at the caller', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
    mockGetAgentStructuredResponse.mockRejectedValue(new Error('model timed out'))

    const answer = await answerWithOnDemandMetrics('how busy was it?', conversation, metrics, llm)

    expect(answer).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('model timed out'))
  })
})
