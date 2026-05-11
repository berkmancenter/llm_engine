import { getModelChat, defaultLLMPlatform, defaultLLMModel } from '../../../src/agents/helpers/getModelChat.js'
import { matchBotMention, checkBotIntent } from '../../../src/agents/helpers/intentChecks'
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
