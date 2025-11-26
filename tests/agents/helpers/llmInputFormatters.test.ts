import mongoose from 'mongoose'
import { Message } from '../../../src/models/index.js'
import {
  formatConversationHistory,
  formatConversationPhases,
  formatMessage,
  formatSingleUserConversationHistory
} from '../../../src/agents/helpers/llmInputFormatters.js'
import { IMessage } from '../../../src/types/index.types.js'
import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'

const owner = new mongoose.Types.ObjectId()
const conversation = new mongoose.Types.ObjectId()
const ownerPseudo = new mongoose.Types.ObjectId()

describe('LLM Input Formatter Tests', () => {
  async function createMessage(body, pseudonym, createdAt: Date = new Date(), fromAgent?) {
    const msg = new Message({
      _id: new mongoose.Types.ObjectId(),
      body,
      bodyType: 'text',
      conversation,
      owner,
      pseudonymId: ownerPseudo,
      pseudonym,
      createdAt,
      fromAgent
    })
    return msg
  }

  it('should format conversation phases correctly', async () => {
    const phasedHistory: { question: IMessage; conversation: Array<IMessage> }[] = []
    const messages: IMessage[] = []
    const question1 = await createMessage('Should AI be granted any form of legal personhood?', 'AI Curious College Student')
    messages.push(
      await createMessage('I think AI should have rights if it demonstrates consciousness.', 'Pro AI Urban Woman')
    )
    messages.push(
      await createMessage('But how do we define consciousness? Isn’t it just simulation?', 'AI Curious College Student')
    )
    phasedHistory.push({ question: question1, conversation: messages })
    const messages2: IMessage[] = []
    const question2 = await createMessage('How do we ensure AI does not destroy humanity?', 'Anti AI Rural Man')
    messages2.push(
      await createMessage(
        'I think concerns about that are overblown. There are always humans monitoring AI',
        'Pro AI Urban Woman'
      )
    )
    messages2.push(
      await createMessage(
        'It is a little concerning. AI technology is so powerful and there is a lot we do not know',
        'AI Curious College Student'
      )
    )
    phasedHistory.push({ question: question2, conversation: messages2 })

    const chunks = formatConversationPhases(phasedHistory)
    const expectedChunks = `**Chunk 1:**
**Question:** AI Curious College Student: "Should AI be granted any form of legal personhood?"
**Conversation:**
- Pro AI Urban Woman: "I think AI should have rights if it demonstrates consciousness."
- AI Curious College Student: "But how do we define consciousness? Isn’t it just simulation?"

**Chunk 2:**
**Question:** Anti AI Rural Man: "How do we ensure AI does not destroy humanity?"
**Conversation:**
- Pro AI Urban Woman: "I think concerns about that are overblown. There are always humans monitoring AI"
- AI Curious College Student: "It is a little concerning. AI technology is so powerful and there is a lot we do not know"`

    expect(chunks).toEqual(expectedChunks)
  })

  it('should format conversation history', async () => {
    const msg1 = await createMessage('I think AI should have rights if it demonstrates consciousness.', 'Pro AI Urban Woman')
    const msg2 = await createMessage(
      'But how do we define consciousness? Isn’t it just simulation?',
      'AI Curious College Student'
    )
    const msg3 = await createMessage('Are you breathing?', 'Pro AI Urban Woman')
    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 2 })
    const formattedMessages = formatConversationHistory(convHistory)
    // Just the two most recent messages should be returned
    expect(formattedMessages)
      .toEqual(`AI Curious College Student: "But how do we define consciousness? Isn’t it just simulation?"
Pro AI Urban Woman: "Are you breathing?"`)
  })

  it('should always include the user message if specified', async () => {
    const msg1 = await createMessage(
      'I think AI should have rights if it demonstrates consciousness.',
      'Pro AI Urban Woman',
      new Date(Date.now() - 120 * 1000)
    )
    const msg2 = await createMessage(
      'But how do we define consciousness? Isn’t it just simulation?',
      'AI Curious College Student',
      new Date(Date.now() - 90 * 1000)
    )
    const msg3 = await createMessage('Are you breathing?', 'Pro AI Urban Woman', new Date(Date.now() - 60 * 1000))

    const msg4 = await createMessage(
      'There must be more to it than that',
      'AI Curious College Student',
      new Date(Date.now() - 45 * 1000)
    )
    // making the assumption it doesn't take 20 seconds or more to get to the time check
    const convHistory = getConversationHistory([msg1, msg2, msg3], { timeWindow: 110, count: 1 })
    const formattedMessages = formatConversationHistory(convHistory, msg4)
    // Just the one message + user message should be returned
    expect(formattedMessages).toEqual(`Pro AI Urban Woman: "Are you breathing?"
AI Curious College Student: "There must be more to it than that"`)
  })

  it('should format single user conversation history', async () => {
    const msg1 = await createMessage('I think AI should have rights if it demonstrates consciousness.', 'Pro AI Urban Woman')
    const msg2 = await createMessage('But how do we define consciousness? Isn’t it just simulation?', 'BOT', undefined, true)
    const msg3 = await createMessage('Are you breathing?', 'Pro AI Urban Woman')
    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 100 })
    const formattedMessages = formatSingleUserConversationHistory(convHistory)
    expect(formattedMessages).toEqual([
      { role: 'user', content: 'I think AI should have rights if it demonstrates consciousness.' },
      { role: 'assistant', content: 'But how do we define consciousness? Isn’t it just simulation?' },
      { role: 'user', content: 'Are you breathing?' }
    ])
  })

  describe('formatMessage function', () => {
    it('should format a simple message with text body', async () => {
      const msg = await createMessage('Hello world', 'Test User')
      const formatted = formatMessage(msg)
      expect(formatted).toEqual('Test User: "Hello world"')
    })

    it('should format a message with JSON body type', async () => {
      const msg = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: { text: 'Hello JSON', data: { key: 'value' } },
        bodyType: 'json',
        conversation,
        owner,
        pseudonymId: ownerPseudo,
        pseudonym: 'JSON User',
        createdAt: new Date()
      })

      const formatted = formatMessage(msg)
      expect(formatted).toEqual('JSON User: "{"text":"Hello JSON","data":{"key":"value"}}"')
    })

    it('should format a structured message without transcript', async () => {
      const msg = await createMessage('Structured message', 'Structured User')
      const parsed = formatMessage(msg, true)

      expect(parsed).toHaveProperty('comment')
      expect(parsed.comment.user).toBe('Structured User')
      expect(parsed.comment.text).toBe('Structured message')
      expect(parsed.comment.timestamp).toBeDefined()
      expect(parsed).not.toHaveProperty('transcript_snippet')
    })

    it('should format a structured message with JSON body type', async () => {
      const msg = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: { text: 'JSON structured message' },
        bodyType: 'json',
        conversation,
        owner,
        pseudonymId: ownerPseudo,
        pseudonym: 'JSON Structured User',
        createdAt: new Date()
      })

      const parsed = formatMessage(msg, true)

      expect(parsed.comment.user).toBe('JSON Structured User')
      expect(parsed.comment.text).toBe('JSON structured message')
    })

    it('should format a structured message with transcript snippet', async () => {
      const msg = await createMessage('Message with transcript', 'Transcript User')
      const transcriptMessages = [
        '2024-01-01T10:00:00.000Z - Speaker 1: Hello',
        '2024-01-01T10:00:05.000Z - Speaker 2: Hi there'
      ]

      const parsed = formatMessage(msg, true, transcriptMessages)

      expect(parsed).toHaveProperty('comment')
      expect(parsed).toHaveProperty('transcript')
      expect(parsed.comment.user).toBe('Transcript User')
      expect(parsed.comment.text).toBe('Message with transcript')
      expect(parsed.transcript).toEqual(transcriptMessages)
    })

    it('should handle unstructured message with empty transcript array', async () => {
      const msg = await createMessage('Simple message', 'Simple User')
      const formatted = formatMessage(msg, false, [])
      expect(formatted).toEqual('Simple User: "Simple message"')
    })

    it('should handle message with undefined body gracefully', async () => {
      const msg = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: undefined,
        conversation,
        owner,
        pseudonymId: ownerPseudo,
        pseudonym: 'Undefined User',
        createdAt: new Date()
      })

      const formatted = formatMessage(msg)
      expect(formatted).toEqual('Undefined User: "undefined"')
    })

    it('should handle empty string body', async () => {
      const msg = await createMessage('', 'Empty User')
      const formatted = formatMessage(msg)
      expect(formatted).toEqual('Empty User: ""')
    })
  })
})
