import { getModelChat, defaultLLMPlatform, defaultLLMModel } from '../../../src/agents/helpers/getModelChat.js'
import { matchBotMention, checkIntent } from '../../../src/agents/helpers/intentChecks'
import agent from '../../../src/jobs/handlers/agent'
import { Agent } from '../../../src/models'
import { AgentMessageActions, LlmPlatforms } from '../../../src/types/index.types'
import setupAgentTest from '../../utils/setupAgentTest'

const testConfig = setupAgentTest('generic')

describe('intentChecks', () => {
  describe('matchBotMention', () => {
    it('should return false for single word messages', () => {
      expect(matchBotMention('hello', 'Assistant')).toBe(false)
    })

    it('should return false for empty string', () => {
      expect(matchBotMention('', 'Assistant')).toBe(false)
    })

    it('should return true for exact bot name match', () => {
      expect(matchBotMention('hey Assistant how are you', 'Assistant')).toBe(true)
    })

    it('should return true for case-insensitive match', () => {
      expect(matchBotMention('hey assistant how are you', 'Assistant')).toBe(true)
    })

    it('should return true for minor misspelling', () => {
      expect(matchBotMention('hey Assistent how are you', 'Assistant')).toBe(true)
    })

    it('should return true when bot name has trailing punctuation', () => {
      expect(matchBotMention('hey Assistant, can you help', 'Assistant')).toBe(true)
    })

    it('should return true when bot name has exclamation mark', () => {
      expect(matchBotMention('hey Assistant! help me', 'Assistant')).toBe(true)
    })

    it('should return true when bot name has period', () => {
      expect(matchBotMention('hello Assistant. please assist', 'Assistant')).toBe(true)
    })

    it('should return false when no word matches bot name', () => {
      expect(matchBotMention('hello world how are you', 'Assistant')).toBe(false)
    })

    it('should return false for completely different text', () => {
      expect(matchBotMention('the weather is nice today', 'Copilot')).toBe(false)
    })

    it('should handle whitespace in text', () => {
      expect(matchBotMention('  hey   Assistant   help  ', 'Assistant')).toBe(true)
    })

    it('should return true for bot name at end of message', () => {
      expect(matchBotMention('can you help Assistant', 'Assistant')).toBe(true)
    })
  })

  describe('checkIntent', () => {

   const llm = getModelChat(defaultLLMPlatform as LlmPlatforms, defaultLLMModel)
    let mockContext: { llm: typeof llm, botName: string }
    const taggedMessage = { body: 'Hello @TestBot, how are you?' }
    const possibleIntentMessage = { body: 'Can you help catch me up?' }
    const nonIntendedMessage = { body: 'I like what the speaker just said about hybrid work policies' }

    beforeEach(() => {
      mockContext = {
        llm,
        botName: 'TestBot'
      }
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('should return true when bot is tagged by name', async () => {
      const result = await checkIntent(mockContext.llm, mockContext.botName, taggedMessage)

      expect(result).toBe(true)
    })

    it('should return true when message is possibly intended for bot', async () => {
      const result = await checkIntent(mockContext.llm, mockContext.botName, possibleIntentMessage)
      expect(result).toBe(true)
    })

    it('should return false when message is not intended for bot', async () => {
      const result = await checkIntent(mockContext.llm, mockContext.botName, nonIntendedMessage)
      expect(result).toBe(false)
    })

  
  })
})
