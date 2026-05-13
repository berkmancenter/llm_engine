import { getModelChat, defaultLLMPlatform, defaultLLMModel } from '../../../src/agents/helpers/getModelChat.js'
import { matchBotMention, checkBotIntent, normalizeBotMention } from '../../../src/agents/helpers/intentChecks'
import { LlmPlatforms } from '../../../src/types/index.types'

describe('intentChecks', () => {
  describe('matchBotMention', () => {
    it('should return false for empty string', () => {
      expect(matchBotMention(''.trim().split(/\s+/), 'Assistant')).toBe(false)
    })

    it('should return true for single word exact bot name match', () => {
      expect(matchBotMention('Assistant'.trim().split(/\s+/), 'Assistant')).toBe(true)
    })

    it('should return true for @mention at the start of message', () => {
      expect(matchBotMention('@Assistant how are you'.trim().split(/\s+/), 'Assistant')).toBe(true)
    })

    it('should return true for @mention anywhere in message', () => {
      expect(matchBotMention('hey @Assistant how are you'.trim().split(/\s+/), 'Assistant')).toBe(true)
    })

    it('should return true for exact bot name match', () => {
      expect(matchBotMention('hey Assistant how are you'.trim().split(/\s+/), 'Assistant')).toBe(true)
    })

    it('should return true for case-insensitive match', () => {
      expect(matchBotMention('hey assistant how are you'.trim().split(/\s+/), 'Assistant')).toBe(true)
    })

    it('should return true for minor misspelling', () => {
      expect(matchBotMention('hey Assistent how are you'.trim().split(/\s+/), 'Assistant')).toBe(true)
    })

    it('should return true for misspelled @mention', () => {
      expect(matchBotMention('@Assistent how are you'.trim().split(/\s+/), 'Assistant')).toBe(true)
    })

    it('should return true when bot name has trailing punctuation', () => {
      expect(matchBotMention('hey Assistant, can you help'.trim().split(/\s+/), 'Assistant')).toBe(true)
    })

    it('should return true when bot name has exclamation mark', () => {
      expect(matchBotMention('hey Assistant! help me'.trim().split(/\s+/), 'Assistant')).toBe(true)
    })

    it('should return true when bot name has period', () => {
      expect(matchBotMention('hello Assistant. please assist'.trim().split(/\s+/), 'Assistant')).toBe(true)
    })

    it('should return false when no word matches bot name', () => {
      expect(matchBotMention('hello world how are you'.trim().split(/\s+/), 'Assistant')).toBe(false)
    })

    it('should return false for completely different text', () => {
      expect(matchBotMention('the weather is nice today'.trim().split(/\s+/), 'Copilot')).toBe(false)
    })

    it('should handle whitespace in text', () => {
      expect(matchBotMention('  hey   Assistant   help  '.trim().split(/\s+/), 'Assistant')).toBe(true)
    })

    it('should return true for bot name at end of message', () => {
      expect(matchBotMention('can you help Assistant'.trim().split(/\s+/), 'Assistant')).toBe(true)
    })
  })

  describe('normalizeBotMention', () => {
    it('replaces exact name with @name', () => {
      expect(normalizeBotMention('hey Assistant how are you', 'Assistant')).toBe('hey @Assistant how are you')
    })

    it('replaces misspelled name with @name', () => {
      expect(normalizeBotMention('hey Assistent how are you', 'Assistant')).toBe('hey @Assistant how are you')
    })

    it('replaces @misspelling with @name', () => {
      expect(normalizeBotMention('@Assistent how are you', 'Assistant')).toBe('@Assistant how are you')
    })

    it('preserves trailing punctuation after name', () => {
      expect(normalizeBotMention('hey Assistant, can you help', 'Assistant')).toBe('hey @Assistant, can you help')
    })

    it('does not modify words that do not match bot name', () => {
      expect(normalizeBotMention('hello world how are you', 'Assistant')).toBe('hello world how are you')
    })

    it('replaces name at start of message', () => {
      expect(normalizeBotMention('Assistant what did I miss?', 'Assistant')).toBe('@Assistant what did I miss?')
    })

    it('replaces name at end of message', () => {
      expect(normalizeBotMention('can you help Assistant', 'Assistant')).toBe('can you help @Assistant')
    })

    it('does not double the @ if already present', () => {
      expect(normalizeBotMention('@Assistant how are you', 'Assistant')).toBe('@Assistant how are you')
    })

    describe('addAtSymbol = false', () => {
      it('replaces exact name without adding @', () => {
        expect(normalizeBotMention('hey Assistant how are you', 'Assistant', false)).toBe('hey Assistant how are you')
      })

      it('replaces misspelled name with correct spelling, no @', () => {
        expect(normalizeBotMention('hey Assistent how are you', 'Assistant', false)).toBe('hey Assistant how are you')
      })

      it('preserves trailing punctuation after name without @', () => {
        expect(normalizeBotMention('hey Assistant, can you help', 'Assistant', false)).toBe('hey Assistant, can you help')
      })

      it('does not modify words that do not match bot name', () => {
        expect(normalizeBotMention('hello world how are you', 'Assistant', false)).toBe('hello world how are you')
      })
    })
  })

  describe('checkBotIntent', () => {
    let mockContext: { llm: Awaited<ReturnType<typeof getModelChat>>; botName: string }
    const taggedMessage = { body: 'Hello @TestBot, how are you?' }
    const possibleIntentMessage = { body: 'Can you help catch me up?' }
    const nonIntendedMessage = { body: 'I like what the speaker just said about hybrid work policies' }

    beforeAll(async () => {
      const llm = await getModelChat(defaultLLMPlatform as LlmPlatforms, defaultLLMModel)
      mockContext = {
        llm,
        botName: 'TestBot'
      }
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('should return true when bot is tagged by name', async () => {
      const result = await checkBotIntent(mockContext.llm, mockContext.botName, taggedMessage)

      expect(result).toBe(true)
    })

    it('should return true when message is possibly intended for bot', async () => {
      const result = await checkBotIntent(mockContext.llm, mockContext.botName, possibleIntentMessage)
      expect(result).toBe(true)
    })

    it('should return false when message is not intended for bot', async () => {
      const result = await checkBotIntent(mockContext.llm, mockContext.botName, nonIntendedMessage)
      expect(result).toBe(false)
    })
  })
})
