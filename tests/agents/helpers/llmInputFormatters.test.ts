import mongoose from 'mongoose'
import { Message } from '../../../src/models/index.js'
import {
  formatConversationPhases,
  formatDmHistoryByChannel,
  formatMessage,
  formatSingleUserConversationHistory,
  formatMultiUserConversationHistory,
  formatTime,
  formatTranscript
} from '../../../src/agents/helpers/llmInputFormatters.js'
import { IMessage } from '../../../src/types/index.types.js'
import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'

const owner = new mongoose.Types.ObjectId()
const conversation = new mongoose.Types.ObjectId()
const ownerPseudo = new mongoose.Types.ObjectId()

describe('LLM Input Formatter Tests', () => {
  async function createMessage(
    body,
    pseudonym,
    createdAt: Date = new Date(),
    fromAgent?,
    bodyType = 'text',
    channels?: string[]
  ) {
    const msg = new Message({
      _id: new mongoose.Types.ObjectId(),
      body,
      bodyType,
      conversation,
      owner,
      pseudonymId: ownerPseudo,
      pseudonym,
      createdAt,
      updatedAt: createdAt,
      fromAgent,
      channels
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

  it('should format multi-user conversation history', async () => {
    const msg1 = await createMessage('I think AI should have rights if it demonstrates consciousness.', 'Pro AI Urban Woman')
    const msg2 = await createMessage(
      "But how do we define consciousness? Isn't it just simulation?",
      'AI Curious College Student'
    )
    const msg3 = await createMessage('Are you breathing?', 'Pro AI Urban Woman')
    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 2 })
    const formattedMessages = formatMultiUserConversationHistory(convHistory)
    // Just the two most recent messages should be returned
    expect(formattedMessages).toEqual([
      { role: 'user', content: "AI Curious College Student: But how do we define consciousness? Isn't it just simulation?" },
      { role: 'user', content: 'Pro AI Urban Woman: Are you breathing?' }
    ])
  })

  it('should format multi-user conversation history with agent messages', async () => {
    const msg1 = await createMessage('I think AI should have rights if it demonstrates consciousness.', 'Pro AI Urban Woman')
    const msg2 = await createMessage("But how do we define consciousness? Isn't it just simulation?", 'BOT', undefined, true)
    const msg3 = await createMessage('Are you breathing?', 'Pro AI Urban Woman')
    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 100 })
    const formattedMessages = formatMultiUserConversationHistory(convHistory)
    expect(formattedMessages).toEqual([
      { role: 'user', content: 'Pro AI Urban Woman: I think AI should have rights if it demonstrates consciousness.' },
      { role: 'assistant', content: "But how do we define consciousness? Isn't it just simulation?" },
      { role: 'user', content: 'Pro AI Urban Woman: Are you breathing?' }
    ])
  })

  it('should format single user conversation history', async () => {
    const msg1 = await createMessage('I think AI should have rights if it demonstrates consciousness.', 'Pro AI Urban Woman')
    const msg2 = await createMessage("But how do we define consciousness? Isn't it just simulation?", 'BOT', undefined, true)
    const msg3 = await createMessage('Are you breathing?', 'Pro AI Urban Woman')
    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 100 })
    const formattedMessages = formatSingleUserConversationHistory(convHistory)
    expect(formattedMessages).toEqual([
      { role: 'user', content: 'I think AI should have rights if it demonstrates consciousness.' },
      { role: 'assistant', content: "But how do we define consciousness? Isn't it just simulation?" },
      { role: 'user', content: 'Are you breathing?' }
    ])
  })

  it('should format single user conversation history with json body type', async () => {
    const msg1 = await createMessage('I think AI should have rights if it demonstrates consciousness.', 'Pro AI Urban Woman')
    const msg2 = await createMessage(
      { text: 'But how do we define consciousness? Isn’t it just simulation?' },
      'BOT',
      undefined,
      true,
      'json'
    )
    const msg3 = await createMessage('Are you breathing?', 'Pro AI Urban Woman')
    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 100 })
    const formattedMessages = formatSingleUserConversationHistory(convHistory)
    expect(formattedMessages).toEqual([
      { role: 'user', content: 'I think AI should have rights if it demonstrates consciousness.' },
      { role: 'assistant', content: 'But how do we define consciousness? Isn’t it just simulation?' },
      { role: 'user', content: 'Are you breathing?' }
    ])
  })

  it('should use empty string with json body type and no text property', async () => {
    const msg1 = await createMessage('I think AI should have rights if it demonstrates consciousness.', 'Pro AI Urban Woman')
    const msg2 = await createMessage(
      { value: "But how do we define consciousness? Isn't it just simulation?" },
      'BOT',
      undefined,
      true,
      'json'
    )
    const msg3 = await createMessage('Are you breathing?', 'Pro AI Urban Woman')
    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 100 })
    const formattedMessages = formatSingleUserConversationHistory(convHistory)
    expect(formattedMessages).toEqual([
      { role: 'user', content: 'I think AI should have rights if it demonstrates consciousness.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Are you breathing?' }
    ])
  })

  it('should expand a voice assistant response into a question/answer pair in multi-user history', async () => {
    const msg1 = await createMessage('I think AI should have rights.', 'Pro AI Urban Woman')
    const msg2 = await createMessage(
      {
        text: 'Part-time work is working fewer hours than a full-time schedule.',
        source: 'voice',
        sourceMessage: 'What is part-time work?',
        sourcePseudonym: 'Curious Corgi'
      },
      'Voice Assistant',
      undefined,
      true,
      'json'
    )
    const msg3 = await createMessage('Interesting!', 'Pro AI Urban Woman')
    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 100 })
    const formattedMessages = formatMultiUserConversationHistory(convHistory)
    expect(formattedMessages).toEqual([
      { role: 'user', content: 'Pro AI Urban Woman: I think AI should have rights.' },
      { role: 'user', content: 'Curious Corgi: What is part-time work?' },
      { role: 'assistant', content: 'Part-time work is working fewer hours than a full-time schedule.' },
      { role: 'user', content: 'Pro AI Urban Woman: Interesting!' }
    ])
  })

  it('should fall back to "User" as asking pseudonym when sourcePseudonym is absent from voice response', async () => {
    const msg1 = await createMessage(
      {
        text: 'Part-time work is working fewer hours than a full-time schedule.',
        source: 'voice',
        sourceMessage: 'What is part-time work?'
      },
      'Voice Assistant',
      undefined,
      true,
      'json'
    )
    const convHistory = getConversationHistory([msg1], { count: 100 })
    const formattedMessages = formatMultiUserConversationHistory(convHistory)
    expect(formattedMessages).toEqual([
      { role: 'user', content: 'User: What is part-time work?' },
      { role: 'assistant', content: 'Part-time work is working fewer hours than a full-time schedule.' }
    ])
  })

  it('should not expand agent json messages that are not voice responses', async () => {
    const msg1 = await createMessage(
      { text: 'Some agent response', type: 'on_topic_answer' },
      'BOT',
      undefined,
      true,
      'json'
    )
    const convHistory = getConversationHistory([msg1], { count: 100 })
    const formattedMessages = formatMultiUserConversationHistory(convHistory)
    expect(formattedMessages).toEqual([{ role: 'assistant', content: 'Some agent response' }])
  })

  it('should format multi-user conversation history with json body type', async () => {
    const msg1 = await createMessage('I think AI should have rights if it demonstrates consciousness.', 'Pro AI Urban Woman')
    const msg2 = await createMessage(
      { text: "But how do we define consciousness? Isn't it just simulation?" },
      'BOT',
      undefined,
      true,
      'json'
    )
    const msg3 = await createMessage('Are you breathing?', 'Pro AI Urban Woman')
    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 100 })
    const formattedMessages = formatMultiUserConversationHistory(convHistory)
    expect(formattedMessages).toEqual([
      { role: 'user', content: 'Pro AI Urban Woman: I think AI should have rights if it demonstrates consciousness.' },
      { role: 'assistant', content: "But how do we define consciousness? Isn't it just simulation?" },
      { role: 'user', content: 'Pro AI Urban Woman: Are you breathing?' }
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

  describe('formatTime function', () => {
    it('should format time in UTC by default', () => {
      const date = new Date('2024-01-15T14:30:45Z')
      const formatted = formatTime(date)
      expect(formatted).toBe('2:30:45 PM')
    })

    it('should format time in specified timezone', () => {
      const date = new Date('2024-01-15T14:30:45Z')
      const formatted = formatTime(date, 'America/New_York')
      // UTC 14:30 = EST 9:30 AM (UTC-5)
      expect(formatted).toBe('9:30:45 AM')
    })

    it('should format time in different timezone', () => {
      const date = new Date('2024-01-15T14:30:45Z')
      const formatted = formatTime(date, 'Asia/Tokyo')
      // UTC 14:30 = JST 11:30 PM (UTC+9)
      expect(formatted).toBe('11:30:45 PM')
    })

    it('should handle midnight correctly in different timezones', () => {
      const date = new Date('2024-01-15T00:00:00Z')
      const formattedUTC = formatTime(date, 'UTC')
      const formattedEST = formatTime(date, 'America/New_York')

      expect(formattedUTC).toBe('12:00:00 AM')
      // UTC 00:00 = EST 7:00 PM previous day (UTC-5)
      expect(formattedEST).toBe('7:00:00 PM')
    })
  })

  describe('formatTranscript function', () => {
    it('should format transcript with UTC timezone by default', async () => {
      const msg1 = await createMessage('First message', 'User 1', new Date('2024-01-15T10:15:30Z'))
      const msg2 = await createMessage('Second message', 'User 2', new Date('2024-01-15T10:16:45Z'))

      const formatted = formatTranscript([msg1, msg2])

      expect(formatted).toBe('[10:15:30 AM] First message\n[10:16:45 AM] Second message')
    })

    it('should format transcript with specified timezone', async () => {
      const msg1 = await createMessage('First message', 'User 1', new Date('2024-01-15T14:30:00Z'))
      const msg2 = await createMessage('Second message', 'User 2', new Date('2024-01-15T14:45:00Z'))

      const formatted = formatTranscript([msg1, msg2], 'America/New_York')

      // UTC 14:30 = EST 9:30 AM
      expect(formatted).toBe('[9:30:00 AM] First message\n[9:45:00 AM] Second message')
    })

    it('should format transcript with Asia/Tokyo timezone', async () => {
      const msg1 = await createMessage('Hello', 'User A', new Date('2024-01-15T15:00:00Z'))

      const formatted = formatTranscript([msg1], 'Asia/Tokyo')

      // UTC 15:00 = JST 00:00 next day (midnight)
      expect(formatted).toBe('[12:00:00 AM] Hello')
    })

    it('should handle empty message array', () => {
      const formatted = formatTranscript([])
      expect(formatted).toBe('')
    })

    it('should format single message with timezone', async () => {
      const msg = await createMessage('Single message', 'User', new Date('2024-01-15T20:00:00Z'))

      const formatted = formatTranscript([msg], 'Europe/London')

      // UTC 20:00 = GMT 20:00 (8:00 PM)
      expect(formatted).toBe('[8:00:00 PM] Single message')
    })
  })

  describe('formatDmHistoryByChannel', () => {
    it('returns empty string when there are no messages', async () => {
      const result = formatDmHistoryByChannel([], ['dm-alice', 'dm-bob'])
      expect(result).toBe('')
    })

    it('formats a single participant channel with participant and agent messages', async () => {
      const msg1 = await createMessage('Hello, I have a question.', 'Curious Corgi', new Date(), false, 'text', ['dm-alice'])
      const msg2 = await createMessage('Happy to help — what is it?', 'Assistant', new Date(), true, 'text', ['dm-alice'])

      const result = formatDmHistoryByChannel([msg1, msg2], ['dm-alice'])

      expect(result).toBe(
        '[DM — Curious Corgi]\n' +
          'Curious Corgi: "Hello, I have a question."\n' +
          'Assistant (to Curious Corgi): "Happy to help — what is it?"'
      )
    })

    it('labels agent messages with the recipient pseudonym, not sender', async () => {
      const msg1 = await createMessage('I feel a bit lost.', 'Wandering Wolf', new Date(), false, 'text', ['dm-wolf'])
      const msg2 = await createMessage('That is completely normal here.', 'Event Assistant', new Date(), true, 'text', [
        'dm-wolf'
      ])

      const result = formatDmHistoryByChannel([msg1, msg2], ['dm-wolf'])

      expect(result).toContain('Assistant (to Wandering Wolf):')
      expect(result).not.toContain('Event Assistant:')
    })

    it('groups messages from multiple participants into separate sections', async () => {
      const aliceMsg = await createMessage('Is this on topic?', 'Curious Alice', new Date(), false, 'text', ['dm-alice'])
      const aliceReply = await createMessage('Yes, great question!', 'Assistant', new Date(), true, 'text', ['dm-alice'])
      const bobMsg1 = await createMessage('Can you explain that again?', 'Skeptical Bob', new Date(), false, 'text', [
        'dm-bob'
      ])
      const bobReply1 = await createMessage('Of course — here is a simpler take.', 'Assistant', new Date(), true, 'text', [
        'dm-bob'
      ])
      const bobMsg2 = await createMessage('Still not sure I follow.', 'Skeptical Bob', new Date(), false, 'text', ['dm-bob'])
      const bobReply2 = await createMessage('Let me try a different angle.', 'Assistant', new Date(), true, 'text', [
        'dm-bob'
      ])

      const result = formatDmHistoryByChannel(
        [aliceMsg, aliceReply, bobMsg1, bobReply1, bobMsg2, bobReply2],
        ['dm-alice', 'dm-bob']
      )

      expect(result).toContain('[DM — Curious Alice]')
      expect(result).toContain('Curious Alice: "Is this on topic?"')
      expect(result).toContain('Assistant (to Curious Alice): "Yes, great question!"')
      expect(result).toContain('[DM — Skeptical Bob]')
      expect(result).toContain('Skeptical Bob: "Can you explain that again?"')
      expect(result).toContain('Assistant (to Skeptical Bob): "Of course — here is a simpler take."')
      expect(result).toContain('Skeptical Bob: "Still not sure I follow."')
      expect(result).toContain('Assistant (to Skeptical Bob): "Let me try a different angle."')
      // Sections are separated by a blank line
      expect(result).toContain('\n\n')
    })

    it('skips channels with no messages', async () => {
      const msg = await createMessage('Just me here.', 'Solo Sam', new Date(), false, 'text', ['dm-sam'])

      const result = formatDmHistoryByChannel([msg], ['dm-sam', 'dm-empty'])

      expect(result).toContain('[DM — Solo Sam]')
      // Only one section header — dm-empty produces nothing
      expect(result.match(/\[DM —/g)?.length).toBe(1)
      expect(result.split('\n\n')).toHaveLength(1)
    })

    it('formats json body type messages correctly', async () => {
      const msg = await createMessage({ text: 'What does that mean?' }, 'Confused Cat', new Date(), false, 'json', [
        'dm-cat'
      ])
      const reply = await createMessage({ text: 'Let me clarify.' }, 'Assistant', new Date(), true, 'json', ['dm-cat'])

      const result = formatDmHistoryByChannel([msg, reply], ['dm-cat'])

      expect(result).toContain('Confused Cat: "What does that mean?"')
      expect(result).toContain('Assistant (to Confused Cat): "Let me clarify."')
    })

    it('uses "Participant" as fallback pseudonym when channel has only agent messages', async () => {
      const agentOnly = await createMessage('Just checking in.', 'Event Assistant', new Date(), true, 'text', ['dm-ghost'])

      const result = formatDmHistoryByChannel([agentOnly], ['dm-ghost'])

      expect(result).toContain('Assistant (to Participant):')
    })
  })
})
