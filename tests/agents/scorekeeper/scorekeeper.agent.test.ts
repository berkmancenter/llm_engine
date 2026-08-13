/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals'
import mongoose from 'mongoose'

import setupIntTest from '../../utils/setupIntTest.js'

// Mock fetchQualityScores so the agent never hits LangSmith
const mockFetchQualityScores = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/scorekeeper/fetchQualityScores.js', () => ({
  fetchQualityScores: mockFetchQualityScores
}))

const { default: scorekeeperAgentType } = await import('../../../src/agents/scorekeeper/agent.js')
const { default: Conversation } = await import('../../../src/models/conversation.model.js')
const { default: QualityReport } = await import('../../../src/models/qualityReport.model.js')
const { AgentMessageActions } = await import('../../../src/types/index.types.js')

jest.setTimeout(15000)
setupIntTest()

const CONV_ID = new mongoose.Types.ObjectId()
const CONV_NAME = 'AI in Education'

function makeScores(overrides = {}) {
  return {
    evaluators: [{ key: 'compliance.tone', mean: 0.82, min: 0.5, count: 10, lowScoreCount: 1 }],
    overallMean: 0.82,
    tracesScored: 10,
    lowScoreTraces: [],
    totalLowScoreCount: 0,
    ...overrides
  }
}

// Bind respond() to a minimal agent context
function callRespond(channels: any[] = [{ name: 'scorekeeper' }]) {
  return scorekeeperAgentType.respond.call({ conversation: { channels } })
}

// Mock Conversation.find to return the given lean array
function mockConversations(convs: any[]) {
  jest.spyOn(Conversation, 'find').mockReturnValue({
    select: jest.fn().mockReturnValue({
      populate: jest.fn().mockReturnValue({
        lean: jest.fn<() => Promise<any>>().mockResolvedValue(convs)
      })
    })
  } as any)
}

describe('scorekeeper agent respond()', () => {
  beforeAll(async () => {
    await QualityReport.syncIndexes()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('returns empty when no conversations started in the last 24 hours', async () => {
    mockConversations([])
    const responses = await callRespond()
    expect(responses).toHaveLength(0)
  })

  it('queries for conversations that ended today where endTime > startTime', async () => {
    const findSpy = jest.spyOn(Conversation, 'find').mockReturnValue({
      select: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn<() => Promise<any>>().mockResolvedValue([])
        })
      })
    } as any)

    await callRespond()

    const query = (findSpy.mock.calls as any[][])[0][0]
    expect(query.endTime.$gte).toBeInstanceOf(Date)
    // endTime.$gte should be approximately 24 hours ago
    const expectedCutoff = Date.now() - 24 * 60 * 60 * 1000
    expect(query.endTime.$gte.getTime()).toBeCloseTo(expectedCutoff, -3)
    expect(query.$expr).toEqual({ $gt: ['$endTime', '$startTime'] })
    expect(query.startTime).toBeUndefined()
  })

  it('posts a quality report for a conversation with scores', async () => {
    const channels = [{ name: 'scorekeeper' }]
    mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: false } }])
    mockFetchQualityScores.mockResolvedValue(makeScores())

    const responses = await callRespond(channels)

    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({
      visible: true,
      responseKind: 'qualityReport',
      channels
    })
  })

  it('includes conversation name, overallMean, and tracesScored in the fallback message', async () => {
    mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: false } }])
    mockFetchQualityScores.mockResolvedValue(makeScores({ overallMean: 0.75, tracesScored: 12 }))

    const responses = await callRespond()

    expect(responses[0].message).toContain(CONV_NAME)
    expect(responses[0].message).toContain('0.75')
    expect(responses[0].message).toContain('12')
  })

  it('passes evaluators, overallMean, tracesScored, lowScoreTraces, and totalLowScoreCount to renderData', async () => {
    const scores = makeScores({
      overallMean: 0.9,
      tracesScored: 7,
      lowScoreTraces: [
        { runId: 'r1', url: 'https://smith.langchain.com/r1', lowScores: [{ key: 'compliance.tone', score: 0.3 }] }
      ],
      totalLowScoreCount: 3
    })
    mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: false } }])
    mockFetchQualityScores.mockResolvedValue(scores)

    const responses = await callRespond()
    const { renderData } = responses[0] as any

    expect(renderData.conversationName).toBe(CONV_NAME)
    expect(renderData.overallMean).toBeCloseTo(0.9)
    expect(renderData.tracesScored).toBe(7)
    expect(renderData.evaluators).toHaveLength(1)
    expect(renderData.lowScoreTraces).toHaveLength(1)
    expect(renderData.totalLowScoreCount).toBe(3)
    expect(renderData.generatedAt).toBeTruthy()
  })

  it('skips a conversation when fetchQualityScores returns null', async () => {
    mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: false } }])
    mockFetchQualityScores.mockResolvedValue(null)

    const responses = await callRespond()
    expect(responses).toHaveLength(0)
  })

  it('posts one report per conversation, skipping those with no scores', async () => {
    const convB = { _id: new mongoose.Types.ObjectId(), name: 'Climate Policy', topic: { private: false } }
    mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: false } }, convB])
    mockFetchQualityScores
      .mockResolvedValueOnce(null) // CONV_ID — no scores
      .mockResolvedValueOnce(makeScores()) // convB — has scores

    const responses = await callRespond()
    expect(responses).toHaveLength(1)
    expect(responses[0].message).toContain('Climate Policy')
  })

  it('persists the quality report to MongoDB', async () => {
    mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: false } }])
    mockFetchQualityScores.mockResolvedValue(makeScores())

    await callRespond()

    const saved = await QualityReport.findOne({ conversationId: CONV_ID })
    expect(saved).not.toBeNull()
    expect(saved!.conversationName).toBe(CONV_NAME)
    expect(saved!.overallMean).toBeCloseTo(0.82)
    expect(saved!.evaluators).toHaveLength(1)
    expect(saved!.evaluators[0].key).toBe('compliance.tone')
  })

  describe('private topic redaction', () => {
    it('uses the real name when topic.private is false', async () => {
      mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: false } }])
      mockFetchQualityScores.mockResolvedValue(makeScores())

      const responses = await callRespond()
      expect(responses[0].renderData.conversationName).toBe(CONV_NAME)
      expect(responses[0].message).toContain(CONV_NAME)
    })

    it('redacts the name when topic.private is true', async () => {
      mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: true } }])
      mockFetchQualityScores.mockResolvedValue(makeScores())

      const responses = await callRespond()
      expect(responses[0].renderData.conversationName).toBe('a private conversation')
      expect(responses[0].message).not.toContain(CONV_NAME)
    })

    it('redacts the name when topic is missing (fail-closed)', async () => {
      mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: undefined }])
      mockFetchQualityScores.mockResolvedValue(makeScores())

      const responses = await callRespond()
      expect(responses[0].renderData.conversationName).toBe('a private conversation')
    })

    it('persists the redacted name to MongoDB for private conversations', async () => {
      mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: true } }])
      mockFetchQualityScores.mockResolvedValue(makeScores())

      await callRespond()

      const saved = await QualityReport.findOne({ conversationId: CONV_ID })
      expect(saved!.conversationName).toBe('a private conversation')
    })
  })

  describe('baseline deltas', () => {
    async function seedBaselineReports(count: number, mean = 0.70) {
      const yesterday = new Date()
      yesterday.setUTCDate(yesterday.getUTCDate() - 1)
      yesterday.setUTCHours(0, 0, 0, 0)
      await QualityReport.insertMany(
        Array.from({ length: count }, (_, i) => ({
          conversationId: new mongoose.Types.ObjectId(),
          conversationName: `Baseline Conv ${i}`,
          reportDate: yesterday,
          evaluators: [{ key: 'compliance.tone', mean, min: 0.5, count: 10, lowScoreCount: 0 }],
          overallMean: mean,
          tracesScored: 10,
          totalLowScoreCount: 0
        }))
      )
    }

    it('omits deltas when fewer than 5 baseline reports exist', async () => {
      await seedBaselineReports(4)
      mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: false } }])
      mockFetchQualityScores.mockResolvedValue(makeScores())

      const responses = await callRespond()
      const { renderData } = responses[0] as any
      expect(renderData.deltas).toBeUndefined()
      expect(renderData.baselineSampleCount).toBeUndefined()
    })

    it('includes deltas and baselineSampleCount when 5+ baseline reports exist', async () => {
      await seedBaselineReports(5, 0.70)
      mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: false } }])
      mockFetchQualityScores.mockResolvedValue(
        makeScores({
          overallMean: 0.82,
          evaluators: [{ key: 'compliance.tone', mean: 0.82, min: 0.5, count: 10, lowScoreCount: 1 }]
        })
      )

      const responses = await callRespond()
      const { renderData } = responses[0] as any
      expect(renderData.baselineSampleCount).toBe(5)
      expect(renderData.deltas?.['compliance.tone']).toBeCloseTo(0.12) // 0.82 - 0.70
    })

    it('excludes the current conversation from the baseline calculation', async () => {
      await seedBaselineReports(5, 0.70)
      // Also seed a report for CONV_ID with a very different mean — should not skew baseline
      const yesterday = new Date()
      yesterday.setUTCDate(yesterday.getUTCDate() - 1)
      yesterday.setUTCHours(0, 0, 0, 0)
      await QualityReport.create({
        conversationId: CONV_ID,
        conversationName: CONV_NAME,
        reportDate: yesterday,
        evaluators: [{ key: 'compliance.tone', mean: 0.10, min: 0.0, count: 10, lowScoreCount: 8 }],
        overallMean: 0.10,
        tracesScored: 10,
        totalLowScoreCount: 8
      })

      mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: false } }])
      mockFetchQualityScores.mockResolvedValue(
        makeScores({
          overallMean: 0.82,
          evaluators: [{ key: 'compliance.tone', mean: 0.82, min: 0.5, count: 10, lowScoreCount: 1 }]
        })
      )

      const responses = await callRespond()
      const { renderData } = responses[0] as any
      // sampleCount should be 5, not 6 — CONV_ID report excluded
      expect(renderData.baselineSampleCount).toBe(5)
      // delta should be against 0.70 baseline, not the skewed 0.10
      expect(renderData.deltas?.['compliance.tone']).toBeCloseTo(0.12)
    })
  })

  it('skips a conversation that already has a report for today', async () => {
    // Pre-insert a report for today
    const midnight = new Date()
    midnight.setUTCHours(0, 0, 0, 0)
    await QualityReport.create({
      conversationId: CONV_ID,
      conversationName: CONV_NAME,
      reportDate: midnight,
      evaluators: [{ key: 'compliance.tone', mean: 0.7, min: 0.5, count: 5, lowScoreCount: 0 }],
      overallMean: 0.7,
      tracesScored: 5,
      totalLowScoreCount: 0
    })

    mockConversations([{ _id: CONV_ID, name: CONV_NAME, topic: { private: false } }])

    const responses = await callRespond()
    expect(responses).toHaveLength(0)
    expect(mockFetchQualityScores).not.toHaveBeenCalled()
  })
})

describe('scorekeeper agent evaluate()', () => {
  it('always returns CONTRIBUTE', async () => {
    const evaluation = await scorekeeperAgentType.evaluate.call({})
    expect(evaluation.action).toBe(AgentMessageActions.CONTRIBUTE)
  })
})
