import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, userOne, userTwo } from '../fixtures/user.fixture.js'
import { userOneAccessToken, userTwoAccessToken } from '../fixtures/token.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import { Conversation } from '../../src/models/index.js'
import { publicTopic, privateTopic } from '../fixtures/conversation.fixture.js'
import backgroundCollection from '../../src/agents/helpers/backgroundCollection.js'
import resourceService from '../../src/services/resource.service.js'
import schedule from '../../src/jobs/schedule.js'

const FAKE_PDF_CONTENT = `Distributed Systems: A Study in Consensus Algorithms
Smith, J. (2023). Journal of Computer Science, 45(2), 112–130.

Abstract
This paper examines the fundamental challenges of achieving distributed consensus in fault-tolerant
systems under real-world network conditions. We analyze the Raft and Paxos consensus algorithms,
comparing their behavior under network partition scenarios, leader failure, and message reordering.

Methodology
We deployed a 5-node cluster across three availability zones using commodity hardware. Experiments
were run over 72-hour windows with injected packet loss (1–10%) and simulated node crashes.
Each algorithm processed 1 million client write requests per trial. Metrics were collected via
distributed tracing and aggregated using a time-series database.

Key Findings
Raft achieved 40% faster leader election than Paxos under high-churn conditions. Both algorithms
maintained linearizability throughout all tested failure scenarios. Raft's understandability
advantage translated into 30% fewer configuration errors in operator surveys. Paxos showed
marginally better throughput at >95th percentile latency under sustained load.

Practical Relevance
Organizations operating distributed databases (e.g., etcd, CockroachDB) can expect measurable
improvements in availability by tuning election timeouts to match their network's median RTT.
Developers new to consensus systems should prefer Raft for its clearer invariants and better
tooling support. The findings suggest that algorithm choice matters less than correct deployment
configuration and monitoring.`

jest.setTimeout(120000)
jest.mock('agenda')
setupIntTest()

// Minimal valid single-page PDF with extractable text
const MINIMAL_PDF = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n' +
    '2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n' +
    '3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>\nendobj\n' +
    '4 0 obj\n<</Length 44>>\nstream\nBT /F1 12 Tf 100 700 Td (Test content.) Tj ET\nendstream\nendobj\n' +
    '5 0 obj\n<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>\nendobj\n' +
    'xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000274 00000 n \n0000000369 00000 n \n' +
    'trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n450\n%%EOF'
)

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
    let scheduleSummarizeSpy

    beforeEach(() => {
      loadPdfSpy = jest.spyOn(backgroundCollection, 'loadPdfIntoChroma').mockResolvedValue(undefined)
      scheduleSummarizeSpy = jest.spyOn(schedule, 'summarizePdf').mockResolvedValue(undefined)
    })

    afterEach(() => {
      loadPdfSpy.mockRestore()
      scheduleSummarizeSpy.mockRestore()
    })

    test('should return 204 and store fileName on resource when PDF uploaded', async () => {
      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NO_CONTENT)

      const updated = await Conversation.findById(conversation._id)
      const resource = updated!.resources.find((r) => r._id!.toString() === resourceId)
      expect(resource!.fileName).toBe(`${resourceId}.pdf`)
    })

    test('should load PDF into Chroma with correct resource metadata', async () => {
      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NO_CONTENT)

      expect(loadPdfSpy).toHaveBeenCalledWith(
        conversation._id.toString(),
        expect.objectContaining({ title: 'Test Paper', fileName: `${resourceId}.pdf` })
      )
    })

    test('should schedule summarize job for required resource', async () => {
      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NO_CONTENT)

      expect(scheduleSummarizeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: conversation._id.toString(),
          resourceId,
          filePath: expect.stringContaining(`${resourceId}.pdf`),
          citation: expect.stringContaining('Test Paper')
        })
      )
    })

    test('should not schedule summarize job for non-required resource', async () => {
      const referencedConversation = new Conversation({
        name: 'Referenced Resource Conversation',
        owner: userOne._id,
        topic: publicTopic._id,
        resources: [{ source: 'speaker', category: 'referenced', title: 'Referenced Paper', participantVisible: true }]
      })
      await referencedConversation.save()
      const referencedResourceId = referencedConversation.resources[0]._id!.toString()

      await request(app)
        .post(`/v1/resources/${referencedConversation._id}/${referencedResourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NO_CONTENT)

      expect(scheduleSummarizeSpy).not.toHaveBeenCalled()
    })

    test('should return 204 even when Chroma indexing fails', async () => {
      loadPdfSpy.mockRejectedValue(new Error('Chroma unavailable'))

      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NO_CONTENT)

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
      await request(app)
        .post(`/v1/resources/${conversation._id}/${new mongoose.Types.ObjectId()}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 404 when conversationId does not exist', async () => {
      await request(app)
        .post(`/v1/resources/${new mongoose.Types.ObjectId()}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 401 when no auth token provided', async () => {
      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 400 when conversationId is invalid ObjectId', async () => {
      await request(app)
        .post(`/v1/resources/invalid-id/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 400 when resourceId is invalid ObjectId', async () => {
      await request(app)
        .post(`/v1/resources/${conversation._id}/invalid-id/pdf`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 403 when user does not own the conversation or topic', async () => {
      await request(app)
        .post(`/v1/resources/${conversation._id}/${resourceId}/pdf`)
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.FORBIDDEN)
    })

    test('should allow upload by userTwo when userTwo owns the conversation', async () => {
      const userTwoConversation = new Conversation({
        name: 'UserTwo Conversation',
        owner: userTwo._id,
        topic: publicTopic._id,
        resources: [{ source: 'speaker', category: 'required', title: 'UserTwo Paper', participantVisible: true }]
      })
      await userTwoConversation.save()
      const userTwoResourceId = userTwoConversation.resources[0]._id!.toString()

      await request(app)
        .post(`/v1/resources/${userTwoConversation._id}/${userTwoResourceId}/pdf`)
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .attach('pdf', MINIMAL_PDF, { filename: 'test.pdf', contentType: 'application/pdf' })
        .expect(httpStatus.NO_CONTENT)
    })
  })
})

describe('resourceService.summarizePdf()', () => {
  let conversation
  let resourceId
  let pdfLoaderSpy

  beforeAll(() => {
    pdfLoaderSpy = jest
      .spyOn(PDFLoader.prototype, 'load')
      .mockResolvedValue([{ pageContent: FAKE_PDF_CONTENT, metadata: { source: 'test.pdf', pdf: { totalPages: 1 } } }])
  })

  afterAll(() => {
    pdfLoaderSpy.mockRestore()
  })

  beforeEach(async () => {
    await insertUsers([userOne])
    await insertTopics([publicTopic])

    conversation = new Conversation({
      name: 'Summarize Test Conversation',
      owner: userOne._id,
      topic: publicTopic._id,
      resources: [
        {
          source: 'speaker',
          category: 'required',
          title: 'Distributed Systems Paper',
          authors: ['Jane Smith'],
          year: '2023',
          citation: 'Smith, J. (2023). Distributed Systems. Journal of CS.',
          participantVisible: true
        }
      ]
    })
    await conversation.save()
    resourceId = conversation.resources[0]._id.toString()
  })

  test('should write a non-empty summary to the resource in the DB', async () => {
    await resourceService.summarizePdf(
      conversation._id.toString(),
      resourceId,
      'tests/fixtures/dummy.pdf',
      'Smith, J. (2023). Distributed Systems. Journal of CS.'
    )

    const updated = await Conversation.findById(conversation._id)
    const resource = updated!.resources.find((r) => r._id!.toString() === resourceId)
    expect(typeof resource!.summary).toBe('string')
    expect(resource!.summary!.length).toBeGreaterThan(0)
    // eslint-disable-next-line no-console
    console.log('Generated summary:', resource!.summary)
  })

  test('should only update the targeted resource and leave others unchanged', async () => {
    const otherConversation = new Conversation({
      name: 'Two Resource Conversation',
      owner: userOne._id,
      topic: publicTopic._id,
      resources: [
        { source: 'speaker', category: 'required', title: 'Paper A', participantVisible: true },
        { source: 'speaker', category: 'required', title: 'Paper B', participantVisible: true }
      ]
    })
    await otherConversation.save()
    const [resA, resB] = otherConversation.resources

    await resourceService.summarizePdf(
      otherConversation._id.toString(),
      resA._id!.toString(),
      'tests/fixtures/dummy.pdf',
      'Paper A'
    )

    const updated = await Conversation.findById(otherConversation._id)
    expect(updated!.resources.find((r) => r._id!.toString() === resA._id!.toString())!.summary).toBeTruthy()
    expect(updated!.resources.find((r) => r._id!.toString() === resB._id!.toString())!.summary).toBeUndefined()
  })
})
