import { resolveAnswerDestination } from '../../../src/agents/eventAssistant/eventQuestionHandler.js'

const pregameChannel = { name: 'pregame' }
const chatChannel = { name: 'chat' }
const directChannel = { name: 'direct-agents-user1', direct: true }

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    scheduledTime: new Date(Date.now() + 5 * 60 * 1000),
    preEventMinutes: 15,
    draft: false,
    channels: [pregameChannel, chatChannel, directChannel],
    ...overrides
  }
}

describe('resolveAnswerDestination', () => {
  describe('dm questions', () => {
    test('keeps the question channel and threads under an existing parentMessage', () => {
      const conversation = makeConversation()
      const userMessage = { channels: ['direct-agents-user1'], parentMessage: 'reply-to-this', _id: 'q1' }

      const result = resolveAnswerDestination(conversation, userMessage, [directChannel], 'dm')

      expect(result.channels).toEqual([directChannel])
      expect(result.parentMessageId).toBe('reply-to-this')
    })

    test('has no parent when the question itself was not a reply', () => {
      const conversation = makeConversation()
      const userMessage = { channels: ['direct-agents-user1'], _id: 'q1' }

      const result = resolveAnswerDestination(conversation, userMessage, [directChannel], 'dm')

      expect(result.parentMessageId).toBeUndefined()
    })
  })

  describe('group chat questions, channel unchanged', () => {
    test('keeps the question channel and threads under it', () => {
      const conversation = makeConversation({ startTime: new Date() }) // window closed -> chat is live
      const userMessage = { channels: ['chat'], parentMessage: 'earlier-question', _id: 'q1' }

      const result = resolveAnswerDestination(conversation, userMessage, [chatChannel], 'groupChat')

      expect(result.channels).toEqual([chatChannel])
      expect(result.parentMessageId).toBe('earlier-question')
    })

    test('threads under the question itself when it is not already a reply', () => {
      const conversation = makeConversation({ startTime: new Date() })
      const userMessage = { channels: ['chat'], _id: 'q1' }

      const result = resolveAnswerDestination(conversation, userMessage, [chatChannel], 'groupChat')

      expect(result.parentMessageId).toBe('q1')
    })
  })

  describe('group chat questions, channel moved since the question was asked', () => {
    test('sends the answer to the now-live channel instead of the question channel', () => {
      const conversation = makeConversation({ startTime: new Date() }) // window closed -> chat is live now
      const userMessage = { channels: ['pregame'], parentMessage: 'earlier-question', _id: 'q1' } // asked during pregame

      const result = resolveAnswerDestination(conversation, userMessage, [pregameChannel], 'groupChat')

      expect(result.channels).toEqual([chatChannel])
    })

    test('skips threading rather than reference a parent in a channel nobody sees anymore', () => {
      const conversation = makeConversation({ startTime: new Date() })
      const userMessage = { channels: ['pregame'], parentMessage: 'earlier-question', _id: 'q1' }

      const result = resolveAnswerDestination(conversation, userMessage, [pregameChannel], 'groupChat')

      expect(result.parentMessageId).toBeUndefined()
    })

    test('does not move the answer when the question channel is still the live one', () => {
      const conversation = makeConversation() // window still open -> pregame is live
      const userMessage = { channels: ['pregame'], _id: 'q1' }

      const result = resolveAnswerDestination(conversation, userMessage, [pregameChannel], 'groupChat')

      expect(result.channels).toEqual([pregameChannel])
      expect(result.parentMessageId).toBe('q1')
    })
  })
})
