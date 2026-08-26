import faker from 'faker'
import setupIntTest from '../utils/setupIntTest.js'
import { insertUsers, userOne, userTwo } from '../fixtures/user.fixture.js'
import { newPublicTopic, newPrivateTopic, insertTopics } from '../fixtures/topic.fixture.js'
import { topicService, emailService } from '../../src/services/index.js'
import Topic from '../../src/models/topic.model.js'
import { Token } from '../../src/models/index.js'
import { conversationOne, insertConversations } from '../fixtures/conversation.fixture.js'
import { messageOne, invisibleMessage, insertMessages } from '../fixtures/message.fixture.js'
import Conversation from '../../src/models/conversation.model.js'
import transcript from '../../src/agents/helpers/transcript.js'

setupIntTest()

let publicTopic
let privateTopic

beforeEach(() => {
  publicTopic = newPublicTopic()
  privateTopic = newPrivateTopic()
})

describe('Topic service methods', () => {
  describe('createTopic()', () => {
    let loadTopicMetadataSpy

    beforeEach(async () => {
      await insertUsers([userOne])
      loadTopicMetadataSpy = jest.spyOn(transcript, 'loadTopicMetadataIntoVectorStore').mockResolvedValue()
    })

    afterEach(() => {
      loadTopicMetadataSpy.mockRestore()
    })

    test('should persist description and call loadTopicMetadataIntoVectorStore', async () => {
      const topicBody = {
        name: 'Test Series',
        description: 'A series about testing distributed systems',
        votingAllowed: true,
        conversationCreationAllowed: true,
        private: false,
        archivable: true
      }

      const topic = await topicService.createTopic(topicBody, userOne)

      expect(topic.description).toBe(topicBody.description)
      expect(loadTopicMetadataSpy).toHaveBeenCalledWith(expect.objectContaining({ description: topicBody.description }))
    })

    test('should call loadTopicMetadataIntoVectorStore even when no description provided', async () => {
      const topicBody = {
        name: 'No Description Series',
        votingAllowed: true,
        conversationCreationAllowed: true,
        private: false,
        archivable: true
      }

      await topicService.createTopic(topicBody, userOne)

      expect(loadTopicMetadataSpy).toHaveBeenCalledTimes(1)
    })

    test('should set source when the caller provides one', async () => {
      const topicBody = {
        name: 'Email Series',
        votingAllowed: false,
        conversationCreationAllowed: false,
        private: true,
        archivable: false,
        source: 'email'
      }

      const topic = await topicService.createTopic(topicBody, userOne)

      expect(topic.source).toBe('email')
    })

    test('should leave source unset when the caller omits it', async () => {
      const topicBody = {
        name: 'Manually Created Series',
        votingAllowed: true,
        conversationCreationAllowed: true,
        private: false,
        archivable: true
      }

      const topic = await topicService.createTopic(topicBody, userOne)

      expect(topic.source).toBeUndefined()
    })
  })

  describe('findOrCreateEmailTopic()', () => {
    let loadTopicMetadataSpy

    beforeEach(async () => {
      await insertUsers([userOne, userTwo])
      loadTopicMetadataSpy = jest.spyOn(transcript, 'loadTopicMetadataIntoVectorStore').mockResolvedValue()
    })

    afterEach(() => {
      loadTopicMetadataSpy.mockRestore()
    })

    test('creates a private, source: email Topic named after the organizer on first call', async () => {
      const topic = await topicService.findOrCreateEmailTopic(userOne)

      expect(topic.name).toBe(`${userOne.username}'s emailed events`)
      expect(topic.private).toBe(true)
      expect(topic.votingAllowed).toBe(false)
      expect(topic.conversationCreationAllowed).toBe(false)
      expect(topic.archivable).toBe(false)
      expect(topic.source).toBe('email')
      expect(topic.owner.toString()).toBe(userOne._id.toString())
    })

    test('reuses createTopic: generates a passcode and loads topic metadata into the vector store', async () => {
      const topic = await topicService.findOrCreateEmailTopic(userOne)

      expect(topic.passcode).toEqual(expect.any(Number))
      expect(loadTopicMetadataSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: topic._id }))
    })

    test('returns the same Topic on a second call instead of creating a duplicate', async () => {
      const first = await topicService.findOrCreateEmailTopic(userOne)
      const second = await topicService.findOrCreateEmailTopic(userOne)

      expect(second._id.toString()).toBe(first._id.toString())
      expect(await Topic.countDocuments({ owner: userOne._id, source: 'email' })).toBe(1)
    })

    test("does not reuse another organizer's email Topic", async () => {
      const topicForOne = await topicService.findOrCreateEmailTopic(userOne)
      const topicForTwo = await topicService.findOrCreateEmailTopic(userTwo)

      expect(topicForTwo._id.toString()).not.toBe(topicForOne._id.toString())
    })

    test('does not match an existing Topic for the same owner that lacks the source: email marker', async () => {
      await insertTopics([{ ...newPrivateTopic(), owner: userOne._id, name: "won't match" }])

      const topic = await topicService.findOrCreateEmailTopic(userOne)

      expect(topic.name).toBe(`${userOne.username}'s emailed events`)
      expect(await Topic.countDocuments({ owner: userOne._id })).toBe(2)
    })

    test('creates a new Topic when the previous email Topic was soft-deleted', async () => {
      const first = await topicService.findOrCreateEmailTopic(userOne)
      first.isDeleted = true
      await first.save()

      const second = await topicService.findOrCreateEmailTopic(userOne)

      expect(second._id.toString()).not.toBe(first._id.toString())
      expect(second.isDeleted).toBe(false)
    })

    test('falls back to the email local part when the organizer has no username', async () => {
      const noUsernameUser = { ...userOne, _id: userTwo._id, username: undefined, email: 'jane.smith@example.edu' }

      const topic = await topicService.findOrCreateEmailTopic(noUsernameUser)

      expect(topic.name).toBe("jane.smith's emailed events")
    })
  })

  describe('deleteTopic()', () => {
    let deleteTopicCollectionSpy

    beforeEach(async () => {
      await insertUsers([userOne])
      await insertTopics([publicTopic])
      deleteTopicCollectionSpy = jest.spyOn(transcript, 'deleteTopicCollection').mockResolvedValue()
    })

    afterEach(() => {
      deleteTopicCollectionSpy.mockRestore()
    })

    test('should soft delete the topic and call deleteTopicCollection', async () => {
      await topicService.deleteTopic(publicTopic._id)

      const dbTopic = await Topic.findById(publicTopic._id)
      expect(dbTopic!.isDeleted).toBe(true)
      expect(deleteTopicCollectionSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: publicTopic._id }))
    })

    test('should throw if topic does not exist', async () => {
      await expect(topicService.deleteTopic(newPublicTopic()._id)).rejects.toThrow('Channel does not exist')
      expect(deleteTopicCollectionSpy).not.toHaveBeenCalled()
    })
  })

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

    /* If this job is torn down mid-flight and retried from scratch, the retry's
       `isArchiveNotified: false` query would otherwise match this topic again and send a
       duplicate archive-warning email. Flipping and persisting the flag before the send
       (rather than after) means a failure here drops one notification instead of
       duplicating it — this confirms the flag is already committed even when the send
       itself fails. */
    test('should mark isArchiveNotified before sending, so a failed send is not retried into a duplicate', async () => {
      jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue()
      jest.spyOn(emailService, 'sendArchiveTopicEmail').mockRejectedValue(new Error('SMTP down'))

      publicTopic.createdAt = oldDate
      await insertTopics([publicTopic])

      await expect(topicService.emailUsersToArchive()).rejects.toThrow('SMTP down')

      const dbPublicTopic = await Topic.findById(publicTopic._id)
      expect(dbPublicTopic!.isArchiveNotified).toBe(true)
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
