import { jest } from '@jest/globals'
import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import app from '../../src/app.js'
import setupIntTest from '../utils/setupIntTest.js'
import Conversation from '../../src/models/conversation.model.js'
import ArtifactVersion from '../../src/models/artifact.model/version.js'
import { DOCUMENT_ARTIFACT } from '../../src/models/artifact.model/documentArtifact.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import { insertUsers, userOne, participant } from '../fixtures/user.fixture.js'
import { userOneAccessToken, participantAccessToken } from '../fixtures/token.fixture.js'
import { newPublicTopic, insertTopics } from '../fixtures/topic.fixture.js'

setupIntTest()

/* No socket server in the suite, and the route must not fail because of it. */
const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastArtifactVersion')

beforeAll(async () => {
  await ArtifactVersion.syncIndexes()
})

let topic
let conversation

beforeEach(async () => {
  broadcastSpy.mockReset()
  broadcastSpy.mockResolvedValue(undefined)
  await insertUsers([userOne, participant])
  topic = newPublicTopic()
  topic.owner = userOne._id
  await insertTopics([topic])
  conversation = await Conversation.create({
    name: 'Session one',
    slug: 'session-one',
    owner: userOne._id,
    topic: topic._id
  })
})

afterAll(() => {
  broadcastSpy.mockRestore()
})

const createBody = (overrides = {}) => ({
  type: DOCUMENT_ARTIFACT,
  conversationId: conversation._id.toString(),
  title: 'Shared priorities',
  payload: { body: 'The group converged on three priorities.' },
  ...overrides
})

const createArtifact = async (overrides = {}) => {
  const res = await request(app)
    .post('/v1/artifacts')
    .set('Authorization', `Bearer ${userOneAccessToken}`)
    .send(createBody(overrides))
    .expect(httpStatus.CREATED)
  return res.body
}

describe('POST /v1/artifacts', () => {
  it('creates an artifact and returns the read passcode the client needs', async () => {
    const body = await createArtifact()

    expect(body.id).toEqual(expect.any(String))
    expect(body.type).toBe(DOCUMENT_ARTIFACT)
    expect(body.scope).toBe('conversation')
    expect(body.currentVersionNumber).toBe(1)
    expect(body.artifactPasscode).toEqual(expect.any(String))
  })

  it('rejects a request naming both a topic and a conversation', async () => {
    await request(app)
      .post('/v1/artifacts')
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send(createBody({ topicId: topic._id.toString() }))
      .expect(httpStatus.BAD_REQUEST)
  })

  it('rejects a request naming neither', async () => {
    await request(app)
      .post('/v1/artifacts')
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send({ type: DOCUMENT_ARTIFACT, title: 'Nowhere', payload: { body: 'x' } })
      .expect(httpStatus.BAD_REQUEST)
  })

  it('rejects an unknown artifact type at the route, before it reaches the service', async () => {
    await request(app)
      .post('/v1/artifacts')
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send(createBody({ type: 'HologramArtifact' }))
      .expect(httpStatus.BAD_REQUEST)
  })

  it('rejects a payload that does not match the artifact type', async () => {
    await request(app)
      .post('/v1/artifacts')
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send(createBody({ payload: { headline: 'wrong field' } }))
      .expect(httpStatus.BAD_REQUEST)
  })

  it('forbids a participant, who holds no artifact-management right', async () => {
    await request(app)
      .post('/v1/artifacts')
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .send(createBody())
      .expect(httpStatus.FORBIDDEN)
  })

  it('requires authentication', async () => {
    await request(app).post('/v1/artifacts').send(createBody()).expect(httpStatus.UNAUTHORIZED)
  })
})

describe('GET /v1/artifacts', () => {
  it('lists a conversation artifacts for a passcode holder', async () => {
    const { artifactPasscode } = await createArtifact()

    const res = await request(app)
      .get('/v1/artifacts')
      .query({ conversationId: conversation._id.toString(), artifactPasscode })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .expect(httpStatus.OK)

    expect(res.body).toHaveLength(1)
    expect(res.body[0].currentVersion.payload).toEqual({ body: 'The group converged on three priorities.' })
  })

  it('lists for the owner with no passcode at all', async () => {
    await createArtifact()

    const res = await request(app)
      .get('/v1/artifacts')
      .query({ conversationId: conversation._id.toString() })
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.OK)

    expect(res.body).toHaveLength(1)
  })

  it('forbids a participant with no passcode', async () => {
    await createArtifact()

    await request(app)
      .get('/v1/artifacts')
      .query({ conversationId: conversation._id.toString() })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .expect(httpStatus.FORBIDDEN)
  })

  it('forbids a participant with the wrong passcode', async () => {
    await createArtifact()

    await request(app)
      .get('/v1/artifacts')
      .query({ conversationId: conversation._id.toString(), artifactPasscode: 'wrong-code' })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .expect(httpStatus.FORBIDDEN)
  })

  it('answers a nonexistent conversation the same way as a bad passcode', async () => {
    await request(app)
      .get('/v1/artifacts')
      .query({ conversationId: new mongoose.Types.ObjectId().toString(), artifactPasscode: 'any' })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .expect(httpStatus.FORBIDDEN)
  })
})

describe('GET /v1/artifacts/:artifactId', () => {
  it('returns the latest version by default', async () => {
    const { id, artifactPasscode } = await createArtifact()
    await request(app)
      .post(`/v1/artifacts/${id}/versions`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send({ payload: { body: 'Revised.' } })
      .expect(httpStatus.CREATED)

    const res = await request(app)
      .get(`/v1/artifacts/${id}`)
      .query({ artifactPasscode })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .expect(httpStatus.OK)

    expect(res.body.currentVersionNumber).toBe(2)
    expect(res.body.currentVersion.payload).toEqual({ body: 'Revised.' })
  })

  it('rejects an id that is not an object id', async () => {
    await request(app)
      .get('/v1/artifacts/not-an-id')
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.BAD_REQUEST)
  })
})

describe('POST /v1/artifacts/:artifactId/versions', () => {
  it('appends a version and returns it', async () => {
    const { id } = await createArtifact()

    const res = await request(app)
      .post(`/v1/artifacts/${id}/versions`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send({ payload: { body: 'Revised.' }, note: 'After the breakout' })
      .expect(httpStatus.CREATED)

    expect(res.body.versionNumber).toBe(2)
    expect(res.body.note).toBe('After the breakout')
  })

  it('does not accept the read passcode as authorization to write', async () => {
    const { id, artifactPasscode } = await createArtifact()

    await request(app)
      .post(`/v1/artifacts/${id}/versions`)
      .query({ artifactPasscode })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .send({ payload: { body: 'Not mine to edit.' } })
      .expect(httpStatus.FORBIDDEN)
  })
})

describe('GET /v1/artifacts/:artifactId/versions', () => {
  it('returns the full history newest first, paginated', async () => {
    const { id, artifactPasscode } = await createArtifact()
    await request(app)
      .post(`/v1/artifacts/${id}/versions`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send({ payload: { body: 'Second.' } })
      .expect(httpStatus.CREATED)

    const res = await request(app)
      .get(`/v1/artifacts/${id}/versions`)
      .query({ artifactPasscode })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .expect(httpStatus.OK)

    expect(res.body.totalResults).toBe(2)
    expect(res.body.results.map((v) => v.versionNumber)).toEqual([2, 1])
  })

  it('fetches one numbered version', async () => {
    const { id, artifactPasscode } = await createArtifact()

    const res = await request(app)
      .get(`/v1/artifacts/${id}/versions/1`)
      .query({ artifactPasscode })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .expect(httpStatus.OK)

    expect(res.body.payload).toEqual({ body: 'The group converged on three priorities.' })
  })

  it('404s a version the artifact never had', async () => {
    const { id, artifactPasscode } = await createArtifact()

    await request(app)
      .get(`/v1/artifacts/${id}/versions/9`)
      .query({ artifactPasscode })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .expect(httpStatus.NOT_FOUND)
  })
})

describe('GET /v1/artifacts/passcode', () => {
  it('is routed as the passcode endpoint rather than an artifact id', async () => {
    const res = await request(app)
      .get('/v1/artifacts/passcode')
      .query({ conversationId: conversation._id.toString() })
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.OK)

    expect(res.body.artifactPasscode).toEqual(expect.any(String))
  })

  it('returns the same passcode the create response gave, so shared links keep working', async () => {
    const { artifactPasscode } = await createArtifact()

    const res = await request(app)
      .get('/v1/artifacts/passcode')
      .query({ conversationId: conversation._id.toString() })
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.OK)

    expect(res.body.artifactPasscode).toBe(artifactPasscode)
  })

  it('forbids a participant, who may hold the key but not hand it out', async () => {
    await createArtifact()

    await request(app)
      .get('/v1/artifacts/passcode')
      .query({ conversationId: conversation._id.toString() })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .expect(httpStatus.FORBIDDEN)
  })
})
