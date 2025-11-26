import faker from 'faker'
import setupIntTest from '../utils/setupIntTest.js'
import { insertUsers, userOne } from '../fixtures/user.fixture.js'
import { newPublicTopic, newPrivateTopic, insertTopics } from '../fixtures/topic.fixture.js'
import { topicService, emailService } from '../../src/services/index.js'
import Topic from '../../src/models/topic.model.js'
import { Token } from '../../src/models/index.js'
import { conversationOne, insertConversations } from '../fixtures/conversation.fixture.js'
import { messageOne, invisibleMessage, insertMessages } from '../fixtures/message.fixture.js'
import Conversation from '../../src/models/conversation.model.js'

setupIntTest()

let publicTopic
let privateTopic

beforeEach(() => {
  publicTopic = newPublicTopic()
  privateTopic = newPrivateTopic()
})

describe('Topic service methods', () => {
  describe('deleteOldTopics()', () => {
    // Set created date to 98 days ago
    let oldDate = ''
    beforeEach(() => {
      const d = new Date()
      d.setDate(d.getDate() - 98)
      oldDate = d.toISOString()
    })

    test('should delete topics older than 97 days with no recent messages', async () => {
      publicTopic.createdAt = oldDate
      const d = new Date()
      d.setDate(d.getDate() - 96)
      privateTopic.createdAt = d.toISOString()
      await insertTopics([publicTopic, privateTopic])

      const ret = await topicService.deleteOldTopics()
      expect(ret).toHaveLength(1)
      expect(ret[0]._id).toEqual(publicTopic._id)

      const dbPublicTopic = await Topic.findById(publicTopic._id)
      expect(dbPublicTopic!.isDeleted).toBe(true)

      const dbPrivateTopic = await Topic.findById(privateTopic._id)
      expect(dbPrivateTopic!.isDeleted).toBe(false)
    })

    test('should delete topics older than 97 days with no recent visible messages', async () => {
      publicTopic.createdAt = oldDate

      const d = new Date()
      d.setDate(d.getDate() - 96)
      privateTopic.createdAt = d.toISOString()

      await insertTopics([publicTopic, privateTopic])
      await insertConversations([conversationOne])
      invisibleMessage.conversation = conversationOne._id
      await insertMessages([invisibleMessage])

      let dbPublicTopic = await Topic.findById(publicTopic._id)
      dbPublicTopic!.conversations.push(conversationOne)
      await dbPublicTopic!.save()

      const dbConversationOne = await Conversation.findById(conversationOne._id).populate('messages').exec()
      dbConversationOne!.messages.push(invisibleMessage)
      await dbConversationOne!.save()

      const ret = await topicService.deleteOldTopics()
      expect(ret).toHaveLength(1)
      expect(ret[0]._id).toEqual(publicTopic._id)

      dbPublicTopic = await Topic.findById(publicTopic._id)
      expect(dbPublicTopic!.isDeleted).toBe(true)

      const dbPrivateTopic = await Topic.findById(privateTopic._id)
      expect(dbPrivateTopic!.isDeleted).toBe(false)
    })

    test('should not delete topics older than 97 days with recent messages', async () => {
      publicTopic.createdAt = oldDate

      const d = new Date()
      d.setDate(d.getDate() - 96)
      privateTopic.createdAt = d.toISOString()

      await insertTopics([publicTopic, privateTopic])
      await insertConversations([conversationOne])
      await insertMessages([messageOne])

      let dbPublicTopic = await Topic.findById(publicTopic._id)
      dbPublicTopic!.conversations.push(conversationOne)
      await dbPublicTopic!.save()

      const dbConversationOne = await Conversation.findById(conversationOne._id).populate('messages').exec()
      dbConversationOne!.messages.push(messageOne)
      await dbConversationOne!.save()

      const ret = await topicService.deleteOldTopics()
      expect(ret).toHaveLength(0)

      dbPublicTopic = await Topic.findById(publicTopic._id)
      expect(dbPublicTopic!.isDeleted).toBe(false)

      const dbPrivateTopic = await Topic.findById(privateTopic._id)
      expect(dbPrivateTopic!.isDeleted).toBe(false)
    })

    test('should not delete topics marked as archived and deleted', async () => {
      publicTopic.createdAt = oldDate
      privateTopic.createdAt = oldDate
      publicTopic.archived = true
      privateTopic.isDeleted = true

      await insertTopics([publicTopic, privateTopic])

      const ret = await topicService.deleteOldTopics()
      expect(ret).toHaveLength(0)

      const dbPublicTopic = await Topic.findById(publicTopic._id)
      expect(dbPublicTopic!.isDeleted).toBe(false)
    })
  })

  describe('emailUsersToArchive()', () => {
    // Set created date to 98 days ago
    let oldDate = ''
    beforeEach(async () => {
      const d = new Date()
      d.setDate(d.getDate() - 91)
      oldDate = d.toISOString()

      await insertUsers([userOne])
    })

    test('should generate token, email user, and mark as isArchiveNotified = true', async () => {
      jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue()
      const sendArchiveEmailSpy = jest.spyOn(emailService, 'sendArchiveTopicEmail')

      publicTopic.createdAt = oldDate
      const d = new Date()
      d.setDate(d.getDate() - 88)
      privateTopic.createdAt = d.toISOString()
      await insertTopics([publicTopic, privateTopic])

      const ret = await topicService.emailUsersToArchive()
      expect(ret).toHaveLength(1)
      expect(ret[0]._id).toEqual(publicTopic._id)

      expect(sendArchiveEmailSpy).toHaveBeenCalledWith(userOne.email, expect.any(Object), expect.any(String))
      const token = sendArchiveEmailSpy.mock.calls[0][3]
      const dbToken = await Token.findOne({ token })
      expect(dbToken).toBeDefined()

      const dbPublicTopic = await Topic.findById(publicTopic._id)
      expect(dbPublicTopic!.isArchiveNotified).toBe(true)
    })

    test('should not archive topic if topic has recent message activity', async () => {
      jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue()
      jest.spyOn(emailService, 'sendArchiveTopicEmail')

      publicTopic.createdAt = oldDate
      const d = new Date()
      d.setDate(d.getDate() - 88)
      privateTopic.createdAt = d.toISOString()

      await insertTopics([publicTopic, privateTopic])
      await insertConversations([conversationOne])
      await insertMessages([messageOne])

      let dbPublicTopic = await Topic.findById(publicTopic._id)
      dbPublicTopic!.conversations.push(conversationOne)
      await dbPublicTopic!.save()

      const dbConversationOne = await Conversation.findById(conversationOne._id).populate('messages').exec()
      dbConversationOne!.messages.push(messageOne)
      await dbConversationOne!.save()

      const ret = await topicService.emailUsersToArchive()
      expect(ret).toHaveLength(0)

      dbPublicTopic = await Topic.findById(publicTopic._id)
      expect(dbPublicTopic!.isArchiveNotified).toBe(false)

      const dbPrivateTopic = await Topic.findById(privateTopic._id)
      expect(dbPrivateTopic!.isArchiveNotified).toBe(false)
    })

    test('should archive topic if topic has no recent visible message activity', async () => {
      jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue()
      const sendArchiveEmailSpy = jest.spyOn(emailService, 'sendArchiveTopicEmail')

      publicTopic.createdAt = oldDate
      const d = new Date()
      d.setDate(d.getDate() - 88)
      privateTopic.createdAt = d.toISOString()

      await insertTopics([publicTopic, privateTopic])
      await insertConversations([conversationOne])
      invisibleMessage.conversation = conversationOne._id
      await insertMessages([invisibleMessage])

      let dbPublicTopic = await Topic.findById(publicTopic._id)
      dbPublicTopic!.conversations.push(conversationOne)
      await dbPublicTopic!.save()

      const dbConversationOne = await Conversation.findById(conversationOne._id).populate('messages').exec()
      dbConversationOne!.messages.push(invisibleMessage)
      await dbConversationOne!.save()

      const ret = await topicService.emailUsersToArchive()
      expect(ret).toHaveLength(1)
      expect(ret[0]._id).toEqual(publicTopic._id)

      expect(sendArchiveEmailSpy).toHaveBeenCalledWith(userOne.email, expect.any(Object), expect.any(String))
      const token = sendArchiveEmailSpy.mock.calls[0][3]
      const dbToken = await Token.findOne({ token })
      expect(dbToken).toBeDefined()

      dbPublicTopic = await Topic.findById(publicTopic._id)
      expect(dbPublicTopic!.isArchiveNotified).toBe(true)
    })

    test('should use topic-level email if it exists', async () => {
      jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue()
      const sendArchiveEmailSpy = jest.spyOn(emailService, 'sendArchiveTopicEmail')

      publicTopic.createdAt = oldDate
      const d = new Date()
      d.setDate(d.getDate() - 88)
      privateTopic.createdAt = d.toISOString()
      publicTopic.archiveEmail = faker.internet.email()
      await insertTopics([publicTopic, privateTopic])

      const ret = await topicService.emailUsersToArchive()
      expect(ret).toHaveLength(1)

      expect(sendArchiveEmailSpy).toHaveBeenCalledWith(publicTopic.archiveEmail, expect.any(Object), expect.any(String))
    })

    test('should not send email if topic is not archivable', async () => {
      publicTopic.createdAt = oldDate
      publicTopic.achivable = false

      await insertTopics([publicTopic])

      const ret = await topicService.deleteOldTopics()
      expect(ret).toHaveLength(0)

      const dbPublicTopic = await Topic.findById(publicTopic._id)
      expect(dbPublicTopic!.isArchiveNotified).toBe(false)
    })

    test('should not send email if email is already sent', async () => {
      publicTopic.createdAt = oldDate
      publicTopic.isArchiveNotified = true

      await insertTopics([publicTopic])

      const ret = await topicService.deleteOldTopics()
      expect(ret).toHaveLength(0)
    })

    test('should not send email if topic is deleted or archived', async () => {
      publicTopic.createdAt = oldDate
      privateTopic.createdAt = oldDate
      publicTopic.archived = true
      privateTopic.isDeleted = true

      await insertTopics([publicTopic, privateTopic])

      const ret = await topicService.deleteOldTopics()
      expect(ret).toHaveLength(0)

      const dbPublicTopic = await Topic.findById(publicTopic._id)
      expect(dbPublicTopic!.isArchiveNotified).toBe(false)

      const dbPrivateTopic = await Topic.findById(privateTopic._id)
      expect(dbPrivateTopic!.isArchiveNotified).toBe(false)
    })
  })
})
