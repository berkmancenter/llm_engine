import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, userOne, userTwo } from '../fixtures/user.fixture.js'
import { userOneAccessToken, userTwoAccessToken } from '../fixtures/token.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import { Conversation } from '../../src/models/index.js'
import { publicTopic, privateTopic } from '../fixtures/conversation.fixture.js'
import backgroundCollection from '../../src/agents/helpers/backgroundCollection.js'

jest.setTimeout(120000)
jest.mock('agenda')
setupIntTest()

describe('Resource routes', () => {
  let conversation
  let resourceId

  beforeEach(async () => {
    await insertUsers([userOne, userTwo])
    await insertTopics([publicTopic, privateTopic])

    conversation = new Conversation({
      name: 'Resource Test Conversation',
      owner: userOne._id,
      topic: publicTopic._id,
      resources: [
        {
          source: 'speaker',
          category: 'required',
          title: 'Test Paper',
          authors: ['Author One'],
          year: '2024',
          participantVisible: true
        }
      ]
    })
    await conversation.save()
    resourceId = conversation.resources[0]._id.toString()
  })

  describe('POST /v1/resources/:conversationId/:resourceId/pdf', () => {
    let loadPdfSpy

    beforeEach(() => {
      loadPdfSpy = jest.spyOn(backgroundCollection, 'loadPdfIntoChroma').mockResolvedValue(undefined)
    })

    afterEach(() => {
      loadPdfSpy.mockRestore()
    })

    test('should return 204 and store fileName on resource when PDF uploaded', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content')

      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', pdfBuffer, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NO_CONTENT)

      const updated = await Conversation.findById(conversation._id)
      const resource = updated!.resources.find((r) => r._id!.toString() === resourceId)
      expect(resource!.fileName).toBe(`${resourceId}.pdf`)
    })

    test('should load PDF into Chroma with correct resource metadata', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content')

      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', pdfBuffer, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NO_CONTENT)

      expect(loadPdfSpy).toHaveBeenCalledWith(
        conversation._id.toString(),
        expect.objectContaining({
          title: 'Test Paper',
          fileName: `${resourceId}.pdf`
        })
      )
    })

    test('should return 204 even when Chroma indexing fails', async () => {
      loadPdfSpy.mockRejectedValue(new Error('Chroma unavailable'))
      const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content')

      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', pdfBuffer, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NO_CONTENT)

      // fileName still persisted despite Chroma failure
      const updated = await Conversation.findById(conversation._id)
      const resource = updated!.resources.find((r) => r._id!.toString() === resourceId)
      expect(resource!.fileName).toBe(`${resourceId}.pdf`)
    })

    test('should return 400 when no file is attached', async () => {
      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 404 when resourceId does not exist in conversation', async () => {
      const nonExistentResourceId = new mongoose.Types.ObjectId()
      const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content')

      await request(app)
        .post(`/v1/resources/${conversation._id}/${nonExistentResourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', pdfBuffer, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 404 when conversationId does not exist', async () => {
      const nonExistentConversationId = new mongoose.Types.ObjectId()
      const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content')

      await request(app)
        .post(`/v1/resources/${nonExistentConversationId}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', pdfBuffer, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 401 when no auth token provided', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content')

      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .attach('pdf', pdfBuffer, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 400 when conversationId is invalid ObjectId', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content')

      await request(app)
        .post(`/v1/resources/invalid-id/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', pdfBuffer, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 400 when resourceId is invalid ObjectId', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content')

      await request(app)
        .post(`/v1/resources/${conversation._id}/invalid-id/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', pdfBuffer, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 403 when user does not own the conversation or topic', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content')

      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .attach('pdf', pdfBuffer, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.FORBIDDEN)
    })

    test('should allow upload by userTwo when userTwo owns the conversation', async () => {
      const userTwoConversation = new Conversation({
        name: 'UserTwo Conversation',
        owner: userTwo._id,
        topic: publicTopic._id,
        resources: [
          {
            source: 'speaker',
            category: 'required',
            title: 'UserTwo Paper',
            participantVisible: true
          }
        ]
      })
      await userTwoConversation.save()
      const userTwoResourceId = userTwoConversation.resources[0]._id!.toString()
      const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content')

      await request(app)
        .post(`/v1/resources/${userTwoConversation._id}/${userTwoResourceId}/pdf`)
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .attach('pdf', pdfBuffer, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NO_CONTENT)
    })
  })
})
