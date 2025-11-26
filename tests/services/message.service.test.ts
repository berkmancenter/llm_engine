import faker from 'faker'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { newPublicTopic, insertTopics } from '../fixtures/topic.fixture.js'
import { conversationOne, insertChannels } from '../fixtures/conversation.fixture.js'
import { messageOne, insertMessages } from '../fixtures/message.fixture.js'
import { messageService } from '../../src/services/index.js'
import Adapter, { setAdapterTypes } from '../../src/models/adapter.model.js'
import Channel from '../../src/models/channel.model.js'
import defaultAdapterTypes from '../../src/adapters/index.js'
import { User, Message, Conversation } from '../../src/models/index.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import { Direction } from '../../src/types/index.types.js'

setupIntTest()
jest.setTimeout(120000)

let publicTopic
let testMessage
let testConversation
let zoomAdapter
let slackAdapter
let testUser
let testZoomChannel
let testSlackChannel

const mockSendSlackMessage = jest.fn()
const mockSendZoomMessage = jest.fn()

const testAdapterTypes = {
  slack: {
    sendMessage: mockSendSlackMessage
  },
  zoom: {
    sendMessage: mockSendZoomMessage
  }
}

async function createUser(pseudonym) {
  return User.create({
    _id: new mongoose.Types.ObjectId(),
    username: faker.name.findName(),
    email: faker.internet.email().toLowerCase(),
    password: 'password1',
    role: 'user',
    isEmailVerified: false,
    pseudonyms: [
      {
        _id: new mongoose.Types.ObjectId(),
        token: '31c5d2b7d2b0f86b2b4b204',
        pseudonym,
        active: 'true'
      }
    ]
  })
}

describe('Message service methods', () => {
  describe('fetchConversation()', () => {
    test('should return the conversation with messages sorted by createdAt ascending', async () => {
      // Create a user and conversation
      const user = await createUser('Fetch Tester')

      const conversationData = {
        ...conversationOne,
        owner: user._id
      }
      delete conversationData._id

      const conversation = await Conversation.create(conversationData)

      // Create messages with out-of-order createdAt
      const now = new Date()

      await Message.create({
        body: 'Third message',
        bodyType: 'text',
        conversation: conversation._id,
        owner: user._id,
        pseudonym: user.pseudonyms[0].pseudonym,
        pseudonymId: user.pseudonyms[0]._id,
        channels: [],
        createdAt: new Date(now.getTime() + 3000)
      })
      await Message.create({
        body: 'Second message',
        bodyType: 'text',
        conversation: conversation._id,
        owner: user._id,
        pseudonym: user.pseudonyms[0].pseudonym,
        pseudonymId: user.pseudonyms[0]._id,
        channels: [],
        createdAt: new Date(now.getTime() + 1000)
      })
      await Message.create({
        body: 'First message',
        bodyType: 'text',
        conversation: conversation._id,
        owner: user._id,
        pseudonym: user.pseudonyms[0].pseudonym,
        pseudonymId: user.pseudonyms[0]._id,
        channels: [],
        createdAt: new Date(now.getTime() + 2000)
      })

      // Prepare messageBody for fetchConversation
      const messageBody = { conversation: conversation._id }

      // Call fetchConversation
      const result = await messageService.fetchConversation(messageBody, user)

      expect(result).toBeDefined()
      expect(result._id.toString()).toBe(conversation._id.toString())
      expect(Array.isArray(result.messages)).toBe(true)
      expect(result.messages).toHaveLength(3)

      // Check that messages are sorted by createdAt ascending
      const createdAts = result.messages.map((m) => new Date(m.createdAt).getTime())
      const sorted = [...createdAts].sort((a, b) => a - b)
      expect(createdAts).toEqual(sorted)

      // Check that all expected fields are present
      result.messages.forEach((msg) => {
        expect(msg).toHaveProperty('body')
        expect(msg).toHaveProperty('bodyType')
        expect(msg).toHaveProperty('createdAt')
        expect(msg).toHaveProperty('owner')
        expect(msg).toHaveProperty('pseudonym')
        expect(msg).toHaveProperty('pseudonymId')
      })
    })
  })
  beforeAll(async () => {
    setAdapterTypes(testAdapterTypes)
  })

  beforeEach(async () => {
    jest.clearAllMocks()
    jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
    testUser = await createUser('Boring Badger')
    publicTopic = newPublicTopic()
    await insertTopics([publicTopic])
    testConversation = { ...conversationOne }
    testConversation.owner = testUser
    testConversation = await Conversation.create(testConversation)

    // Create adapters
    zoomAdapter = new Adapter({
      type: 'zoom',
      conversation: testConversation,
      active: true
    })
    await zoomAdapter.save()

    slackAdapter = new Adapter({
      type: 'slack',
      conversation: testConversation,
      active: true
    })
    await slackAdapter.save()

    // Create channels with adapters
    testZoomChannel = new Channel({
      name: 'zoom-channel',
      passcode: null
    })
    await testZoomChannel.save()

    testSlackChannel = new Channel({
      name: 'slack-channel',
      passcode: null
    })
    await testSlackChannel.save()

    // Add channels to conversation
    testConversation.channels = [testZoomChannel, testSlackChannel]
    testConversation.adapters = [zoomAdapter, slackAdapter]
    await testConversation.save()

    testMessage = {
      ...messageOne,
      conversation: testConversation._id,
      body: 'Test message',
      bodyType: 'text',
      channels: []
    }
  })

  afterAll(() => {
    setAdapterTypes(defaultAdapterTypes)
  })

  describe('newMessageHandler() - adapter message sending', () => {
    test('should send message through adapter with parseOutput function', async () => {
      testMessage.channels = [testZoomChannel]
      testMessage.body = {
        insights: [
          { value: 'First insight', comments: [{ user: 'user1', text: 'This is cool' }] },
          { value: 'Second insight' },
          { value: 'Third insight' }
        ]
      }
      testMessage.bodyType = 'json'
      testMessage.parseOutput = (msg) => {
        const translatedMsg = msg.toObject()
        translatedMsg.bodyType = 'text'
        translatedMsg.body = `**${msg.body.insights.map((insight) => insight.value).join('\\n')}**`
        return translatedMsg
      }

      zoomAdapter.chatChannels = [{ name: testZoomChannel.name, direction: Direction.OUTGOING }]
      await zoomAdapter.save()

      const result = await messageService.newMessageHandler(testMessage, testUser)

      expect(result).toBeDefined()
      expect(mockSendZoomMessage).toHaveBeenCalledTimes(1)

      // Verify the parseOutput transformation was applied
      const sentMessage = mockSendZoomMessage.mock.calls[0][0]
      expect(sentMessage.bodyType).toBe('text')
      expect(sentMessage.body).toBe('**First insight\\nSecond insight\\nThird insight**')
    })

    test('should send original message when no parseOutput function provided', async () => {
      testMessage.channels = [testZoomChannel]
      testMessage.body = 'Message without parser'

      zoomAdapter.chatChannels = [{ name: testZoomChannel.name, direction: Direction.OUTGOING }]
      await zoomAdapter.save()

      const result = await messageService.newMessageHandler(testMessage, testUser)

      expect(result).toBeDefined()
      expect(mockSendZoomMessage).toHaveBeenCalledTimes(1)

      const sentMessage = mockSendZoomMessage.mock.calls[0][0]
      expect(sentMessage.body).toBe('Message without parser')
      expect(sentMessage.bodyType).toBe('text')
    })

    test('should handle empty adapters array', async () => {
      testMessage.adapters = []
      testMessage.body = 'Message with no channels'

      const result = await messageService.newMessageHandler(testMessage, testUser)

      expect(result).toBeDefined()
      expect(mockSendZoomMessage).not.toHaveBeenCalled()
      expect(mockSendSlackMessage).not.toHaveBeenCalled()
    })

    test('should handle message without channels property', async () => {
      delete testMessage.channels
      testMessage.body = 'Message without channels property'

      const result = await messageService.newMessageHandler(testMessage, testUser)

      expect(result).toBeDefined()
      expect(mockSendZoomMessage).not.toHaveBeenCalled()
      expect(mockSendSlackMessage).not.toHaveBeenCalled()
    })

    test('should preserve message properties in parseOutput transformation', async () => {
      testMessage.body = 'Original message'
      testMessage.bodyType = 'text'
      testMessage.parseOutput = (msg) => {
        const translatedMsg = msg.toObject()
        translatedMsg.body = `Transformed: ${msg.body}`
        translatedMsg.customField = 'added by parser'
        return translatedMsg
      }
      testMessage.channels = [testZoomChannel]

      zoomAdapter.chatChannels = [{ name: testZoomChannel.name, direction: Direction.OUTGOING }]
      await zoomAdapter.save()

      const result = await messageService.newMessageHandler(testMessage, testUser)

      expect(result).toBeDefined()
      expect(mockSendZoomMessage).toHaveBeenCalledTimes(1)

      const sentMessage = mockSendZoomMessage.mock.calls[0][0]
      expect(sentMessage.body).toBe('Transformed: Original message')
      expect(sentMessage.customField).toBe('added by parser')
      expect(sentMessage.bodyType).toBe('text')
      expect(sentMessage.owner).toBeDefined()
      expect(sentMessage.conversation).toBeDefined()
    })

    test('should handle direct channel messaging when DMs are enabled', async () => {
      // Enable DMs for agents in conversation
      testConversation.enableDMs = ['agents']
      await testConversation.save()

      const directChannel = new Channel({
        name: 'direct-channel',
        passcode: null,
        direct: true,
        participants: [testUser._id, new mongoose.Types.ObjectId()]
      })
      await directChannel.save()
      testConversation.channels.push(directChannel)
      await testConversation.save()

      testMessage.channels = [directChannel]
      testMessage.body = 'Direct message'

      zoomAdapter.dmChannels = [{ name: directChannel.name, direction: Direction.BOTH }]
      await zoomAdapter.save()

      const result = await messageService.newMessageHandler(testMessage, testUser)

      expect(result).toBeDefined()
      expect(mockSendZoomMessage).toHaveBeenCalledTimes(1)

      const sentMessage = mockSendZoomMessage.mock.calls[0][0]
      expect(sentMessage.body).toBe('Direct message')
    })
  })

  describe('duplicateConversationMessages()', () => {
    let sourceConversation
    let targetConversation

    beforeEach(async () => {
      // Create source conversation with messages
      sourceConversation = { ...testConversation.toObject() }

      await Channel.deleteMany()
      const channels = await insertChannels(testConversation.channels)

      // Create target conversation
      targetConversation = await Conversation.create({
        name: 'Target Conversation',
        owner: testUser._id,
        topic: publicTopic._id,
        channels
      })

      // Add some test messages to source conversation
      const message1 = {
        body: 'Source message 1',
        bodyType: 'text',
        conversation: sourceConversation._id,
        owner: testUser._id,
        pseudonym: testUser.pseudonyms[0].pseudonym,
        pseudonymId: testUser.pseudonyms[0]._id,
        channels: ['participant']
      }

      const message2 = {
        body: 'Source message 2',
        bodyType: 'text',
        conversation: sourceConversation._id,
        owner: testUser._id,
        pseudonym: testUser.pseudonyms[0].pseudonym,
        pseudonymId: testUser.pseudonyms[0]._id,
        channels: ['moderator']
      }

      await insertMessages([message1, message2])

      // Refresh source conversation with populated messages
      sourceConversation = await Conversation.findById(sourceConversation._id).populate(['channels', 'messages'])
    })

    test('should duplicate messages from one conversation to another using conversation objects', async () => {
      // Verify target conversation has no messages initially
      const initialTargetMessages = await Message.find({ conversation: targetConversation._id })
      expect(initialTargetMessages).toHaveLength(0)

      // Duplicate messages
      await messageService.duplicateConversationMessages(sourceConversation, targetConversation)

      // Verify messages were duplicated
      const duplicatedMessages = await Message.find({ conversation: targetConversation._id })
      expect(duplicatedMessages).toHaveLength(sourceConversation.messages.length)

      // Verify message content was duplicated correctly
      const sourceMessageBodies = sourceConversation.messages.map((msg) => msg.body).sort()
      const duplicatedMessageBodies = duplicatedMessages.map((msg) => msg.body).sort()
      expect(duplicatedMessageBodies).toEqual(sourceMessageBodies)

      // Verify messages have the correct conversation ID
      duplicatedMessages.forEach((msg) => {
        expect(msg.conversation.toString()).toBe(targetConversation._id.toString())
      })
    })

    test('should duplicate messages using conversation IDs', async () => {
      // Duplicate messages using IDs instead of objects
      await messageService.duplicateConversationMessages(sourceConversation._id, targetConversation._id)

      // Verify messages were duplicated
      const duplicatedMessages = await Message.find({ conversation: targetConversation._id })
      expect(duplicatedMessages).toHaveLength(sourceConversation.messages.length)

      // Verify message content was duplicated correctly
      const sourceMessageBodies = sourceConversation.messages.map((msg) => msg.body).sort()
      const duplicatedMessageBodies = duplicatedMessages.map((msg) => msg.body).sort()
      expect(duplicatedMessageBodies).toEqual(sourceMessageBodies)
    })

    test('should preserve message properties when duplicating', async () => {
      // Add a message with various properties
      const complexMessage = {
        body: { complex: 'data', with: ['arrays', 'and', 'objects'] },
        bodyType: 'json',
        conversation: sourceConversation._id,
        owner: testUser._id,
        pseudonym: testUser.pseudonyms[0].pseudonym,
        pseudonymId: testUser.pseudonyms[0]._id,
        channels: ['participant'],
        fromAgent: true,
        source: 'test-source'
      }

      await insertMessages([complexMessage])
      sourceConversation = await Conversation.findById(sourceConversation._id).populate(['channels', 'messages'])

      // Duplicate messages
      await messageService.duplicateConversationMessages(sourceConversation, targetConversation)

      // Find the duplicated complex message
      const duplicatedComplexMessage = await Message.findOne({
        conversation: targetConversation._id,
        bodyType: 'json',
        source: 'test-source'
      })

      // Verify properties were preserved
      expect(duplicatedComplexMessage).toBeDefined()
      expect(duplicatedComplexMessage?.body).toEqual(complexMessage.body)
      expect(duplicatedComplexMessage?.bodyType).toBe(complexMessage.bodyType)
      expect(duplicatedComplexMessage?.channels).toEqual(complexMessage.channels)
      expect(duplicatedComplexMessage?.fromAgent).toBe(complexMessage.fromAgent)
      expect(duplicatedComplexMessage?.source).toBe(complexMessage.source)
      expect(duplicatedComplexMessage?.pseudonym).toBe(complexMessage.pseudonym)
      expect(duplicatedComplexMessage?.owner?.toString()).toBe(testUser._id.toString())
    })

    test('should duplicate only messages matching the query when messageQuery is provided', async () => {
      // Add messages with different sources
      const message1 = {
        body: 'Message with source1',
        bodyType: 'text',
        conversation: sourceConversation._id,
        owner: testUser._id,
        pseudonym: testUser.pseudonyms[0].pseudonym,
        pseudonymId: testUser.pseudonyms[0]._id,
        channels: ['participant'],
        source: 'source1'
      }

      const message2 = {
        body: 'Message with source2',
        bodyType: 'text',
        conversation: sourceConversation._id,
        owner: testUser._id,
        pseudonym: testUser.pseudonyms[0].pseudonym,
        pseudonymId: testUser.pseudonyms[0]._id,
        channels: ['participant'],
        source: 'source2'
      }

      await insertMessages([message1, message2])
      sourceConversation = await Conversation.findById(sourceConversation._id).populate(['channels', 'messages'])

      // Duplicate only messages with source1
      await messageService.duplicateConversationMessages(sourceConversation, targetConversation, { source: 'source1' })

      // Verify only messages with source1 were duplicated
      const duplicatedMessages = await Message.find({ conversation: targetConversation._id })
      const source1Messages = duplicatedMessages.filter((msg) => msg.source === 'source1')
      const source2Messages = duplicatedMessages.filter((msg) => msg.source === 'source2')

      expect(source1Messages.length).toBeGreaterThan(0)
      expect(source2Messages).toHaveLength(0)
    })

    test('should duplicate all messages when messageQuery is an empty object', async () => {
      // Clear target conversation messages
      await Message.deleteMany({ conversation: targetConversation._id })

      // Add messages with different sources
      const message1 = {
        body: 'Another message with source1',
        bodyType: 'text',
        conversation: sourceConversation._id,
        owner: testUser._id,
        pseudonym: testUser.pseudonyms[0].pseudonym,
        pseudonymId: testUser.pseudonyms[0]._id,
        channels: ['participant'],
        source: 'source1'
      }

      const message2 = {
        body: 'Another message with source2',
        bodyType: 'text',
        conversation: sourceConversation._id,
        owner: testUser._id,
        pseudonym: testUser.pseudonyms[0].pseudonym,
        pseudonymId: testUser.pseudonyms[0]._id,
        channels: ['participant'],
        source: 'source2'
      }

      await insertMessages([message1, message2])
      sourceConversation = await Conversation.findById(sourceConversation._id).populate(['channels', 'messages'])

      // Count source messages
      const sourceMessageCount = await Message.countDocuments({ conversation: sourceConversation._id })

      // Duplicate all messages with empty query
      await messageService.duplicateConversationMessages(sourceConversation, targetConversation, {})

      // Verify all messages were duplicated
      const duplicatedMessageCount = await Message.countDocuments({ conversation: targetConversation._id })
      expect(duplicatedMessageCount).toBe(sourceMessageCount)

      // Verify both source types are present
      const source1Count = await Message.countDocuments({ conversation: targetConversation._id, source: 'source1' })
      const source2Count = await Message.countDocuments({ conversation: targetConversation._id, source: 'source2' })
      expect(source1Count).toBeGreaterThan(0)
      expect(source2Count).toBeGreaterThan(0)
    })
  })

  describe('getMessageReplies()', () => {
    let parentMessage
    let user1
    let user2

    beforeEach(async () => {
      user1 = await createUser('Reply Tester')
      user2 = await createUser('Another Replier')

      // Create a parent message
      parentMessage = await Message.create({
        body: 'Parent message for testing replies',
        bodyType: 'text',
        conversation: testConversation._id,
        owner: user1._id,
        pseudonym: user1.pseudonyms[0].pseudonym,
        pseudonymId: user1.pseudonyms[0]._id,
        channels: ['participant']
      })

      // Create some reply messages
      await Message.create(
        [
          {
            body: 'First reply',
            bodyType: 'text',
            conversation: testConversation._id,
            owner: user2._id,
            pseudonym: user2.pseudonyms[0].pseudonym,
            pseudonymId: user2.pseudonyms[0]._id,
            channels: ['participant'],
            parentMessage: parentMessage._id,
            createdAt: new Date(Date.now() - 3000)
          },
          {
            body: 'Second reply',
            bodyType: 'text',
            conversation: testConversation._id,
            owner: user1._id,
            pseudonym: user1.pseudonyms[0].pseudonym,
            pseudonymId: user1.pseudonyms[0]._id,
            channels: ['participant'],
            parentMessage: parentMessage._id,
            createdAt: new Date(Date.now() - 2000)
          },
          {
            body: 'Reply with source',
            bodyType: 'text',
            conversation: testConversation._id,
            owner: user2._id,
            pseudonym: user2.pseudonyms[0].pseudonym,
            pseudonymId: user2.pseudonyms[0]._id,
            channels: ['participant'],
            parentMessage: parentMessage._id,
            source: 'test-source',
            createdAt: new Date(Date.now() - 1000)
          }
        ],
        { ordered: true }
      )
    })

    test('should get all replies for a message without query', async () => {
      const replies = await messageService.getMessageReplies(parentMessage._id)

      expect(replies).toBeDefined()
      expect(replies).toHaveLength(3)

      // Verify replies are sorted by createdAt
      expect(replies[0].body).toBe('First reply')
      expect(replies[1].body).toBe('Second reply')
      expect(replies[2].body).toBe('Reply with source')

      // Verify all replies have the correct parent message
      replies.forEach((reply) => {
        expect(reply?.parentMessage?.toString()).toBe(parentMessage._id.toString())
      })
    })

    test('should filter replies using messageQuery parameter', async () => {
      // Get only replies with a specific source
      const filteredReplies = await messageService.getMessageReplies(parentMessage._id, { source: 'test-source' })

      expect(filteredReplies).toBeDefined()
      expect(filteredReplies).toHaveLength(1)
      expect(filteredReplies[0].body).toBe('Reply with source')
      expect(filteredReplies[0].source).toBe('test-source')

      // Get only replies from a specific user
      const userReplies = await messageService.getMessageReplies(parentMessage._id, { owner: user1._id })

      expect(userReplies).toBeDefined()
      expect(userReplies).toHaveLength(1)
      expect(userReplies[0].body).toBe('Second reply')
      expect(userReplies[0]?.owner?.toString()).toBe(user1._id.toString())
    })

    test('should return empty array for messages without replies', async () => {
      // Create a message without replies
      const messageWithoutReplies = await Message.create({
        body: 'Message with no replies',
        bodyType: 'text',
        conversation: testConversation._id,
        owner: user1._id,
        pseudonym: user1.pseudonyms[0].pseudonym,
        pseudonymId: user1.pseudonyms[0]._id,
        channels: ['participant']
      })

      const replies = await messageService.getMessageReplies(messageWithoutReplies._id)

      expect(replies).toBeDefined()
      expect(Array.isArray(replies)).toBe(true)
      expect(replies).toHaveLength(0)
    })

    test('should only return direct replies (not nested replies)', async () => {
      // Create a reply to a reply (nested reply)
      const firstReply = await Message.findOne({
        parentMessage: parentMessage._id,
        body: 'First reply'
      })

      await Message.create({
        body: 'Nested reply to first reply',
        bodyType: 'text',
        conversation: testConversation._id,
        owner: user1._id,
        pseudonym: user1.pseudonyms[0].pseudonym,
        pseudonymId: user1.pseudonyms[0]._id,
        channels: ['participant'],
        parentMessage: firstReply?._id
      })

      // Get replies to the parent message
      const parentReplies = await messageService.getMessageReplies(parentMessage._id)

      // Should still have only 3 direct replies
      expect(parentReplies).toHaveLength(3)

      // The nested reply should not be in the results
      const nestedReplyInResults = parentReplies.some((reply) => reply.body === 'Nested reply to first reply')
      expect(nestedReplyInResults).toBe(false)

      // But we should be able to get it when querying for replies to the first reply
      const nestedReplies = await messageService.getMessageReplies(firstReply?._id)
      expect(nestedReplies).toHaveLength(1)
      expect(nestedReplies[0].body).toBe('Nested reply to first reply')
    })
  })
})
