import { jest } from '@jest/globals'

/* The curate and verify steps each make an LLM call, so they are mocked here. This
   unit test checks the wiring: an ended event runs compute then curate then verify
   and posts the verified card. The two LLM passes are exercised in curate.test.ts
   and verifyCuration.test.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCurate = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockVerify = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetModelChat = jest.fn<(...args: any[]) => Promise<any>>()
// The snapshot fetch is exercised in matomo.test.ts; here we only check that the
// agent runs it, off the stop path, before reading metrics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchAndStoreSnapshot = jest.fn<(...args: any[]) => Promise<void>>()

jest.unstable_mockModule('../src/agents/vibesAnalyst/curate.js', () => ({
  default: mockCurate
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/verifyCuration.js', () => ({
  default: mockVerify
}))
jest.unstable_mockModule('../src/agents/helpers/getModelChat.js', () => ({
  getModelChat: mockGetModelChat,
  defaultLLMPlatform: 'bedrock',
  defaultLLMModel: 'test-model'
}))
jest.unstable_mockModule('../src/services/analyticsSources/index.js', () => ({
  default: { fetchAndStoreSnapshot: mockFetchAndStoreSnapshot }
}))

const { default: vibesAnalyst } = await import('../../../../src/agents/vibesAnalyst/index.js')
const { HELLO_MESSAGE } = await import('../../../../src/agents/vibesAnalyst/prompt.js')
const { default: Conversation } = await import('../../../../src/models/conversation.model.js')
const { default: conversationAnalyticsService } = await import('../../../../src/services/conversationAnalytics.service.js')
const { AccessDeniedError } = await import('../../../../src/auth/access.js')

describe('vibesAnalyst agent', () => {
  it('imports without verify() throwing and is named Vibes Analyst', () => {
    expect(vibesAnalyst.name).toBe('Vibes Analyst')
  })

  it('greets the channel it is introduced to with the hardcoded hello', async () => {
    const channel = { name: 'va-admin' }
    const responses = await vibesAnalyst.introduce.call(vibesAnalyst, channel)

    expect(responses).toHaveLength(1)
    expect(responses[0].visible).toBe(true)
    expect(responses[0].message).toBe(HELLO_MESSAGE)
    expect(responses[0].channels).toEqual([channel])
  })

  describe('onConversationEvent', () => {
    const adminChannel = { name: 'va-admin' }

    // A fake agent context: __t marks it as an Agent for the access check, and
    // the allPublicTopics read grant matches any non-private event.
    function buildContext() {
      return {
        __t: 'Agent',
        capabilities: { read: [{ type: 'allPublicTopics' }], write: [{ type: 'ownConversation' }] },
        conversation: { _id: 'va-conv-id', channels: [adminChannel] }
      }
    }

    const sampleMetrics = {
      participation: { posterCount: 5, frequentPosterCount: 1, frequentPosterMessageShare: 0.4, messageCount: 20 }
    }
    const verifiedCard = { header: 'Recap', standouts: [{ text: 'Half spoke up' }], durationMinutes: 60 }

    function mockStoppedConversation(topicIsPrivate: boolean) {
      jest.spyOn(Conversation, 'findById').mockReturnValue({
        populate: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          _id: 'c1',
          name: 'The Future of Work',
          startTime: new Date('2026-06-10T10:00:00.000Z'),
          endTime: new Date('2026-06-10T11:00:00.000Z'),
          topic: { _id: 't1', private: topicIsPrivate }
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    }

    beforeEach(() => {
      jest.restoreAllMocks()
      mockCurate.mockReset()
      mockVerify.mockReset()
      mockGetModelChat.mockReset()
      mockGetModelChat.mockResolvedValue({ fakeLlm: true })
      mockFetchAndStoreSnapshot.mockReset()
      mockFetchAndStoreSnapshot.mockResolvedValue(undefined)
    })

    it('returns empty for non-conversationStopped events', async () => {
      const responses = await vibesAnalyst.onConversationEvent.call(buildContext(), {
        type: 'somethingElse',
        conversationId: 'c1'
      })
      expect(responses).toEqual([])
    })

    it('computes, curates, and verifies, then posts the curated card to the admin channel', async () => {
      mockStoppedConversation(false)
      const computeSpy = jest
        .spyOn(conversationAnalyticsService, 'computeConversationMetrics')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue(sampleMetrics as any)
      const draftCard = { header: 'Draft', standouts: [{ text: 'Half spoke up' }], durationMinutes: 60 }
      mockCurate.mockResolvedValue(draftCard)
      mockVerify.mockResolvedValue(verifiedCard)

      const responses = await vibesAnalyst.onConversationEvent.call(buildContext(), {
        type: 'conversationStopped',
        conversationId: 'c1',
        topicId: 't1'
      })

      // The snapshot is pulled here, inside the dispatched job, before metrics are
      // read, so a cold Matomo archive can be retried without blocking the event stop.
      expect(mockFetchAndStoreSnapshot).toHaveBeenCalledWith(expect.objectContaining({ _id: 'c1' }))
      expect(mockFetchAndStoreSnapshot.mock.invocationCallOrder[0]).toBeLessThan(computeSpy.mock.invocationCallOrder[0])

      // The event ran one hour, so the card's footer duration is 60 minutes.
      expect(mockCurate).toHaveBeenCalledWith(
        sampleMetrics,
        { eventName: 'The Future of Work', durationMinutes: 60 },
        { fakeLlm: true }
      )
      // Verify is the second pass, fed the draft the curator produced.
      expect(mockVerify).toHaveBeenCalledWith(draftCard, sampleMetrics, { fakeLlm: true })

      expect(responses).toHaveLength(1)
      const [response] = responses
      expect(response.visible).toBe(true)
      expect(response.responseKind).toBe('curatedVibesSummary')
      expect(response.renderData).toBe(verifiedCard)
      expect(response.channels).toEqual([adminChannel])
    })

    it('throws AccessDeniedError and reads no metrics when the event is on a private topic', async () => {
      mockStoppedConversation(true)
      const computeSpy = jest.spyOn(conversationAnalyticsService, 'computeConversationMetrics')

      await expect(
        vibesAnalyst.onConversationEvent.call(buildContext(), {
          type: 'conversationStopped',
          conversationId: 'c1',
          topicId: 't1'
        })
      ).rejects.toThrow(AccessDeniedError)
      expect(computeSpy).not.toHaveBeenCalled()
      // Access is checked before any work, so no snapshot fetch on a private event.
      expect(mockFetchAndStoreSnapshot).not.toHaveBeenCalled()
    })
  })
})
