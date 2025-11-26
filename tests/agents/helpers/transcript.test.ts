import transcript from '../../../src/agents/helpers/transcript.js'
import rag, { TRANSCRIPT_COLLECTION_PREFIX } from '../../../src/agents/helpers/rag.js'
import Conversation from '../../../src/models/conversation.model.js'

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
      await searchTranscript(mockConversation, 'test question')
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
      await searchTranscript(mockConversation, 'test question')
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
      await searchTranscript(mockConversation, 'test question')
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
      await searchTranscript(mockConversation, 'test question')
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
    let mockConversation

    const mockChunks = [
      { content: 'Discussion about project timeline', metadata: { start: '2024-01-15T10:05:00Z' } },
      { content: 'Budget considerations for the project', metadata: { start: '2024-01-15T10:10:00Z' } }
    ]

    beforeEach(() => {
      mockConversation = {
        _id: 'conversation123',
        startTime: new Date('2024-01-15T10:00:00Z')
      }
      ragGetContextChunksSpy.mockResolvedValue({ chunks: mockChunks })
    })

    it('should search transcript without time query', async () => {
      const question = 'What was discussed about the project?'
      const result = await transcript.searchTranscript(mockConversation, question)
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
      mockConversation.messages = [
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
        mockConversation,
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
      mockConversation.messages = [
        {
          createdAt: new Date(mockConversation.startTime.getTime() + 120 * 1000),
          body: 'Test message',
          pseudonym: 'Joe',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockConversation.startTime.getTime() + 600 * 1000),
          body: 'Test older message',
          pseudonym: 'Bob',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockConversation.startTime.getTime() + 300 * 1000),
          body: 'Different message',
          pseudonym: 'Frank',
          channels: ['transcript']
        }
      ]

      const result = await transcript.searchTranscript(
        mockConversation,
        'What was discussed about the project in the first 5 minutes?'
      )

      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      expect(result.timeWindow).toBe(true)
    })

    it('should search transcript with absolute time query', async () => {
      mockConversation.messages = [
        {
          createdAt: new Date(mockConversation.startTime.getTime() + 32 * 60 * 1000),
          body: 'Test message',
          pseudonym: 'Joe',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockConversation.startTime.getTime() + 15 * 60 * 1000),
          body: 'Test older message',
          pseudonym: 'Bob',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockConversation.startTime.getTime() + 29 * 60 * 1000),
          body: 'Different message',
          pseudonym: 'Frank',
          channels: ['transcript']
        }
      ]
      const result = await transcript.searchTranscript(mockConversation, `What happened at ${localHour}:30?`)

      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      expect(result.timeWindow).toBe(true)
    })

    it('should search transcript with range time query', async () => {
      mockConversation.messages = [
        {
          createdAt: new Date(mockConversation.startTime.getTime() + 32 * 60 * 1000),
          body: 'Test message',
          pseudonym: 'Joe',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockConversation.startTime.getTime() + 10 * 60 * 1000),
          body: 'Test older message',
          pseudonym: 'Bob',
          channels: ['transcript']
        },
        {
          createdAt: new Date(mockConversation.startTime.getTime() + 29 * 60 * 1000),
          body: 'Different message',
          pseudonym: 'Frank',
          channels: ['transcript']
        }
      ]
      const result = await transcript.searchTranscript(
        mockConversation,
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

        await transcript.searchTranscript(mockConversation, question, endTime)

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

        await transcript.searchTranscript(mockConversation, question)

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

        mockConversation.messages = [
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
          mockConversation,
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
        const endTime = new Date(mockConversation.startTime.getTime() + 25 * 60 * 1000) // 25 minutes after start

        mockConversation.messages = [
          {
            createdAt: new Date(mockConversation.startTime.getTime() + 32 * 60 * 1000),
            body: 'Test message',
            pseudonym: 'Joe',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockConversation.startTime.getTime() + 15 * 60 * 1000),
            body: 'Test older message',
            pseudonym: 'Bob',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockConversation.startTime.getTime() + 29 * 60 * 1000),
            body: 'Different message',
            pseudonym: 'Frank',
            channels: ['transcript']
          }
        ]
        const result = await transcript.searchTranscript(mockConversation, `What happened at ${localHour}:30?`, endTime)

        expect(result.chunks).toEqual(expect.stringContaining('Test message'))
        expect(result.chunks).toEqual(expect.stringContaining('Different message'))
        expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
        expect(result.timeWindow).toBe(true)
      })

      it('should ignore endTime when using range time query', async () => {
        const endTime = new Date(mockConversation.startTime.getTime() + 35 * 60 * 1000) // 35 minutes after start

        mockConversation.messages = [
          {
            createdAt: new Date(mockConversation.startTime.getTime() + 40 * 60 * 1000), // After endTime
            body: 'Message after endTime',
            pseudonym: 'Alice',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockConversation.startTime.getTime() + 30 * 60 * 1000), // Within range and before endTime
            body: 'Valid message 1',
            pseudonym: 'Bob',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockConversation.startTime.getTime() + 20 * 60 * 1000), // Within range and before endTime
            body: 'Valid message 2',
            pseudonym: 'Charlie',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockConversation.startTime.getTime() + 10 * 60 * 1000), // Outside range (too early)
            body: 'Too early message',
            pseudonym: 'Dave',
            channels: ['transcript']
          }
        ]

        const result = await transcript.searchTranscript(
          mockConversation,
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
        const endTime = new Date(mockConversation.startTime.getTime() + 5 * 60 * 1000) // 5 minutes after start

        mockConversation.messages = [
          {
            createdAt: new Date(mockConversation.startTime.getTime() + 32 * 60 * 1000), // After endTime
            body: 'Message after endTime',
            pseudonym: 'Alice',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockConversation.startTime.getTime() + 29 * 60 * 1000), // After endTime
            body: 'Another message after endTime',
            pseudonym: 'Bob',
            channels: ['transcript']
          }
        ]

        const result = await transcript.searchTranscript(
          mockConversation,
          'What was discussed about the project in the last 5 minutes?',
          endTime
        )

        expect(result.chunks).toBe('')
        expect(result.timeWindow).toBe(true)
      })

      it('should handle endTime with first/last relative queries correctly', async () => {
        const testStartTime = Date.now()
        const endTime = new Date(testStartTime - 100 * 1000) // 100 seconds ago

        mockConversation.messages = [
          {
            createdAt: new Date(mockConversation.startTime.getTime() + 2 * 60 * 1000), // Within first 5 minutes
            body: 'Early valid message',
            pseudonym: 'Alice',
            channels: ['transcript']
          },
          {
            createdAt: new Date(mockConversation.startTime.getTime() + 4 * 60 * 1000), // Within first 5 minutes
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
          mockConversation,
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
        await transcript.searchTranscript(mockConversation, question, null)
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
        await transcript.searchTranscript(mockConversation, question, undefined)
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
    const mockFormattedTranscript = `[${localHour}:05:30 AM] Hello everyone
[${localHour}:06:15 AM] Let's start the meeting
[${localHour}:07:00 AM] First item on the agenda`

    beforeEach(() => {
      ragAddToVectorStoreSpy.mockResolvedValue()
    })

    it('should load transcript into vector store with proper metadata', async () => {
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
      const { metadataFn } = ragAddToVectorStoreSpy.mock.calls[0][2]; const mockDoc = { pageContent: mockFormattedTranscript } as {
        pageContent: string
        metadata?: Record<string, unknown>
      }
      const newDoc = metadataFn(mockDoc)
      expect(newDoc.metadata!).toEqual({
        start: new Date('2024-01-15T10:05:30Z').getTime(),
        end: new Date('2024-01-15T10:07:00Z').getTime(),
        type: 'transcript'
      })
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
      const mockConversation = {
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

      const result = await transcript.searchTranscript(mockConversation, `What happened at ${startTime.getHours()}:30?`)

      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      expect(result.timeWindow).toBe(true)
    })

    it('should handle 12-hour format time conversion correctly for AM start time', async () => {
      const startTime = new Date()
      startTime.setHours(8, 0, 0, 0) // set to 8:00 am local time
      const mockConversation = {
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

      const result = await transcript.searchTranscript(mockConversation, `What happened at ${startTime.getHours()}:15?`)

      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      expect(result.timeWindow).toBe(true)
    })

    it('should handle 24-hour format time conversion correctly', async () => {
      const startTime = new Date()
      startTime.setHours(110, 0, 0, 0) // set to 15:00 local time
      const mockConversation = {
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

      const result = await transcript.searchTranscript(mockConversation, `What happened at ${startTime.getHours()}:20?`)

      expect(result.chunks).toEqual(expect.stringContaining('Test message'))
      expect(result.chunks).toEqual(expect.stringContaining('Different message'))
      expect(result.chunks).not.toEqual(expect.stringContaining('Test older message'))
      expect(result.timeWindow).toBe(true)
    })
  })
  describe('loadEventMetadataIntoVectorStore', () => {
    beforeEach(() => {
      ragAddToVectorStoreSpy.mockResolvedValue()
    })
    it('should load all event metadata when all parameters provided', async () => {
      const conversation = {
        _id: 'test-conversation-id',
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
        `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`,
        [
          'Event (Meeting Conversation Presentation) Description: This is a test event description about AI and machine learning.',
          'Jane Doe is a speaker, presenter, and panelist at this event. Jane is a leading researcher in AI with 10 years of experience.',
          'John Smith is a speaker, presenter, and panelist at this event. John specializes in machine learning applications.',
          'Alice Johnson is the moderator, facilitator, and host of this event. Alice has moderated tech panels for 5 years.'
        ],
        {
          metadatas: [
            { type: 'event' },
            { type: 'presenter', presenterName: 'Jane Doe' },
            { type: 'presenter', presenterName: 'John Smith' },
            { type: 'moderator', moderatorName: 'Alice Johnson' }
          ]
        }
      )
    })

    it('should load only event description when only that is provided', async () => {
      const conversation = { _id: 'test-conversation-id', description: 'This is a test event description.' }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalled()

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`,
        ['Event (Meeting Conversation Presentation) Description: This is a test event description.'],
        {
          metadatas: [{ type: 'event' }]
        }
      )
    })

    it('should load only presenters when only those are provided', async () => {
      const conversation = {
        _id: 'test-conversation-id',
        presenters: [{ name: 'Jane Doe', bio: 'Jane is a leading researcher.' }]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalled()

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`,
        ['Jane Doe is a speaker, presenter, and panelist at this event. Jane is a leading researcher.'],
        {
          metadatas: [{ type: 'presenter', presenterName: 'Jane Doe' }]
        }
      )
    })

    it('should load only moderators when only those are provided', async () => {
      const conversation = {
        _id: 'test-conversation-id',
        moderators: [{ name: 'Alice Johnson', bio: 'Alice has moderated panels.' }]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalled()

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`,
        ['Alice Johnson is the moderator, facilitator, and host of this event. Alice has moderated panels.'],
        {
          metadatas: [{ type: 'moderator', moderatorName: 'Alice Johnson' }]
        }
      )
    })

    it('should handle presenters without bios', async () => {
      const conversation = {
        _id: 'test-conversation-id',
        presenters: [
          { name: 'Jane Doe', bio: null },
          { name: 'John Smith' } // no bio property
        ]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalled()

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`,
        [
          'Jane Doe is a speaker, presenter, and panelist at this event. No bio provided.',
          'John Smith is a speaker, presenter, and panelist at this event. No bio provided.'
        ],
        {
          metadatas: [
            { type: 'presenter', presenterName: 'Jane Doe' },
            { type: 'presenter', presenterName: 'John Smith' }
          ]
        }
      )
    })

    it('should handle moderators without bios', async () => {
      const conversation = {
        _id: 'test-conversation-id',
        moderators: [{ name: 'Alice Johnson', bio: '' }, { name: 'Bob Wilson' }]
      }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalled()

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`,
        [
          'Alice Johnson is the moderator, facilitator, and host of this event. No bio provided.',
          'Bob Wilson is the moderator, facilitator, and host of this event. No bio provided.'
        ],
        {
          metadatas: [
            { type: 'moderator', moderatorName: 'Alice Johnson' },
            { type: 'moderator', moderatorName: 'Bob Wilson' }
          ]
        }
      )
    })

    it('should handle multiple presenters and moderators', async () => {
      const conversation = {
        _id: 'test-conversation-id',
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

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalled()

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`,
        [
          'Presenter 1 is a speaker, presenter, and panelist at this event. Bio 1',
          'Presenter 2 is a speaker, presenter, and panelist at this event. Bio 2',
          'Presenter 3 is a speaker, presenter, and panelist at this event. Bio 3',
          'Moderator 1 is the moderator, facilitator, and host of this event. Mod Bio 1',
          'Moderator 2 is the moderator, facilitator, and host of this event. Mod Bio 2'
        ],
        {
          metadatas: [
            { type: 'presenter', presenterName: 'Presenter 1' },
            { type: 'presenter', presenterName: 'Presenter 2' },
            { type: 'presenter', presenterName: 'Presenter 3' },
            { type: 'moderator', moderatorName: 'Moderator 1' },
            { type: 'moderator', moderatorName: 'Moderator 2' }
          ]
        }
      )
    })

    it('should handle empty presenters array', async () => {
      const conversation = { _id: 'test-conversation-id', description: 'Test event', presenters: [] }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalled()

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`,
        ['Event (Meeting Conversation Presentation) Description: Test event'],
        {
          metadatas: [{ type: 'event' }]
        }
      )
    })

    it('should handle empty moderators array', async () => {
      const conversation = { _id: 'test-conversation-id', description: 'Test event', moderators: [] }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalled()

      expect(ragAddToVectorStoreSpy).toHaveBeenCalledWith(
        `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`,
        ['Event (Meeting Conversation Presentation) Description: Test event'],
        {
          metadatas: [{ type: 'event' }]
        }
      )
    })

    it('should not call addTextsToVectorStore when no metadata provided', async () => {
      const conversation = { _id: 'test-conversation-id' }

      await transcript.loadEventMetadataIntoVectorStore(conversation)

      expect(ragRemoveFromVectorStoreSpy).toHaveBeenCalled()

      expect(ragAddToVectorStoreSpy).not.toHaveBeenCalled()
    })
  })
})
