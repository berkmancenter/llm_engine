import mongoose from 'mongoose'
import { Message } from '../../../src/models/index.js'
import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'

const owner = new mongoose.Types.ObjectId()
const conversation = new mongoose.Types.ObjectId()
const ownerPseudo = new mongoose.Types.ObjectId()

describe('Get Conversation History Tests', () => {
  async function createMessage(body, pseudonym, updatedAt: Date = new Date(), source?, channels?) {
    const msg = new Message({
      _id: new mongoose.Types.ObjectId(),
      body,
      conversation,
      owner,
      channels,
      pseudonymId: ownerPseudo,
      pseudonym,
      source,
      updatedAt
    })
    return msg
  }

  it('should get conversation history by count', async () => {
    const msg1 = await createMessage('I think AI should have rights if it demonstrates consciousness.', 'Pro AI Urban Woman')
    const msg2 = await createMessage(
      'But how do we define consciousness? Isn’t it just simulation?',
      'AI Curious College Student'
    )
    const msg3 = await createMessage('Are you breathing?', 'Pro AI Urban Woman')
    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 2 })

    // Just the two most recent messages should be returned
    expect(convHistory.messages).toEqual([msg2, msg3])
    expect(convHistory.end).toBeDefined()
    expect(convHistory.start).toEqual(msg2.updatedAt)
  })

  it('should get conversation history by time', async () => {
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
    const convHistory = getConversationHistory([msg1, msg2, msg3, msg4], { timeWindow: 80 })
    // Just the last two message should be returned
    expect(convHistory.messages).toEqual([msg3, msg4])
    expect(convHistory.end).toBeDefined()
    // Not setting an end time, so can't precisely know what this will be, but should be close to this
    expect(convHistory.start.getTime()).toBeLessThanOrEqual(Date.now() - 79 * 1000)
  })

  it('should get conversation history by time and count', async () => {
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

    // making the assumption it doesn't take 20 seconds or more to get to the time check
    const convHistory = getConversationHistory([msg1, msg2, msg3], { timeWindow: 110, count: 1 })
    // Just the one message should be returned
    expect(convHistory.messages).toEqual([msg3])
    expect(convHistory.end).toBeDefined()
    expect(convHistory.start.getTime()).toBeLessThanOrEqual(Date.now() - 109 * 1000)
  })

  it('should get conversation history by endTime only', async () => {
    const baseTime = new Date('2024-01-01T12:00:00Z')
    const msg1 = await createMessage(
      'I think AI should have rights if it demonstrates consciousness.',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime() - 120 * 1000) // 2 minutes before baseTime
    )
    const msg2 = await createMessage(
      "But how do we define consciousness? Isn't it just simulation?",
      'AI Curious College Student',
      new Date(baseTime.getTime() - 60 * 1000) // 1 minute before baseTime
    )
    const msg3 = await createMessage(
      'Are you breathing?',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime()) // exactly at baseTime
    )
    const msg4 = await createMessage(
      'There must be more to it than that',
      'AI Curious College Student',
      new Date(baseTime.getTime() + 60 * 1000) // 1 minute after baseTime
    )

    const convHistory = getConversationHistory([msg1, msg2, msg3, msg4], {
      endTime: baseTime
    })

    // Should only include messages before or at endTime
    expect(convHistory.messages).toEqual([msg1, msg2, msg3])
    expect(convHistory.end).toEqual(baseTime)
    expect(convHistory.start).toEqual(msg1.updatedAt)
  })

  it('should format conversation history by endTime and count', async () => {
    const baseTime = new Date('2024-01-01T12:00:00Z')
    const msg1 = await createMessage(
      'I think AI should have rights if it demonstrates consciousness.',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime() - 120 * 1000)
    )
    const msg2 = await createMessage(
      "But how do we define consciousness? Isn't it just simulation?",
      'AI Curious College Student',
      new Date(baseTime.getTime() - 60 * 1000)
    )
    const msg3 = await createMessage('Are you breathing?', 'Pro AI Urban Woman', new Date(baseTime.getTime()))
    const msg4 = await createMessage(
      'There must be more to it than that',
      'AI Curious College Student',
      new Date(baseTime.getTime() + 60 * 1000)
    )

    const convHistory = getConversationHistory([msg1, msg2, msg3, msg4], {
      endTime: baseTime,
      count: 2
    })

    // Should include only 2 most recent messages before or at endTime
    expect(convHistory.messages).toEqual([msg2, msg3])
    expect(convHistory.end).toEqual(baseTime)
    expect(convHistory.start).toEqual(msg2.updatedAt)
  })

  it('should format conversation history by endTime and timeWindow', async () => {
    const baseTime = new Date('2024-01-01T12:00:00Z')
    const msg1 = await createMessage(
      'I think AI should have rights if it demonstrates consciousness.',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime() - 120 * 1000) // 2 minutes before
    )
    const msg2 = await createMessage(
      "But how do we define consciousness? Isn't it just simulation?",
      'AI Curious College Student',
      new Date(baseTime.getTime() - 90 * 1000) // 1.5 minutes before
    )
    const msg3 = await createMessage(
      'Are you breathing?',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime() - 30 * 1000) // 30 seconds before
    )
    const msg4 = await createMessage(
      'There must be more to it than that',
      'AI Curious College Student',
      new Date(baseTime.getTime() + 60 * 1000) // 1 minute after
    )

    const convHistory = getConversationHistory([msg1, msg2, msg3, msg4], {
      endTime: baseTime,
      timeWindow: 60 // 60 seconds
    })

    // Should include messages within 60 seconds before endTime
    expect(convHistory.messages).toEqual([msg3])
    expect(convHistory.end).toEqual(baseTime)
    expect(convHistory.start.getTime()).toEqual(baseTime.getTime() - 60 * 1000)
  })

  it('should format conversation history by endTime, timeWindow, and count', async () => {
    const baseTime = new Date('2024-01-01T12:00:00Z')
    const msg1 = await createMessage(
      'First message',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime() - 90 * 1000) // 1.5 minutes before
    )
    const msg2 = await createMessage(
      'Second message',
      'AI Curious College Student',
      new Date(baseTime.getTime() - 70 * 1000) // 70 seconds before
    )
    const msg3 = await createMessage(
      'Third message',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime() - 50 * 1000) // 50 seconds before
    )
    const msg4 = await createMessage(
      'Fourth message',
      'AI Curious College Student',
      new Date(baseTime.getTime() - 30 * 1000) // 30 seconds before
    )
    const msg5 = await createMessage(
      'Fifth message',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime() + 30 * 1000) // 30 seconds after
    )

    const convHistory = getConversationHistory([msg1, msg2, msg3, msg4, msg5], {
      endTime: baseTime,
      timeWindow: 80, // 80 seconds
      count: 2
    })

    // Should include only 2 most recent messages within 80 seconds before endTime
    expect(convHistory.messages).toEqual([msg3, msg4])
    expect(convHistory.end).toEqual(baseTime)
    expect(convHistory.start.getTime()).toEqual(baseTime.getTime() - 80 * 1000)
  })

  it('should handle endTime with no qualifying messages', async () => {
    const baseTime = new Date('2024-01-01T12:00:00Z')
    const msg1 = await createMessage(
      'Future message 1',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime() + 60 * 1000) // 1 minute after
    )
    const msg2 = await createMessage(
      'Future message 2',
      'AI Curious College Student',
      new Date(baseTime.getTime() + 120 * 1000) // 2 minutes after
    )

    const convHistory = getConversationHistory([msg1, msg2], {
      endTime: baseTime
    })

    expect(convHistory.messages).toHaveLength(0)
    expect(convHistory.end).toEqual(baseTime)
    expect(convHistory.start).toBeUndefined()
  })

  it('should handle endTime at exact message timestamp', async () => {
    const baseTime = new Date('2024-01-01T12:00:00Z')
    const msg1 = await createMessage('Before endTime', 'Pro AI Urban Woman', new Date(baseTime.getTime() - 60 * 1000))
    const msg2 = await createMessage(
      'At exact endTime',
      'AI Curious College Student',
      baseTime // Exactly at endTime
    )
    const msg3 = await createMessage('After endTime', 'Pro AI Urban Woman', new Date(baseTime.getTime() + 60 * 1000))

    const convHistory = getConversationHistory([msg1, msg2, msg3], {
      endTime: baseTime
    })

    // Should include messages before and at endTime, but not after
    expect(convHistory.messages).toEqual([msg1, msg2])
    expect(convHistory.end).toEqual(baseTime)
    expect(convHistory.start).toEqual(msg1.updatedAt)
  })

  it('should handle endTime with timeWindow extending beyond message range', async () => {
    const baseTime = new Date('2024-01-01T12:00:00Z')
    const msg1 = await createMessage(
      'Only message',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime() - 30 * 1000) // 30 seconds before
    )

    const convHistory = getConversationHistory([msg1], {
      endTime: baseTime,
      timeWindow: 3600 // 1 hour window
    })

    // Should include the message even though timeWindow is much larger
    expect(convHistory.messages).toEqual([msg1])
    expect(convHistory.end).toEqual(baseTime)
    expect(convHistory.start.getTime()).toEqual(baseTime.getTime() - 3600 * 1000)
  })
  it('should format messages when input parsing function provided', async () => {
    const baseTime = new Date('2024-01-01T12:00:00Z')
    const msg1 = await createMessage(
      'I think AI should have rights if it demonstrates consciousness.',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime() - 120 * 1000), // 2 minutes before baseTime
      'zoom'
    )
    const msg2 = await createMessage(
      "But how do we define consciousness? Isn't it just simulation?",
      'AI Curious College Student',
      new Date(baseTime.getTime() - 60 * 1000) // 1 minute before baseTime
    )
    const msg3 = await createMessage(
      'Are you breathing?',
      'Pro AI Urban Woman',
      new Date(baseTime.getTime()),
      'slack' // exactly at baseTime
    )
    const msg4 = await createMessage(
      'There must be more to it than that',
      'AI Curious College Student',
      new Date(baseTime.getTime() + 60 * 1000) // 1 minute after baseTime
    )

    const convHistory = getConversationHistory(
      [msg1, msg2, msg3, msg4],
      {
        endTime: baseTime
      },
      undefined,
      undefined,
      (msg) => {
        const translatedMsg = { ...msg }
        translatedMsg.body = 'Scooby Doo'
        return translatedMsg
      }
    )

    expect(convHistory.messages).toHaveLength(3)
    expect(convHistory.messages[0].body).toEqual('Scooby Doo')
    expect(convHistory.messages[1].body).toEqual('Scooby Doo')
    expect(convHistory.messages[2].body).toEqual('Scooby Doo')
    expect(convHistory.start).toEqual(msg1.updatedAt)
  })

  it('should include all messages when includeAgents is not provided', async () => {
    const msg1 = await createMessage('Human message', 'Human User')
    const msg2 = await createMessage('Agent message', 'AI Assistant')
    msg2.fromAgent = true
    msg2.pseudonym = 'AI Assistant'

    const msg3 = await createMessage('Another human message', 'Human User 2')

    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 10 })

    // All messages should be included when includeAgents is not provided
    expect(convHistory.messages).toEqual([msg1, msg2, msg3])
  })

  it('should filter out agent messages when includeAgents is empty array', async () => {
    const msg1 = await createMessage('Human message', 'Human User')
    const msg2 = await createMessage('Agent message', 'AI Assistant')
    msg2.fromAgent = true
    msg2.pseudonym = 'AI Assistant'

    const msg3 = await createMessage('Another agent message', 'Bot Helper')
    msg3.fromAgent = true
    msg3.pseudonym = 'Bot Helper'

    const msg4 = await createMessage('Another human message', 'Human User 2')

    const convHistory = getConversationHistory([msg1, msg2, msg3, msg4], { count: 10 }, [])

    // Only non-agent messages should be included
    expect(convHistory.messages).toEqual([msg1, msg4])
  })

  it('should include only specified agents when includeAgents contains agent names', async () => {
    const msg1 = await createMessage('Human message', 'Human User')

    const msg2 = await createMessage('AI Assistant message', 'AI Assistant')
    msg2.fromAgent = true
    msg2.pseudonym = 'AI Assistant'

    const msg3 = await createMessage('Bot Helper message', 'Bot Helper')
    msg3.fromAgent = true
    msg3.pseudonym = 'Bot Helper'

    const msg4 = await createMessage('Code Assistant message', 'Code Assistant')
    msg4.fromAgent = true
    msg4.pseudonym = 'Code Assistant'

    const msg5 = await createMessage('Another human message', 'Human User 2')

    const convHistory = getConversationHistory([msg1, msg2, msg3, msg4, msg5], { count: 10 }, [
      'AI Assistant',
      'Code Assistant'
    ])

    // Should include human messages and only specified agent messages
    expect(convHistory.messages).toEqual([msg1, msg2, msg4, msg5])
    expect(convHistory.messages).not.toContain(msg3) // Bot Helper should be excluded
  })

  it('should include agent messages when agent pseudonym matches includeAgents', async () => {
    const msg1 = await createMessage('Agent message 1', 'Helpful Assistant')
    msg1.fromAgent = true
    msg1.pseudonym = 'Helpful Assistant'

    const msg2 = await createMessage('Agent message 2', 'Helpful Assistant')
    msg2.fromAgent = true
    msg2.pseudonym = 'Helpful Assistant'

    const msg3 = await createMessage('Different agent message', 'Other Assistant')
    msg3.fromAgent = true
    msg3.pseudonym = 'Other Assistant'

    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 10 }, ['Helpful Assistant'])

    // Should only include messages from 'Helpful Assistant'
    expect(convHistory.messages).toEqual([msg1, msg2])
    expect(convHistory.messages).not.toContain(msg3)
  })

  it('should handle messages without fromAgent property', async () => {
    const msg1 = await createMessage('Human message', 'Human User')
    // msg1.fromAgent is undefined by default

    const msg2 = await createMessage('Agent message', 'AI Assistant')
    msg2.fromAgent = true
    msg2.pseudonym = 'AI Assistant'

    const msg3 = await createMessage('Another human message', 'Human User 2')
    // msg3.fromAgent is undefined by default

    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 10 }, ['AI Assistant'])

    // Should include messages without fromAgent property and specified agent
    expect(convHistory.messages).toEqual([msg1, msg2, msg3])
  })

  it('should handle messages with fromAgent=false', async () => {
    const msg1 = await createMessage('Human message', 'Human User')
    msg1.fromAgent = false

    const msg2 = await createMessage('Agent message', 'AI Assistant')
    msg2.fromAgent = true
    msg2.pseudonym = 'AI Assistant'

    const msg3 = await createMessage('Another human message', 'Human User 2')
    msg3.fromAgent = false

    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 10 }, ['AI Assistant'])

    // Should include messages with fromAgent=false and specified agent
    expect(convHistory.messages).toEqual([msg1, msg2, msg3])
  })

  it('should work with includeAgents combined with other filters', async () => {
    const baseTime = new Date('2024-01-01T12:00:00Z')

    const msg1 = await createMessage(
      'Old human message',
      'Human User',
      new Date(baseTime.getTime() - 120 * 1000) // 2 minutes before
    )

    const msg2 = await createMessage(
      'Old agent message',
      'AI Assistant',
      new Date(baseTime.getTime() - 90 * 1000) // 1.5 minutes before
    )
    msg2.fromAgent = true
    msg2.pseudonym = 'AI Assistant'

    const msg3 = await createMessage(
      'Recent human message',
      'Human User',
      new Date(baseTime.getTime() - 30 * 1000) // 30 seconds before
    )

    const msg4 = await createMessage(
      'Recent agent message',
      'Bot Helper',
      new Date(baseTime.getTime() - 15 * 1000) // 15 seconds before
    )
    msg4.fromAgent = true
    msg4.pseudonym = 'Bot Helper'

    const convHistory = getConversationHistory(
      [msg1, msg2, msg3, msg4],
      {
        endTime: baseTime,
        timeWindow: 60, // 60 seconds
        count: 3
      },
      ['AI Assistant'] // Only include AI Assistant agent
    )

    // Should only include msg3 (recent human message)
    // msg4 is filtered out by includeAgents (Bot Helper not included)
    // msg1 and msg2 are filtered out by timeWindow
    expect(convHistory.messages).toEqual([msg3])
  })

  it('should handle case where no agents match includeAgents filter', async () => {
    const msg1 = await createMessage('Human message', 'Human User')

    const msg2 = await createMessage('Agent message', 'AI Assistant')
    msg2.fromAgent = true
    msg2.pseudonym = 'AI Assistant'

    const msg3 = await createMessage('Another agent message', 'Bot Helper')
    msg3.fromAgent = true
    msg3.pseudonym = 'Bot Helper'

    const convHistory = getConversationHistory([msg1, msg2, msg3], { count: 10 }, ['Nonexistent agent'])

    // Should only include human messages since no agents match the filter
    expect(convHistory.messages).toEqual([msg1])
  })

  it('should handle empty messages array with includeAgents', async () => {
    const convHistory = getConversationHistory([], { count: 10 }, ['AI Assistant'])

    expect(convHistory.messages).toEqual([])
    expect(convHistory.start).toBeUndefined()
    expect(convHistory.end).toBeDefined()
  })
  it('includes only messages from specified channels', async () => {
    const msg1 = await createMessage('Human message', 'Human User', undefined, undefined, ['general', 'foo'])

    const msg2 = await createMessage('Agent message', 'AI Assistant', undefined, undefined, ['random'])
    const settings = {
      channels: ['general'],
      directMessages: false
    }

    const result = getConversationHistory([msg1, msg2], settings, undefined, [{ name: 'general', direct: false }])
    expect(result.messages).toEqual([msg1])
  })

  it('includes direct messages ', async () => {
    const msg1 = await createMessage('Human message', 'Human User')

    const msg2 = await createMessage('Agent message', 'AI Assistant', undefined, undefined, ['direct-agents-user1'])

    const msg3 = await createMessage('Another message', 'Human User', undefined, undefined, ['general'])
    const settings = {
      channels: [],
      directMessages: true
    }

    const result = getConversationHistory([msg1, msg2, msg3], settings, undefined, ['direct-agents-user1'])
    expect(result.messages).toEqual([msg2])
  })
  it('includes specified channels and direct messages ', async () => {
    const msg1 = await createMessage('Human message', 'Human User')

    const msg2 = await createMessage('Agent message', 'AI Assistant', undefined, undefined, ['direct-agents-user1'])

    const msg3 = await createMessage('Another message', 'Human User', undefined, undefined, ['general'])
    const settings = {
      channels: ['general'],
      directMessages: true
    }

    const result = getConversationHistory([msg1, msg2, msg3], settings, undefined, ['direct-agents-user1'])
    expect(result.messages).toEqual([msg2, msg3])
  })
})
