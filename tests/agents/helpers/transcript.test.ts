/* eslint-disable @typescript-eslint/no-explicit-any */
import transcript, { TOPIC_TRANSCRIPT_COLLECTION_PREFIX } from '../../../src/agents/helpers/transcript.js'
import rag, { TRANSCRIPT_COLLECTION_PREFIX } from '../../../src/agents/helpers/rag.js'
import Conversation from '../../../src/models/conversation.model.js'
import Message from '../../../src/models/message.model.js'
import { getTranscriptHistoryChannelNames } from '../../../src/agents/helpers/agentChannels.js'

const { searchTranscript, loadTranscriptIntoVectorStore } = transcript

describe('transcript', () => {
  describe('embeddingsModelName selection', () => {
    let ragGetContextChunksSpy
    let ragAddToVectorStoreSpy

    beforeEach(() => {
      ragGetContextChunksSpy = jest
        .spyOn(rag, 'getContextChunksForQuestion')
        .mockResolvedValue({ chunks: '', retrievedDocs: [] })
      ragAddToVectorStoreSpy = jest.spyOn(rag, 'addTextsToVectorStore').mockResolvedValue()
      jest.clearAllMocks()
    })

    afterEach(() => {
      ragGetContextChunksSpy.mockRestore()
      ragAddToVectorStoreSpy.mockRestore()
    })

    it('should use embeddingsPlatform and embeddingsModelName from conversation.transcript.vectorStore in searchTranscript', async () => {
      const mockConversation = {
        _id: 'conv1',
        startTime: new Date(),
        transcript: {
          vectorStore: {
            embeddingsPlatform: 'openai',
            embeddingsModelName: 'custom-embedding-model'
          }
        }
      }
      await searchTranscript({ conversation: mockConversation }, 'test question')
      expect(ragGetContextChunksSpy).toHaveBeenCalledWith(
        'event-transcript-conv1',
        'test question',
        undefined,
        undefined,
        10,
        'openai',
        'custom-embedding-model',
        0.8
      )
    })

    it('should use only embeddingsModelName if embeddingsPlatform is not set in searchTranscript', async () => {
      const mockConversation = {
        _id: 'conv1b',
        startTime: new Date(),
        transcript: {
          vectorStore: {
            embeddingsModelName: 'custom-embedding-model'
          }
        }
      }
      await searchTranscript({ conversation: mockConversation }, 'test question')
      expect(ragGetContextChunksSpy).toHaveBeenCalledWith(
        'event-transcript-conv1b',
        'test question',
        undefined,
        undefined,
        10,
        undefined,
        'custom-embedding-model',
        0.8
      )
    })

    it('should use only embeddingsPlatform if embeddingsModelName is not set in searchTranscript', async () => {
      const mockConversation = {
        _id: 'conv1c',
        startTime: new Date(),
        transcript: {
          vectorStore: {
            embeddingsPlatform: 'openai'
          }
        }
      }
      await searchTranscript({ conversation: mockConversation }, 'test question')
      expect(ragGetContextChunksSpy).toHaveBeenCalledWith(
        'event-transcript-conv1c',
        'test question',
        undefined,
        undefined,
        10,
        'openai',
        undefined,
        0.8
      )
    })

    it('should use undefined embeddingsPlatform and embeddingsModelName if not set in searchTranscript (fallback to config default)', async () => {
      const mockConversation = {
        _id: 'conv2',
        startTime: new Date()
      }
      await searchTranscript({ conversation: mockConversation }, 'test question')
      expect(ragGetContextChunksSpy).toHaveBeenCalledWith(
        'event-transcript-conv2',
        'test question',
        undefined,
        undefined,
        10,
        undefined,
        undefined,
        0.8
      )
    })

    it('should use embeddingsPlatform and embeddingsModelName from conversation.transcript.vectorStore in loadTranscriptIntoVectorStore', async () => {
      // Patch Conversation.findById to return a mock with transcript.vectorStore.embeddingsPlatform and embeddingsModelName
      jest.spyOn(Conversation, 'findById').mockReturnValue({
        select() {
          return {
            lean: async () => ({
              transcript: {
                vectorStore: {
                  embeddingsPlatform: 'openai',
                  embeddingsModelName: 'custom-embedding-model'
                }
              }
            })
          }
        }
      })

      const mockMessages = [{ createdAt: new Date(), body: 'msg', pseudonym: 'A', channels: ['transcript'] }]
      await loadTranscriptIntoVectorStore(mockMessages, 'conv3')
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        'event-transcript-conv3',
        expect.any(Array),
        expect.objectContaining({
          metadataFn: expect.any(Function),
          embeddingsPlatform: 'openai',
          embeddingsModelName: 'custom-embedding-model'
        })
      )
    })

    it('should use only embeddingsModelName if embeddingsPlatform is not set in loadTranscriptIntoVectorStore', async () => {
      jest.spyOn(Conversation, 'findById').mockReturnValue({
        select() {
          return {
            lean: async () => ({
              transcript: {
                vectorStore: {
                  embeddingsModelName: 'custom-embedding-model'
                }
              }
            })
          }
        }
      })

      const mockMessages = [{ createdAt: new Date(), body: 'msg', pseudonym: 'A', channels: ['transcript'] }]
      await loadTranscriptIntoVectorStore(mockMessages, 'conv3b')
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        'event-transcript-conv3b',
        expect.any(Array),
        expect.objectContaining({
          metadataFn: expect.any(Function),
          embeddingsPlatform: undefined,
          embeddingsModelName: 'custom-embedding-model'
        })
      )
    })

    it('should use only embeddingsPlatform if embeddingsModelName is not set in loadTranscriptIntoVectorStore', async () => {
      jest.spyOn(Conversation, 'findById').mockReturnValue({
        select() {
          return {
            lean: async () => ({
              transcript: {
                vectorStore: {
                  embeddingsPlatform: 'openai'
                }
              }
            })
          }
        }
      })

      const mockMessages = [{ createdAt: new Date(), body: 'msg', pseudonym: 'A', channels: ['transcript'] }]
      await loadTranscriptIntoVectorStore(mockMessages, 'conv3c')
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        'event-transcript-conv3c',
        expect.any(Array),
        expect.objectContaining({
          metadataFn: expect.any(Function),
          embeddingsPlatform: 'openai',
          embeddingsModelName: undefined
        })
      )
    })

    it('should use undefined embeddingsPlatform and embeddingsModelName if not set in loadTranscriptIntoVectorStore (fallback to config default)', async () => {
      // Patch Conversation.findById to return a mock with no transcript.vectorStore
      jest.spyOn(Conversation, 'findById').mockReturnValue({
        select() {
          return {
            lean: async () => ({})
          }
        }
      })

      const mockMessages = [{ createdAt: new Date(), body: 'msg', pseudonym: 'A', channels: ['transcript'] }]
      await loadTranscriptIntoVectorStore(mockMessages, 'conv4')
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        'event-transcript-conv4',
        expect.any(Array),
        expect.objectContaining({
          metadataFn: expect.any(Function),
          embeddingsPlatform: undefined,
          embeddingsModelName: undefined
        })
      )
    })
  })

  let ragGetContextChunksSpy
  let ragAddToVectorStoreSpy
  let ragRemoveFromVectorStoreSpy
  const localHour = new Date('2024-01-15T10:00:00Z').getHours()
  const utcHour = new Date('2024-01-15T10:00:00Z').getUTCHours()

  beforeEach(() => {
    // Create spies on the rag module methods
    ragGetContextChunksSpy = jest.spyOn(rag, 'getContextChunksForQuestion')
    ragAddToVectorStoreSpy = jest.spyOn(rag, 'addTextsToVectorStore')
    ragRemoveFromVectorStoreSpy = jest.spyOn(rag, 'removeFromVectorStore')
    // Clear all mocks
    jest.clearAllMocks()
  })

  afterEach(() => {
    // Restore original implementations
    ragGetContextChunksSpy.mockRestore()
    ragAddToVectorStoreSpy.mockRestore()
    ragRemoveFromVectorStoreSpy.mockRestore()
  })

  describe('searchTranscript', () => {
    let mockAgent

    const mockChunks = [
      { content: 'Discussion about project timeline', metadata: { start: '2024-01-15T10:05:00Z' } },
      { content: 'Budget considerations for the project', metadata: { start: '2024-01-15T10:10:00Z' } }
    ]

    beforeEach(() => {
      mockAgent = {
        conversation: {
          _id: 'conversation123',
          startTime: new Date('2024-01-15T10:00:00Z')
        }
      }
      ragGetContextChunksSpy.mockResolvedValue({ chunks: mockChunks })
    })

    it('should search transcript without time query', async () => {
      const question = 'What was discussed about the project?'
      const result = await transcript.searchTranscript(mockAgent, question)
      expect(ragGetContextChunksSpy).toHaveBeenCalledWith(
        'event-transcript-conversation123',
        question,
        undefined,
        undefined,
        10,
        undefined,
        undefined,
        0.8
      )
      expect(result.chunks).toEqual(mockChunks)
      expect(result.timeWindow).toBe(false)
    })

    it('should search transcript with relative time query', async () => {
      const testStartTime = Date.now()
      mockAgent.conversation.messages = [
        {
          createdAt: new Date(testStartTime - 289 * 1000),
          body: 'Test message',
          pseudonym: 'Joe',
          channels: ['transcript']
        },
        {
          createdAt: new Date(testStartTime - 302 * 1000),
          body: 'Test older message',
          pseudonym: 'Bob',
          channels: ['transcript']
        },
        {
          createdAt: new Date(testStartTime - 100 * 1000),
          body: 'Different message',
          pseudonym: 'Frank',
          channels: ['transcript']
        },
        {
          createdAt: new Date(testStartTime - 100 * 1000),
          body: 'Some message',
          pseudonym: 'Frank'
        }
      ]
      const result = await transcript.searchTranscript(
        mockAgent,
        'What was discussed about the project in the last 5 minutes?'
      )
      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      // Make sure message not in transcript channel is excluded
      expect(result.chunks).not.toEqual(expect.stringContaining('Some message'))
      expect(result.timeWindow).toBe(true)
    })

    it('should search transcript with time query relative to the beginning', async () => {
      mockAgent.conversation.messages = [
        {
          createdAt: new Date(mockAgent.conversation.startTime.getTime() + 120 * 1000),
          body: 'Test message',
          pseudonym: 'Joe',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockAgent.conversation.startTime.getTime() + 600 * 1000),
          body: 'Test older message',
          pseudonym: 'Bob',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockAgent.conversation.startTime.getTime() + 300 * 1000),
          body: 'Different message',
          pseudonym: 'Frank',
          channels: ['transcript']
        }
      ]

      const result = await transcript.searchTranscript(
        mockAgent,
        'What was discussed about the project in the first 5 minutes?'
      )

      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      expect(result.timeWindow).toBe(true)
    })

    it('should search transcript with absolute time query', async () => {
      mockAgent.conversation.messages = [
        {
          createdAt: new Date(mockAgent.conversation.startTime.getTime() + 32 * 60 * 1000),
          body: 'Test message',
          pseudonym: 'Joe',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockAgent.conversation.startTime.getTime() + 15 * 60 * 1000),
          body: 'Test older message',
          pseudonym: 'Bob',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockAgent.conversation.startTime.getTime() + 29 * 60 * 1000),
          body: 'Different message',
          pseudonym: 'Frank',
          channels: ['transcript']
        }
      ]
      const result = await transcript.searchTranscript(mockAgent, `What happened at ${localHour}:30?`)

      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      expect(result.timeWindow).toBe(true)
    })

    it('should search transcript with range time query', async () => {
      mockAgent.conversation.messages = [
        {
          createdAt: new Date(mockAgent.conversation.startTime.getTime() + 32 * 60 * 1000),
          body: 'Test message',
          pseudonym: 'Joe',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockAgent.conversation.startTime.getTime() + 10 * 60 * 1000),
          body: 'Test older message',
          pseudonym: 'Bob',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockAgent.conversation.startTime.getTime() + 29 * 60 * 1000),
          body: 'Different message',
          pseudonym: 'Frank',
          channels: ['transcript']
        }
      ]
      const result = await transcript.searchTranscript(
        mockAgent,
        `What happened between ${localHour}:15 and ${localHour}:45?`
      )

      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      expect(result.timeWindow).toBe(true)
    })

    describe('endTime filtering', () => {
      it('should pass endTime filter to RAG when provided without time query', async () => {
        const question = 'What was discussed about the project?'
        const endTime = new Date('2024-01-15T10:30:00Z')

        await transcript.searchTranscript(mockAgent, question, endTime)

        expect(ragGetContextChunksSpy).toHaveBeenCalledWith(
          'event-transcript-conversation123',
          question,
          undefined,
          {
            $or: [{ start: { $lte: endTime.getTime() } }, { type: { $in: ['event', 'presenter', 'moderator'] } }]
          },
          10,
          undefined,
          undefined,
          0.8
        )
      })

      it('should not pass filter to RAG when endTime is not provided', async () => {
        const question = 'What was discussed about the project?'

        await transcript.searchTranscript(mockAgent, question)

        expect(ragGetContextChunksSpy).toHaveBeenCalledWith(
          'event-transcript-conversation123',
          question,
          undefined,
          undefined,
          10,
          undefined,
          undefined,
          0.8
        )
      })

      it('should filter messages by endTime when using relative time query', async () => {
        const testStartTime = Date.now()
        const endTime = new Date(testStartTime - 200 * 1000) // 200 seconds ago

        mockAgent.conversation.messages = [
          {
            createdAt: new Date(testStartTime - 150 * 1000), // After endTime - should be excluded
            body: 'Message after endTime',
            pseudonym: 'Alice',
            channels: ['transcript']
          },
          {
            createdAt: new Date(testStartTime - 250 * 1000), // Before endTime - should be included
            body: 'Message before endTime',
            pseudonym: 'Bob',
            channels: ['transcript']
          },
          {
            createdAt: new Date(testStartTime - 290 * 1000), // Before endTime - should be included
            body: 'Earlier message',
            pseudonym: 'Charlie',
            channels: ['transcript']
          },
          {
            createdAt: new Date(endTime.getTime() - 350 * 1000), // Too old for 5-minute window - should be excluded
            body: 'Too old message',
            pseudonym: 'Dave',
            channels: ['transcript']
          }
        ]

        const result = await transcript.searchTranscript(
          mockAgent,
          'What was discussed in the last 5 minutes?',
          endTime
        )

        expect(result.chunks).toEqual(expect.stringContaining('Message before endTime'))
        expect(result.chunks).toEqual(expect.stringContaining('Earlier message'))
        expect(result.chunks).not.toEqual(expect.stringContaining('Message after endTime'))
        expect(result.chunks).not.toEqual(expect.stringContaining('Too old message'))
        expect(result.timeWindow).toBe(true)
      })

      it('should ignore endTime when using absolute time query', async () => {
        const endTime = new Date(mockAgent.conversation.startTime.getTime() + 25 * 60 * 1000) // 25 minutes after start

        mockAgent.conversation.messages = [
          {
            createdAt: new Date(mockAgent.conversation.startTime.getTime() + 32 * 60 * 1000),
            body: 'Test message',
            pseudonym: 'Joe',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockAgent.conversation.startTime.getTime() + 15 * 60 * 1000),
            body: 'Test older message',
            pseudonym: 'Bob',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockAgent.conversation.startTime.getTime() + 29 * 60 * 1000),
            body: 'Different message',
            pseudonym: 'Frank',
            channels: ['transcript']
          }
        ]
        const result = await transcript.searchTranscript(mockAgent, `What happened at ${localHour}:30?`, endTime)

        expect(result.chunks).toEqual(expect.stringContaining('Test message'))
        expect(result.chunks).toEqual(expect.stringContaining('Different message'))
        expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
        expect(result.timeWindow).toBe(true)
      })

      it('should ignore endTime when using range time query', async () => {
        const endTime = new Date(mockAgent.conversation.startTime.getTime() + 35 * 60 * 1000) // 35 minutes after start

        mockAgent.conversation.messages = [
          {
            createdAt: new Date(mockAgent.conversation.startTime.getTime() + 40 * 60 * 1000), // After endTime
            body: 'Message after endTime',
            pseudonym: 'Alice',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockAgent.conversation.startTime.getTime() + 30 * 60 * 1000), // Within range and before endTime
            body: 'Valid message 1',
            pseudonym: 'Bob',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockAgent.conversation.startTime.getTime() + 20 * 60 * 1000), // Within range and before endTime
            body: 'Valid message 2',
            pseudonym: 'Charlie',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockAgent.conversation.startTime.getTime() + 10 * 60 * 1000), // Outside range (too early)
            body: 'Too early message',
            pseudonym: 'Dave',
            channels: ['transcript']
          }
        ]

        const result = await transcript.searchTranscript(
          mockAgent,
          `What happened between ${localHour}:15 and ${localHour}:45?`,
          endTime
        )

        expect(result.chunks).toEqual(expect.stringContaining('Valid message 1'))
        expect(result.chunks).toEqual(expect.stringContaining('Valid message 2'))
        expect(result.chunks).toEqual(expect.stringContaining('Message after endTime'))
        expect(result.chunks).not.toEqual(expect.stringContaining('Too early message'))
        expect(result.timeWindow).toBe(true)
      })

      it('should handle endTime that is before all messages in time query', async () => {
        const endTime = new Date(mockAgent.conversation.startTime.getTime() + 5 * 60 * 1000) // 5 minutes after start

        mockAgent.conversation.messages = [
          {
            createdAt: new Date(mockAgent.conversation.startTime.getTime() + 32 * 60 * 1000), // After endTime
            body: 'Message after endTime',
            pseudonym: 'Alice',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockAgent.conversation.startTime.getTime() + 29 * 60 * 1000), // After endTime
            body: 'Another message after endTime',
            pseudonym: 'Bob',
            channels: ['transcript']
          }
        ]

        const result = await transcript.searchTranscript(
          mockAgent,
          'What was discussed about the project in the last 5 minutes?',
          endTime
        )

        expect(result.chunks).toBe('')
        expect(result.timeWindow).toBe(true)
      })

      it('should handle endTime with first/last relative queries correctly', async () => {
        const testStartTime = Date.now()
        const endTime = new Date(testStartTime - 100 * 1000) // 100 seconds ago

        mockAgent.conversation.messages = [
          {
            createdAt: new Date(mockAgent.conversation.startTime.getTime() + 2 * 60 * 1000), // Within first 5 minutes
            body: 'Early valid message',
            pseudonym: 'Alice',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockAgent.conversation.startTime.getTime() + 4 * 60 * 1000), // Within first 5 minutes
            body: 'Another early message',
            pseudonym: 'Bob',
            channels: ['transcript']
          },
          {
            createdAt: new Date(testStartTime - 50 * 1000), // After endTime but would be in "first" window
            body: 'Message after endTime',
            pseudonym: 'Charlie',
            channels: ['transcript']
          }
        ]

        const result = await transcript.searchTranscript(
          mockAgent,
          'What was discussed in the first 5 minutes?',
          endTime
        )

        expect(result.chunks).toEqual(expect.stringContaining('Early valid message'))
        expect(result.chunks).toEqual(expect.stringContaining('Another early message'))
        expect(result.chunks).not.toEqual(expect.stringContaining('Message after endTime'))
        expect(result.timeWindow).toBe(true)
      })

      it('should preserve original behavior when endTime is null or undefined', async () => {
        const question = 'What was discussed about the project?'

        // Test with null
        await transcript.searchTranscript(mockAgent, question, null)
        expect(ragGetContextChunksSpy).toHaveBeenCalledWith(
          'event-transcript-conversation123',
          question,
          undefined,
          undefined,
          10,
          undefined,
          undefined,
          0.8
        )

        // Test with undefined
        jest.clearAllMocks()
        await transcript.searchTranscript(mockAgent, question, undefined)
        expect(ragGetContextChunksSpy).toHaveBeenCalledWith(
          'event-transcript-conversation123',
          question,
          undefined,
          undefined,
          10,
          undefined,
          undefined,
          0.8
        )
      })
    })
  })

  describe('loadTranscriptIntoVectorStore', () => {
    const mockConversationId = 'conversation456'
    const mockMessages = [
      {
        createdAt: new Date('2024-01-15T10:05:30Z'),
        body: 'Hello everyone',
        pseudonym: 'John',
        channels: ['transcript']
      },
      {
        createdAt: new Date('2024-01-15T10:06:15Z'),
        body: "Let's start the meeting",
        pseudonym: 'Jane',
        channels: ['transcript']
      },
      {
        createdAt: new Date('2024-01-15T10:07:00Z'),
        body: 'First item on the agenda',
        pseudonym: 'John',
        channels: ['transcript']
      }
    ]
    const mockFormattedTranscript = `[${utcHour}:05:30 AM] Hello everyone
[${utcHour}:06:15 AM] Let's start the meeting
[${utcHour}:07:00 AM] First item on the agenda`

    beforeEach(() => {
      ragAddToVectorStoreSpy.mockResolvedValue()
    })

    it('should load transcript into per-conversation vector store with proper metadata', async () => {
      jest.spyOn(Conversation, 'findById').mockReturnValue({
        select() {
          return { lean: async () => ({ name: 'Test Conversation', topic: null, transcript: {} }) }
        }
      } as any)

      await transcript.loadTranscriptIntoVectorStore(mockMessages, mockConversationId)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        'event-transcript-conversation456',
        [mockFormattedTranscript],
        expect.objectContaining({
          metadataFn: expect.any(Function),
          embeddingsPlatform: undefined,
          embeddingsModelName: undefined
        })
      )
      const { metadataFn } = ragAddToVectorStoreSpy.mock.calls[0][2]
      const mockDoc = { pageContent: mockFormattedTranscript } as {
        pageContent: string
        metadata?: Record<string, unknown>
      }
      const newDoc = metadataFn(mockDoc)
      expect(newDoc.metadata!).toEqual({
        start: new Date('2024-01-15T10:05:30Z').getTime(),
        end: new Date('2024-01-15T10:07:00Z').getTime(),
        type: 'transcript',
        conversationId: 'conversation456',
        conversationName: 'Test Conversation'
      })
    })

    it('should also write to topic collection when conversation belongs to a topic', async () => {
      jest.spyOn(Conversation, 'findById').mockReturnValue({
        select() {
          return { lean: async () => ({ name: 'Test Conversation', topic: 'topic789', transcript: {} }) }
        }
      } as any)

      await transcript.loadTranscriptIntoVectorStore(mockMessages, mockConversationId)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledTimes(2)
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        'event-transcript-conversation456',
        [mockFormattedTranscript],
        expect.objectContaining({ metadataFn: expect.any(Function) })
      )
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-topic789`,
        [mockFormattedTranscript],
        expect.objectContaining({ metadataFn: expect.any(Function) })
      )
    })

    it('should use per-conversation embeddings for per-conv collection but default embeddings for topic collection', async () => {
      jest.spyOn(Conversation, 'findById').mockReturnValue({
        select() {
          return {
            lean: async () => ({
              name: 'Test Conversation',
              topic: 'topic789',
              transcript: { vectorStore: { embeddingsPlatform: 'openai', embeddingsModelName: 'text-embedding-3-large' } }
            })
          }
        }
      } as any)

      await transcript.loadTranscriptIntoVectorStore(mockMessages, mockConversationId)

      // Per-conversation collection gets custom embeddings
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        'event-transcript-conversation456',
        expect.any(Array),
        expect.objectContaining({ embeddingsPlatform: 'openai', embeddingsModelName: 'text-embedding-3-large' })
      )
      // Topic collection always uses default embeddings (no platform/model passed)
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-topic789`,
        expect.any(Array),
        expect.not.objectContaining({ embeddingsPlatform: expect.anything() })
      )
    })

    it('should not write to topic collection when conversation has no topic', async () => {
      jest.spyOn(Conversation, 'findById').mockReturnValue({
        select() {
          return { lean: async () => ({ name: 'Test Conversation', topic: null, transcript: {} }) }
        }
      } as any)

      await transcript.loadTranscriptIntoVectorStore(mockMessages, mockConversationId)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledTimes(1)
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        'event-transcript-conversation456',
        expect.any(Array),
        expect.any(Object)
      )
    })

    it('should handle empty messages array', async () => {
      await transcript.loadTranscriptIntoVectorStore([], mockConversationId)
      expect(ragAddToVectorStoreSpy).not.toHaveBeenCalled()
    })
  })

  describe('time conversion utilities', () => {
    const mockChunks = [
      { content: 'Discussion about project timeline', metadata: { start: '2024-01-15T10:05:00Z' } },
      { content: 'Budget considerations for the project', metadata: { start: '2024-01-15T10:10:00Z' } }
    ]
    beforeEach(() => {
      ragGetContextChunksSpy.mockResolvedValue({ chunks: mockChunks })
    })
    it('should handle 12-hour format time conversion correctly for PM start time', async () => {
      const startTime = new Date()
      startTime.setHours(14, 0, 0, 0) // set to 2:00 pm local time
      const mockAgent = {
        conversation: {
          _id: 'test',
          startTime,
          messages: [
            {
              createdAt: new Date(startTime.getTime() + 32 * 60 * 1000),
              body: 'Test message',
              pseudonym: 'Joe',
              channels: ['transcript']
            },
            {
              createdAt: new Date(startTime.getTime() + 10 * 60 * 1000),
              body: 'Test older message',
              pseudonym: 'Bob',
              channels: ['transcript']
            },
            {
              createdAt: new Date(startTime.getTime() + 29 * 60 * 1000),
              body: 'Different message',
              pseudonym: 'Frank',
              channels: ['transcript']
            }
          ]
        }
      }

      const result = await transcript.searchTranscript(mockAgent, `What happened at ${startTime.getHours()}:30?`)

      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      expect(result.timeWindow).toBe(true)
    })

    it('should handle 12-hour format time conversion correctly for AM start time', async () => {
      const startTime = new Date()
      startTime.setHours(8, 0, 0, 0) // set to 8:00 am local time
      const mockAgent = {
        conversation: {
          _id: 'test',
          startTime,
          messages: [
            {
              createdAt: new Date(startTime.getTime() + 17 * 60 * 1000),
              body: 'Test message',
              pseudonym: 'Joe',
              channels: ['transcript']
            },
            {
              createdAt: new Date(startTime.getTime() + 10 * 60 * 1000),
              body: 'Test older message',
              pseudonym: 'Bob',
              channels: ['transcript']
            },
            {
              createdAt: new Date(startTime.getTime() + 14 * 60 * 1000),
              body: 'Different message',
              pseudonym: 'Frank',
              channels: ['transcript']
            }
          ]
        }
      }

      const result = await transcript.searchTranscript(mockAgent, `What happened at ${startTime.getHours()}:15?`)

      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      expect(result.timeWindow).toBe(true)
    })

    it('should handle 24-hour format time conversion correctly', async () => {
      const startTime = new Date()
      startTime.setHours(110, 0, 0, 0) // set to 15:00 local time
      const mockAgent = {
        conversation: {
          _id: 'test',
          startTime,
          messages: [
            {
              createdAt: new Date(startTime.getTime() + 21 * 60 * 1000),
              body: 'Test message',
              pseudonym: 'Joe',
              channels: ['transcript']
            },
            {
              createdAt: new Date(startTime.getTime() + 10 * 60 * 1000),
              body: 'Test older message',
              pseudonym: 'Bob',
              channels: ['transcript']
            },
            {
              createdAt: new Date(startTime.getTime() + 19 * 60 * 1000),
              body: 'Different message',
              pseudonym: 'Frank',
              channels: ['transcript']
            }
          ]
        }
      }

      const result = await transcript.searchTranscript(mockAgent, `What happened at ${startTime.getHours()}:20?`)

      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      expect(result.timeWindow).toBe(true)
    })
  })
  describe('loadEventMetadataIntoVectorStore', () => {
    const convId = 'test-conversation-id'
    const convName = 'Test Event'

    beforeEach(() => {
      ragAddToVectorStoreSpy.mockResolvedValue()
      ragRemoveFromVectorStoreSpy.mockResolvedValue()
    })

    it('should load all event metadata when all parameters provided', async () => {
      const conversation = {
        _id: convId,
        name: convName,
        description: 'This is a test event description about AI and machine learning.',
        presenters: [
          { name: 'Jane Doe', bio: 'Jane is a leading researcher in AI with 10 years of experience.' },
          { name: 'John Smith', bio: 'John specializes in machine learning applications.' }
        ],
        moderators: [{ name: 'Alice Johnson', bio: 'Alice has moderated tech panels for 5 years.' }]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalled()
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        [
          'Event: Test Event. This is a test event description about AI and machine learning.',
          'Jane Doe is a speaker, presenter, and panelist at this event. Jane is a leading researcher in AI with 10 years of experience.',
          'John Smith is a speaker, presenter, and panelist at this event. John specializes in machine learning applications.',
          'Alice Johnson is the moderator, facilitator, and host of this event. Alice has moderated tech panels for 5 years.'
        ],
        {
          metadatas: [
            { type: 'event', conversationId: convId, conversationName: convName },
            { type: 'presenter', presenterName: 'Jane Doe', conversationId: convId, conversationName: convName },
            { type: 'presenter', presenterName: 'John Smith', conversationId: convId, conversationName: convName },
            { type: 'moderator', moderatorName: 'Alice Johnson', conversationId: convId, conversationName: convName }
          ]
        }
      )
    })

    it('should include event name and description in event doc', async () => {
      const conversation = { _id: convId, name: convName, description: 'This is a test event description.' }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        ['Event: Test Event. This is a test event description.'],
        {
          metadatas: [{ type: 'event', conversationId: convId, conversationName: convName }]
        }
      )
    })

    it('should always write event name doc even with no description or presenters', async () => {
      const conversation = { _id: convId, name: convName }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalled()
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        ['Event: Test Event'],
        {
          metadatas: [{ type: 'event', conversationId: convId, conversationName: convName }]
        }
      )
    })

    it('should write event name doc plus presenters when only presenters provided', async () => {
      const conversation = {
        _id: convId,
        name: convName,
        presenters: [{ name: 'Jane Doe', bio: 'Jane is a leading researcher.' }]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        ['Event: Test Event', 'Jane Doe is a speaker, presenter, and panelist at this event. Jane is a leading researcher.'],
        {
          metadatas: [
            { type: 'event', conversationId: convId, conversationName: convName },
            { type: 'presenter', presenterName: 'Jane Doe', conversationId: convId, conversationName: convName }
          ]
        }
      )
    })

    it('should write event name doc plus moderators when only moderators provided', async () => {
      const conversation = {
        _id: convId,
        name: convName,
        moderators: [{ name: 'Alice Johnson', bio: 'Alice has moderated panels.' }]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        [
          'Event: Test Event',
          'Alice Johnson is the moderator, facilitator, and host of this event. Alice has moderated panels.'
        ],
        {
          metadatas: [
            { type: 'event', conversationId: convId, conversationName: convName },
            { type: 'moderator', moderatorName: 'Alice Johnson', conversationId: convId, conversationName: convName }
          ]
        }
      )
    })

    it('should handle presenters without bios', async () => {
      const conversation = {
        _id: convId,
        name: convName,
        presenters: [
          { name: 'Jane Doe', bio: null },
          { name: 'John Smith' } // no bio property
        ]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        [
          'Event: Test Event',
          'Jane Doe is a speaker, presenter, and panelist at this event. No bio provided.',
          'John Smith is a speaker, presenter, and panelist at this event. No bio provided.'
        ],
        {
          metadatas: [
            { type: 'event', conversationId: convId, conversationName: convName },
            { type: 'presenter', presenterName: 'Jane Doe', conversationId: convId, conversationName: convName },
            { type: 'presenter', presenterName: 'John Smith', conversationId: convId, conversationName: convName }
          ]
        }
      )
    })

    it('should handle moderators without bios', async () => {
      const conversation = {
        _id: convId,
        name: convName,
        moderators: [{ name: 'Alice Johnson', bio: '' }, { name: 'Bob Wilson' }]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        [
          'Event: Test Event',
          'Alice Johnson is the moderator, facilitator, and host of this event. No bio provided.',
          'Bob Wilson is the moderator, facilitator, and host of this event. No bio provided.'
        ],
        {
          metadatas: [
            { type: 'event', conversationId: convId, conversationName: convName },
            { type: 'moderator', moderatorName: 'Alice Johnson', conversationId: convId, conversationName: convName },
            { type: 'moderator', moderatorName: 'Bob Wilson', conversationId: convId, conversationName: convName }
          ]
        }
      )
    })

    it('should handle multiple presenters and moderators', async () => {
      const conversation = {
        _id: convId,
        name: convName,
        presenters: [
          { name: 'Presenter 1', bio: 'Bio 1' },
          { name: 'Presenter 2', bio: 'Bio 2' },
          { name: 'Presenter 3', bio: 'Bio 3' }
        ],
        moderators: [
          { name: 'Moderator 1', bio: 'Mod Bio 1' },
          { name: 'Moderator 2', bio: 'Mod Bio 2' }
        ]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        [
          'Event: Test Event',
          'Presenter 1 is a speaker, presenter, and panelist at this event. Bio 1',
          'Presenter 2 is a speaker, presenter, and panelist at this event. Bio 2',
          'Presenter 3 is a speaker, presenter, and panelist at this event. Bio 3',
          'Moderator 1 is the moderator, facilitator, and host of this event. Mod Bio 1',
          'Moderator 2 is the moderator, facilitator, and host of this event. Mod Bio 2'
        ],
        {
          metadatas: [
            { type: 'event', conversationId: convId, conversationName: convName },
            { type: 'presenter', presenterName: 'Presenter 1', conversationId: convId, conversationName: convName },
            { type: 'presenter', presenterName: 'Presenter 2', conversationId: convId, conversationName: convName },
            { type: 'presenter', presenterName: 'Presenter 3', conversationId: convId, conversationName: convName },
            { type: 'moderator', moderatorName: 'Moderator 1', conversationId: convId, conversationName: convName },
            { type: 'moderator', moderatorName: 'Moderator 2', conversationId: convId, conversationName: convName }
          ]
        }
      )
    })

    it('should also write to topic collection when conversation has a topic', async () => {
      const topicId = 'topic-abc'
      const conversation = {
        _id: convId,
        name: convName,
        topic: topicId,
        description: 'An event about AI.',
        presenters: [{ name: 'Jane Doe', bio: 'AI researcher.' }]
      }
      const expectedDocs = [
        'Event: Test Event. An event about AI.',
        'Jane Doe is a speaker, presenter, and panelist at this event. AI researcher.'
      ]
      const expectedMetadatas = [
        { type: 'event', conversationId: convId, conversationName: convName },
        { type: 'presenter', presenterName: 'Jane Doe', conversationId: convId, conversationName: convName }
      ]

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledTimes(2)
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(`${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`, expectedDocs, {
        metadatas: expectedMetadatas
      })
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(`${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`, expectedDocs, {
        metadatas: expectedMetadatas
      })
    })

    it('should remove stale metadata from topic collection using $and filter', async () => {
      const topicId = 'topic-abc'
      const conversation = { _id: convId, name: convName, topic: topicId }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalledWith(`${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`, {
        type: { $in: ['event', 'presenter', 'moderator'] }
      })
      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalledWith(`${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-${topicId}`, {
        $and: [{ conversationId: convId }, { type: { $in: ['event', 'presenter', 'moderator'] } }]
      })
    })

    it('should not write to topic collection when conversation has no topic', async () => {
      const conversation = { _id: convId, name: convName }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledTimes(1)
      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        expect.any(Array),
        expect.any(Object)
      )
    })

    it('should include "also known as" in presenter doc when alternateName is set', async () => {
      const conversation = {
        _id: convId,
        name: convName,
        presenters: [{ name: 'Jonathan Smith', bio: 'Climate researcher.', alternateName: 'Jon' }]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        expect.arrayContaining([
          'Jonathan Smith (also known as "Jon") is a speaker, presenter, and panelist at this event. Climate researcher.'
        ]),
        expect.any(Object)
      )
    })

    it('should omit "also known as" in presenter doc when alternateName is absent', async () => {
      const conversation = {
        _id: convId,
        name: convName,
        presenters: [{ name: 'Jonathan Smith', bio: 'Climate researcher.' }]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        expect.arrayContaining([
          'Jonathan Smith is a speaker, presenter, and panelist at this event. Climate researcher.'
        ]),
        expect.any(Object)
      )
    })

    it('should include "also known as" in moderator doc when alternateName is set', async () => {
      const conversation = {
        _id: convId,
        name: convName,
        moderators: [{ name: 'Saoirse Ó Briain', bio: 'Senior editor.', alternateName: 'Sorsha O\'Brien' }]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        expect.arrayContaining([
          'Saoirse Ó Briain (also known as "Sorsha O\'Brien") is the moderator, facilitator, and host of this event. Senior editor.'
        ]),
        expect.any(Object)
      )
    })

    it('should omit "also known as" in moderator doc when alternateName is absent', async () => {
      const conversation = {
        _id: convId,
        name: convName,
        moderators: [{ name: 'Saoirse Ó Briain', bio: 'Senior editor.' }]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${convId}`,
        expect.arrayContaining([
          'Saoirse Ó Briain is the moderator, facilitator, and host of this event. Senior editor.'
        ]),
        expect.any(Object)
      )
    })
  })

  describe('clearTranscript', () => {
    let ragDeleteCollectionSpy
    let messageFindSpy
    let messageDeleteManySpy

    beforeEach(() => {
      ragDeleteCollectionSpy = jest.spyOn(rag, 'deleteCollection').mockResolvedValue()
      ragRemoveFromVectorStoreSpy = jest.spyOn(rag, 'removeFromVectorStore').mockResolvedValue()
      messageFindSpy = jest.spyOn(Message, 'find').mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([{ _id: 'msg1' }, { _id: 'msg2' }])
        })
      } as any)
      messageDeleteManySpy = jest.spyOn(Message, 'deleteMany').mockResolvedValue({} as any)
    })

    afterEach(() => {
      ragDeleteCollectionSpy.mockRestore()
      ragRemoveFromVectorStoreSpy.mockRestore()
      messageFindSpy.mockRestore()
      messageDeleteManySpy.mockRestore()
    })

    it('should clear only transcript content from vector store and preserve metadata', async () => {
      const conversation = { _id: 'conv123' }

      await transcript.clearTranscript(conversation)

      // Should remove only transcript-type documents, not delete collection
      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalledWith(`${TRANSCRIPT_COLLECTION_PREFIX}-conv123`, {
        type: 'transcript'
      })
      expect(ragDeleteCollectionSpy).not.toHaveBeenCalled()

      // Should delete transcript messages from MongoDB
      expect(messageFindSpy).toHaveBeenCalledWith({
        conversation,
        channels: { $in: ['transcript'] }
      })
      expect(messageDeleteManySpy).toHaveBeenCalledWith({
        _id: { $in: [{ _id: 'msg1' }, { _id: 'msg2' }] }
      })
    })

    it('should also clear transcript from topic collection using $and filter', async () => {
      const conversation = { _id: 'conv123', topic: { _id: 'topic456' } }

      await transcript.clearTranscript(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalledWith(`${TRANSCRIPT_COLLECTION_PREFIX}-conv123`, {
        type: 'transcript'
      })
      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalledWith(`${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-topic456`, {
        $and: [{ conversationId: 'conv123' }, { type: 'transcript' }]
      })
    })

    it('should not remove from topic collection when conversation has no topic', async () => {
      const conversation = { _id: 'conv123' }

      await transcript.clearTranscript(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalledTimes(1)
      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalledWith(`${TRANSCRIPT_COLLECTION_PREFIX}-conv123`, {
        type: 'transcript'
      })
    })

    it('should handle errors when clearing from vector store', async () => {
      const conversation = { _id: 'conv123' }

      ragRemoveFromVectorStoreSpy.mockRejectedValue(new Error('Vector store error'))

      // Should not throw, just log warning
      await expect(transcript.clearTranscript(conversation)).resolves.not.toThrow()

      // Should still delete messages
      expect(messageDeleteManySpy).toHaveBeenCalled()
    })
  })

  describe('deleteTranscript', () => {
    let ragDeleteCollectionSpy
    let ragRemoveFromVectorStoreDeleteSpy
    let messageFindSpy
    let messageDeleteManySpy

    beforeEach(() => {
      ragDeleteCollectionSpy = jest.spyOn(rag, 'deleteCollection').mockResolvedValue()
      ragRemoveFromVectorStoreDeleteSpy = jest.spyOn(rag, 'removeFromVectorStore').mockResolvedValue()
      messageFindSpy = jest.spyOn(Message, 'find').mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([{ _id: 'msg1' }, { _id: 'msg2' }])
        })
      } as any)
      messageDeleteManySpy = jest.spyOn(Message, 'deleteMany').mockResolvedValue({} as any)
    })

    afterEach(() => {
      ragDeleteCollectionSpy.mockRestore()
      ragRemoveFromVectorStoreDeleteSpy.mockRestore()
      messageFindSpy.mockRestore()
      messageDeleteManySpy.mockRestore()
    })

    it('should delete entire per-conversation collection from vector store including metadata', async () => {
      const conversation = { _id: 'conv123' }

      await transcript.deleteTranscript(conversation)

      // Should delete the entire collection
      expect(ragDeleteCollectionSpy).toHaveBeenCalledWith(`${TRANSCRIPT_COLLECTION_PREFIX}-conv123`)

      // Should delete transcript messages from MongoDB
      expect(messageFindSpy).toHaveBeenCalledWith({
        conversation,
        channels: { $in: ['transcript'] }
      })
      expect(messageDeleteManySpy).toHaveBeenCalledWith({
        _id: { $in: [{ _id: 'msg1' }, { _id: 'msg2' }] }
      })
    })

    it('should also remove conversation documents from topic collection', async () => {
      const conversation = { _id: 'conv123', topic: { _id: 'topic456' } }

      await transcript.deleteTranscript(conversation)

      expect(ragDeleteCollectionSpy).toHaveBeenCalledWith(`${TRANSCRIPT_COLLECTION_PREFIX}-conv123`)
      expect(ragRemoveFromVectorStoreDeleteSpy).toHaveBeenCalledWith(`${TOPIC_TRANSCRIPT_COLLECTION_PREFIX}-topic456`, {
        conversationId: 'conv123'
      })
    })

    it('should not remove from topic collection when conversation has no topic', async () => {
      const conversation = { _id: 'conv123' }

      await transcript.deleteTranscript(conversation)

      expect(ragDeleteCollectionSpy).toHaveBeenCalledWith(`${TRANSCRIPT_COLLECTION_PREFIX}-conv123`)
      expect(ragRemoveFromVectorStoreDeleteSpy).not.toHaveBeenCalled()
    })

    it('should handle errors when deleting collection', async () => {
      const conversation = { _id: 'conv123' }

      ragDeleteCollectionSpy.mockRejectedValue(new Error('Collection delete error'))

      // Should not throw, just log warning
      await expect(transcript.deleteTranscript(conversation)).resolves.not.toThrow()

      // Should still delete messages
      expect(messageDeleteManySpy).toHaveBeenCalled()
    })
  })

  describe('breakout room transcript channel selection', () => {
    it('should return ["transcript"] for a standard agent with no breakout config', () => {
      const agent = {
        conversation: { channels: [] }
      }
      expect(getTranscriptHistoryChannelNames(agent)).toEqual(['transcript'])
    })

    it('should return the breakout transcript channel name for a breakout room agent', () => {
      const agent = {
        agentConfig: { breakout: { roomId: 'room-1' } },
        conversation: {
          channels: [
            { name: 'transcript-room-1', breakout: { roomId: 'room-1', type: 'transcript' } },
            { name: 'chat-room-1', breakout: { roomId: 'room-1', type: 'chat' } },
            { name: 'transcript-room-2', breakout: { roomId: 'room-2', type: 'transcript' } }
          ]
        }
      }
      expect(getTranscriptHistoryChannelNames(agent)).toEqual(['transcript-room-1'])
    })

    it('should fall back to ["transcript"] when breakout agent has no matching channel', () => {
      const agent = {
        agentConfig: { breakout: { roomId: 'room-99' } },
        conversation: {
          channels: [
            { name: 'transcript-room-1', breakout: { roomId: 'room-1', type: 'transcript' } }
          ]
        }
      }
      expect(getTranscriptHistoryChannelNames(agent)).toEqual(['transcript'])
    })

    it('should return parent transcript channel plus all breakout transcript channels when includeBreakouts is set', () => {
      const agent = {
        conversationHistorySettings: { includeBreakouts: true },
        conversation: {
          channels: [
            { name: 'transcript-room-1', breakout: { roomId: 'room-1', type: 'transcript' } },
            { name: 'transcript-room-2', breakout: { roomId: 'room-2', type: 'transcript' } },
            { name: 'chat-room-1', breakout: { roomId: 'room-1', type: 'chat' } }
          ]
        }
      }
      expect(getTranscriptHistoryChannelNames(agent)).toEqual(['transcript', 'transcript-room-1', 'transcript-room-2'])
    })

    it('should filter breakout transcript messages by channel when using time query', async () => {
      const startTime = new Date('2024-01-15T10:00:00Z')
      const agent = {
        agentConfig: { breakout: { roomId: 'room-1' } },
        conversation: {
          _id: 'conv-breakout',
          startTime,
          channels: [
            { name: 'transcript-room-1', breakout: { roomId: 'room-1', type: 'transcript' } }
          ],
          messages: [
            {
              createdAt: new Date(startTime.getTime() + 2 * 60 * 1000),
              body: 'Breakout room message',
              pseudonym: 'Alice',
              channels: ['transcript-room-1']
            },
            {
              createdAt: new Date(startTime.getTime() + 3 * 60 * 1000),
              body: 'Main transcript message',
              pseudonym: 'Bob',
              channels: ['transcript']
            }
          ]
        }
      }
      ragGetContextChunksSpy.mockResolvedValue({ chunks: '' })
      const result = await transcript.searchTranscript(agent, 'What was discussed in the first 5 minutes?')
      expect(result.chunks).toEqual(expect.stringContaining('Breakout room message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Main transcript message'))
      expect(result.timeWindow).toBe(true)
    })

    it('should include messages from all breakout transcript channels when includeBreakouts is set', async () => {
      const startTime = new Date('2024-01-15T10:00:00Z')
      const agent = {
        conversationHistorySettings: { includeBreakouts: true },
        conversation: {
          _id: 'conv-reconvened',
          startTime,
          channels: [
            { name: 'transcript-room-1', breakout: { roomId: 'room-1', type: 'transcript' } },
            { name: 'transcript-room-2', breakout: { roomId: 'room-2', type: 'transcript' } }
          ],
          messages: [
            {
              createdAt: new Date(startTime.getTime() + 2 * 60 * 1000),
              body: 'Main transcript message',
              pseudonym: 'Alice',
              channels: ['transcript']
            },
            {
              createdAt: new Date(startTime.getTime() + 3 * 60 * 1000),
              body: 'Room 1 message',
              pseudonym: 'Bob',
              channels: ['transcript-room-1']
            },
            {
              createdAt: new Date(startTime.getTime() + 4 * 60 * 1000),
              body: 'Room 2 message',
              pseudonym: 'Charlie',
              channels: ['transcript-room-2']
            }
          ]
        }
      }
      ragGetContextChunksSpy.mockResolvedValue({ chunks: '' })
      const result = await transcript.searchTranscript(agent, 'What was discussed in the first 5 minutes?')
      expect(result.chunks).toEqual(expect.stringContaining('Main transcript message'))
      expect(result.chunks).toEqual(expect.stringContaining('Room 1 message'))
      expect(result.chunks).toEqual(expect.stringContaining('Room 2 message'))
      expect(result.timeWindow).toBe(true)
    })
  })
})
