import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'

/* Mock the Matomo fetcher so the registry test controls what each source returns,
   without making real Reporting API calls. The registry's job under test is the
   loop and the per-source upsert, not the fetch. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchMatomo = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule('../src/services/analyticsSources/matomo.js', () => ({
  default: mockFetchMatomo,
  fetchMatomoSnapshot: mockFetchMatomo
}))

const { fetchAndStoreSnapshot } = await import('../../../../src/services/analyticsSources/index.js')
const { default: ConversationAnalytics } = await import('../../../../src/models/conversationAnalytics.model.js')

setupIntTest()

const sampleSnapshot = () => ({
  attendeeCount: 50,
  totalVisits: 120,
  totalActions: 940,
  totalDwellSeconds: 36000,
  deviceBreakdown: { desktop: 80, mobile: 40 }
})

describe('fetchAndStoreSnapshot', () => {
  beforeAll(async () => {
    await ConversationAnalytics.syncIndexes()
  })

  beforeEach(() => {
    mockFetchMatomo.mockReset()
  })

  it('stores one snapshot document for a source that returns data', async () => {
    mockFetchMatomo.mockResolvedValue(sampleSnapshot())
    const conversationId = new mongoose.Types.ObjectId()

    await fetchAndStoreSnapshot({ _id: conversationId })

    const stored = await ConversationAnalytics.find({ conversationId })
    expect(stored).toHaveLength(1)
    expect(stored[0].source).toBe('matomo')
    expect(stored[0].totalVisits).toBe(120)
    expect(stored[0].deviceBreakdown).toMatchObject({ desktop: 80, mobile: 40 })
    expect(stored[0].capturedAt).toBeInstanceOf(Date)
  })

  it('overwrites the same source snapshot on a re-run instead of duplicating it', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    mockFetchMatomo.mockResolvedValue(sampleSnapshot())
    await fetchAndStoreSnapshot({ _id: conversationId })

    mockFetchMatomo.mockResolvedValue({ ...sampleSnapshot(), totalVisits: 200 })
    await fetchAndStoreSnapshot({ _id: conversationId })

    const stored = await ConversationAnalytics.find({ conversationId })
    expect(stored).toHaveLength(1)
    expect(stored[0].totalVisits).toBe(200)
  })

  it('skips a source that returns null without writing anything', async () => {
    mockFetchMatomo.mockResolvedValue(null)
    const conversationId = new mongoose.Types.ObjectId()

    await fetchAndStoreSnapshot({ _id: conversationId })

    expect(await ConversationAnalytics.countDocuments({ conversationId })).toBe(0)
  })
})
