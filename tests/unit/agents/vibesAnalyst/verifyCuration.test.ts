import { jest } from '@jest/globals'
import { ConversationMetrics, CuratedVibesData } from '../../../../src/types/index.types.js'
import makeMetrics from '../../../utils/metricsFixture.js'

// The critic model call is the only LLM dependency, so it is the only mock.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse
}))

const { default: verifyCuratedCard, dropUnbackedCharts } = await import(
  '../../../../src/agents/vibesAnalyst/verifyCuration.js'
)
const { buildChartCandidates } = await import('../../../../src/agents/vibesAnalyst/curate.js')
const { default: logger } = await import('../../../../src/config/logger.js')

/* Minimal metrics with enough to build at least the activity and channel-split
   charts, so the test can attach a real chart and a fabricated one. */
function metricsFixture(): ConversationMetrics {
  return makeMetrics({
    activitySeries: [
      { label: '0-10', messageCount: 5 },
      { label: '10-20', messageCount: 15 },
      { label: '20-30', messageCount: 30 }
    ],
    participationHistory: [],
    baseline: null
  })
}

describe('dropUnbackedCharts', () => {
  it('keeps a chart that matches one built from the metrics', () => {
    const metrics = metricsFixture()
    const candidates = buildChartCandidates(metrics)

    const card: CuratedVibesData = {
      header: 'Test event recap',
      standouts: [
        { text: 'Activity climbed late', visual: { title: candidates.activity.title, chart: candidates.activity.chart } }
      ],
      durationMinutes: 30
    }

    const result = dropUnbackedCharts(card, metrics)

    expect(result.standouts[0].visual).toBeDefined()
    expect(result.standouts[0].visual!.chart).toEqual(candidates.activity.chart)
  })

  it('strips a chart whose data does not come from the metrics, keeping the prose', () => {
    const metrics = metricsFixture()

    const card: CuratedVibesData = {
      header: 'Test event recap',
      standouts: [
        {
          text: 'A made-up surge',
          visual: {
            title: 'Messages over time',
            // Values here exist nowhere in the metrics, so this chart is unbacked.
            chart: {
              type: 'bar',
              series: [{ name: 'Messages', data: [{ label: '0-10', value: 999 }] }],
              axisConfig: { categories: ['0-10'], yLabel: 'Messages' }
            }
          }
        }
      ],
      durationMinutes: 30
    }

    const result = dropUnbackedCharts(card, metrics)

    expect(result.standouts[0].visual).toBeUndefined()
    expect(result.standouts[0].text).toBe('A made-up surge')
  })

  it('leaves a text-only standout untouched', () => {
    const metrics = metricsFixture()

    const card: CuratedVibesData = {
      header: 'Test event recap',
      standouts: [{ text: 'Half the registrants spoke up' }],
      durationMinutes: 30
    }

    const result = dropUnbackedCharts(card, metrics)

    expect(result.standouts[0]).toEqual({ text: 'Half the registrants spoke up' })
  })
})

describe('verifyCuratedCard', () => {
  const llm = { fake: true }
  const answerCard: CuratedVibesData = {
    header: 'Answer about Spring Town Hall',
    standouts: [{ text: '4 people posted more than three times during the Spring Town Hall.' }]
  }

  beforeEach(() => {
    jest.restoreAllMocks()
    mockGetChatPromptResponse.mockReset()
    mockGetChatPromptResponse.mockResolvedValue({ verdicts: [{ index: 0, reasoning: 'matches', supported: true }] })
  })

  it('shows the critic the event and the question an on-demand answer responds to', async () => {
    await verifyCuratedCard(answerCard, makeMetrics(), llm, {
      eventName: 'Spring Town Hall',
      question: 'how many people posted more than three times?'
    })

    const [, , , inputParams] = mockGetChatPromptResponse.mock.calls[0]
    expect(inputParams.askedQuestion).toContain('Spring Town Hall')
    expect(inputParams.askedQuestion).toContain('how many people posted more than three times?')
  })

  it('tells the critic a recap answers no question', async () => {
    await verifyCuratedCard(answerCard, makeMetrics(), llm)

    const [, , , inputParams] = mockGetChatPromptResponse.mock.calls[0]
    expect(inputParams.askedQuestion).not.toContain('Spring Town Hall')
  })

  it('logs why the critic dropped a standout', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
    mockGetChatPromptResponse.mockResolvedValue({
      verdicts: [{ index: 0, reasoning: 'no backing', supported: false, issue: 'states 69% but no count backs it' }]
    })

    const result = await verifyCuratedCard(answerCard, makeMetrics(), llm)

    expect(result.standouts).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('states 69% but no count backs it'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(answerCard.standouts[0].text))
  })
})
