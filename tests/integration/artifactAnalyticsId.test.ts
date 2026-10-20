import request from 'supertest'
import httpStatus from 'http-status'
import app from '../../src/app.js'
import config from '../../src/config/config.js'
import setupIntTest from '../utils/setupIntTest.js'
import Conversation from '../../src/models/conversation.model.js'
import ArtifactVersion from '../../src/models/artifact.model/version.js'
import { CONCEPT_GRAPH_ARTIFACT } from '../../src/models/artifact.model/conceptGraphArtifact.js'
import { analyticsIdFor } from '../../src/services/conceptGraph/analyticsId.js'
import { insertUsers, userOne } from '../fixtures/user.fixture.js'
import { userOneAccessToken } from '../fixtures/token.fixture.js'
import { newPublicTopic, insertTopics } from '../fixtures/topic.fixture.js'

setupIntTest()

const SECRET = 'integration-analytics-secret'
const payload = {
  concepts: [{ id: 'c-trust', label: 'Trust', origin: 'p-q' }],
  contributions: [{ id: 'k-anchors', kind: 'anchors', concepts: ['c-trust'], origin: 'p-q' }],
  originPrompts: [{ id: 'p-q', text: 'What has to be trustworthy?' }]
}

const original = config.analytics.idSecret
let conversation
let artifact

const auth = (req) => req.set('Authorization', `Bearer ${userOneAccessToken}`)

beforeAll(async () => {
  await ArtifactVersion.syncIndexes()
})

beforeEach(async () => {
  config.analytics.idSecret = SECRET
  await insertUsers([userOne])
  const topic = newPublicTopic()
  topic.owner = userOne._id
  await insertTopics([topic])
  conversation = await Conversation.create({ name: 'Session', slug: 'session', owner: userOne._id, topic: topic._id })
  const res = await auth(request(app).post('/v1/artifacts'))
    .send({ type: CONCEPT_GRAPH_ARTIFACT, conversationId: conversation._id.toString(), title: 'Graph', payload })
    .expect(httpStatus.CREATED)
  artifact = res.body
})

afterAll(() => {
  config.analytics.idSecret = original
})

const expectTagged = (p) => {
  expect(p.concepts[0].analyticsId).toBe(analyticsIdFor('c-trust', SECRET))
  expect(p.originPrompts[0].analyticsId).toBe(analyticsIdFor('p-q', SECRET))
  expect(p.contributions[0]).not.toHaveProperty('analyticsId')
}

describe('analyticsId on concept graph reads', () => {
  it('is on the single read, the list, the versions and one version', async () => {
    const one = await auth(request(app).get(`/v1/artifacts/${artifact.id}`)).expect(httpStatus.OK)
    expectTagged(one.body.currentVersion.payload)

    const list = await auth(request(app).get('/v1/artifacts').query({ conversationId: conversation._id.toString() })).expect(
      httpStatus.OK
    )
    expectTagged(list.body[0].currentVersion.payload)

    const versions = await auth(request(app).get(`/v1/artifacts/${artifact.id}/versions`)).expect(httpStatus.OK)
    expectTagged(versions.body.results[0].payload)

    const v1 = await auth(request(app).get(`/v1/artifacts/${artifact.id}/versions/1`)).expect(httpStatus.OK)
    expectTagged(v1.body.payload)
  })

  it('does not change what is stored', async () => {
    await auth(request(app).get(`/v1/artifacts/${artifact.id}`)).expect(httpStatus.OK)
    const stored = await ArtifactVersion.findOne({ artifact: artifact.id }).lean()
    expect(stored!.payload).toEqual(payload)
    expect(JSON.stringify(stored!.payload)).not.toContain('analyticsId')
  })

  it('accepts a fetched payload echoed back and does not persist the field', async () => {
    const v1 = await auth(request(app).get(`/v1/artifacts/${artifact.id}/versions/1`)).expect(httpStatus.OK)
    const appended = await auth(request(app).post(`/v1/artifacts/${artifact.id}/versions`))
      .send({ payload: v1.body.payload })
      .expect(httpStatus.CREATED)
    expectTagged(appended.body.payload)
    const stored = await ArtifactVersion.findOne({ artifact: artifact.id, versionNumber: 2 }).lean()
    expect(JSON.stringify(stored!.payload)).not.toContain('analyticsId')
  })

  it('is omitted everywhere when no secret is configured', async () => {
    config.analytics.idSecret = undefined
    const one = await auth(request(app).get(`/v1/artifacts/${artifact.id}`)).expect(httpStatus.OK)
    expect(JSON.stringify(one.body)).not.toContain('analyticsId')
    const v1 = await auth(request(app).get(`/v1/artifacts/${artifact.id}/versions/1`)).expect(httpStatus.OK)
    expect(JSON.stringify(v1.body)).not.toContain('analyticsId')
  })
})
