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
// Spike annotation is exercised in spikeAnnotation tests; here we only check the
// agent reads the allowed messages and feeds the annotated spikes to the curator.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAnnotateSpikes = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLoadReadableMessages = jest.fn<(...args: any[]) => Promise<any>>()
// Reception annotation is exercised in quoteReception tests; here we only check the
// agent feeds the allowed messages and poster count in, and the receptions to the curator.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAnnotateReceptions = jest.fn<(...args: any[]) => Promise<any>>()
// Snapshot persistence is exercised in conversationMetricsSnapshot.service.test.ts; here we only
// check the agent persists the computed metrics on the stop path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPersistSnapshot = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/vibesAnalyst/curate.js', () => ({
  default: mockCurate
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/verifyCuration.js', () => ({
  default: mockVerify
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/spikeAnnotation.js', () => ({
  default: mockAnnotateSpikes
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/quoteReception.js', () => ({
  default: mockAnnotateReceptions
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/capabilities.js', () => ({
  default: () => ({ read: [], write: [] }),
  loadReadableMessages: mockLoadReadableMessages
}))
// Mocking a module replaces every export, so each one another module in the import graph reads
// has to be declared here: imageGenerator.ts pulls getGoogleImageModel, the agent model pulls
// llmPlatforms, and the suite fails to load without them.
jest.unstable_mockModule('../src/agents/helpers/getModelChat.js', () => ({
  getModelChat: mockGetModelChat,
  getOpenAIChat: jest.fn(),
  getGoogleChat: jest.fn(),
  getGoogleImageModel: jest.fn(),
  getVllmChat: jest.fn(),
  getOllamaChat: jest.fn(),
  getPerspectiveChat: jest.fn(),
  getBedrockChat: jest.fn(),
  supportedModels: [],
  llmPlatforms: [],
  defaultLLMPlatform: 'bedrock',
  defaultLLMModel: 'test-model',
  classificationLLMPlatform: 'bedrock',
  classificationLLMModel: 'fast-model',
  coreLLMPlatform: 'bedrock',
  coreLLMModel: 'core-model',
  imageGenerationLLMModel: 'image-model'
}))
// The agent model imports the whole agent registry, which imports this agent back, so loading
// the analyst on its own lands in a half-initialized module. Nothing here touches the model, so
// stubbing it breaks the cycle and lets the suite load.
jest.unstable_mockModule('../src/models/user.model/agent.model/index.js', () => ({
  default: {},
  setAgentTypes: jest.fn()
}))
jest.unstable_mockModule('../src/services/analyticsSources/index.js', () => ({
  default: { fetchAndStoreSnapshot: mockFetchAndStoreSnapshot }
}))
jest.unstable_mockModule('../src/services/conversationMetricsSnapshot.service.js', () => ({
  default: { persistSnapshot: mockPersistSnapshot },
  // eventResolution imports this named export (for the trend live-recompute path); it is not
  // exercised here, but the mock must provide it or the module load fails.
  buildSnapshotPayload: jest.fn()
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
      participation: { posterCount: 5, frequentPosterCount: 1, frequentPosterMessageShare: 0.4, messageCount: 20 },
      spikes: []
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

    /* A conversation whose topic did not populate (e.g. it was deleted between
       dispatch and this job running). The read-site re-check must fail closed and
       treat the unknown privacy as private. */
    function mockStoppedConversationWithMissingTopic() {
      jest.spyOn(Conversation, 'findById').mockReturnValue({
        populate: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          _id: 'c1',
          name: 'The Future of Work',
          startTime: new Date('2026-06-10T10:00:00.000Z'),
          endTime: new Date('2026-06-10T11:00:00.000Z'),
          topic: undefined
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    }

    beforeEach(() => {
      jest.restoreAllMocks()
      mockCurate.mockReset()
      mockVerify.mockReset()
      mockGetModelChat.mockReset()
      // Route by model so the test can prove which pass runs on which model: the main
      // Opus-tier model for curate and verify, the faster classification model for the
      // mechanical spike and reception annotation.
      mockGetModelChat.mockImplementation((_platform, model) =>
        Promise.resolve(model === 'fast-model' ? { fastLlm: true } : { fakeLlm: true })
      )
      mockFetchAndStoreSnapshot.mockReset()
      mockFetchAndStoreSnapshot.mockResolvedValue(undefined)
      mockLoadReadableMessages.mockReset()
      mockLoadReadableMessages.mockResolvedValue([])
      mockAnnotateSpikes.mockReset()
      // By default, pass the spikes straight through so the wiring is transparent.
      mockAnnotateSpikes.mockImplementation((_messages, _start, spikes) => Promise.resolve(spikes))
      mockAnnotateReceptions.mockReset()
      mockAnnotateReceptions.mockResolvedValue([])
      mockPersistSnapshot.mockReset()
      mockPersistSnapshot.mockResolvedValue(undefined)
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

      // The event ran one hour, so the card's footer duration is 60 minutes. The fixture has no
      // presenters and no other agents installed, so the scene-setting fields come back empty.
      expect(mockCurate).toHaveBeenCalledWith(
        sampleMetrics,
        { eventName: 'The Future of Work', durationMinutes: 60, speakerCount: 0, activeAgentTypeLabels: [] },
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

    it('persists the computed metrics as a snapshot for the ended event', async () => {
      mockStoppedConversation(false)
      jest
        .spyOn(conversationAnalyticsService, 'computeConversationMetrics')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue(sampleMetrics as any)
      mockCurate.mockResolvedValue({ header: 'Draft', standouts: [], durationMinutes: 60 })
      mockVerify.mockResolvedValue(verifiedCard)

      await vibesAnalyst.onConversationEvent.call(buildContext(), {
        type: 'conversationStopped',
        conversationId: 'c1',
        topicId: 't1'
      })

      // The snapshot is written from the enriched metrics the card was built from, keyed by
      // the ended conversation.
      expect(mockPersistSnapshot).toHaveBeenCalledWith(expect.objectContaining({ _id: 'c1' }), sampleMetrics)
    })

    it('still posts the card when the snapshot write fails', async () => {
      mockStoppedConversation(false)
      jest
        .spyOn(conversationAnalyticsService, 'computeConversationMetrics')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue(sampleMetrics as any)
      mockCurate.mockResolvedValue({ header: 'Draft', standouts: [], durationMinutes: 60 })
      mockVerify.mockResolvedValue(verifiedCard)
      mockPersistSnapshot.mockRejectedValue(new Error('mongo down'))

      const responses = await vibesAnalyst.onConversationEvent.call(buildContext(), {
        type: 'conversationStopped',
        conversationId: 'c1',
        topicId: 't1'
      })

      // A snapshot failure is best-effort: it is logged and swallowed, never blocking the card.
      expect(responses).toHaveLength(1)
      expect(responses[0].renderData).toBe(verifiedCard)
    })

    it('annotates spikes from the allowed messages before curating, when the event had spikes', async () => {
      mockStoppedConversation(false)
      const rawSpike = { label: '20-30', startMinute: 20, endMinute: 30, messageCount: 8, baselineAverage: 1, ratio: 8 }
      const spikeMetrics = { participation: { posterCount: 5 }, spikes: [rawSpike] }
      jest
        .spyOn(conversationAnalyticsService, 'computeConversationMetrics')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue(spikeMetrics as any)

      const readableMessages = [{ body: 'remote work is banned now?', createdAt: new Date('2026-06-10T10:21:00.000Z') }]
      mockLoadReadableMessages.mockResolvedValue(readableMessages)
      const annotatedSpikes = [
        { ...rawSpike, annotation: { topic: 'remote work policy', quote: 'remote work is banned now?' } }
      ]
      mockAnnotateSpikes.mockResolvedValue(annotatedSpikes)
      mockCurate.mockResolvedValue({ header: 'Draft', standouts: [], durationMinutes: 60 })
      mockVerify.mockResolvedValue(verifiedCard)

      await vibesAnalyst.onConversationEvent.call(buildContext(), {
        type: 'conversationStopped',
        conversationId: 'c1',
        topicId: 't1'
      })

      // Reads only the allowed messages for this conversation, then hands them and the
      // raw spikes to the annotator with the event start.
      expect(mockLoadReadableMessages).toHaveBeenCalledWith('c1')
      // The annotation runs on the faster classification model, not the main Opus model.
      expect(mockAnnotateSpikes).toHaveBeenCalledWith(readableMessages, expect.any(Date), [rawSpike], { fastLlm: true })
      // The curator sees the annotated spikes, not the bare ones.
      expect(mockCurate).toHaveBeenCalledWith(expect.objectContaining({ spikes: annotatedSpikes }), expect.anything(), {
        fakeLlm: true
      })
    })

    it('annotates receptions from the allowed messages before curating', async () => {
      mockStoppedConversation(false)
      const receptionMetrics = { participation: { posterCount: 12 }, spikes: [] }
      jest
        .spyOn(conversationAnalyticsService, 'computeConversationMetrics')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue(receptionMetrics as any)

      const readableMessages = [
        {
          body: 'we should ban gas stoves entirely',
          channels: ['transcript'],
          createdAt: new Date('2026-06-10T10:05:00.000Z')
        }
      ]
      mockLoadReadableMessages.mockResolvedValue(readableMessages)
      const receptions = [
        { sparkQuote: 'ban gas stoves', reactionVolume: 7, reactionQuote: 'no way', sentiment: 'pushback' }
      ]
      mockAnnotateReceptions.mockResolvedValue(receptions)
      mockCurate.mockResolvedValue({ header: 'Draft', standouts: [], durationMinutes: 60 })
      mockVerify.mockResolvedValue(verifiedCard)

      await vibesAnalyst.onConversationEvent.call(buildContext(), {
        type: 'conversationStopped',
        conversationId: 'c1',
        topicId: 't1'
      })

      // Reads the allowed messages once and hands them, with the poster count, to the annotator.
      expect(mockLoadReadableMessages).toHaveBeenCalledWith('c1')
      // Reception annotation also runs on the faster classification model.
      expect(mockAnnotateReceptions).toHaveBeenCalledWith(readableMessages, 12, { fastLlm: true })
      // The curator sees the receptions the annotator produced.
      expect(mockCurate).toHaveBeenCalledWith(expect.objectContaining({ receptions }), expect.anything(), { fakeLlm: true })
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
      // And nothing is persisted for an event the analyst may not read.
      expect(mockPersistSnapshot).not.toHaveBeenCalled()
    })

    it('throws AccessDeniedError and reads no metrics when the topic did not populate', async () => {
      mockStoppedConversationWithMissingTopic()
      const computeSpy = jest.spyOn(conversationAnalyticsService, 'computeConversationMetrics')

      await expect(
        vibesAnalyst.onConversationEvent.call(buildContext(), {
          type: 'conversationStopped',
          conversationId: 'c1',
          topicId: 't1'
        })
      ).rejects.toThrow(AccessDeniedError)
      expect(computeSpy).not.toHaveBeenCalled()
      expect(mockFetchAndStoreSnapshot).not.toHaveBeenCalled()
    })
  })
})
