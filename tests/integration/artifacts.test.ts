import { jest } from '@jest/globals'
import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import app from '../../src/app.js'
import setupIntTest from '../utils/setupIntTest.js'
import Conversation from '../../src/models/conversation.model.js'
import ArtifactVersion from '../../src/models/artifact.model/version.js'
import { DOCUMENT_ARTIFACT } from '../../src/models/artifact.model/documentArtifact.js'
import { CONCEPT_GRAPH_ARTIFACT } from '../../src/models/artifact.model/conceptGraphArtifact.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import schedule from '../../src/jobs/schedule.js'
import { insertUsers, userOne, participant } from '../fixtures/user.fixture.js'
import { userOneAccessToken, participantAccessToken } from '../fixtures/token.fixture.js'
import { newPublicTopic, insertTopics } from '../fixtures/topic.fixture.js'

setupIntTest()

/* No socket server in the suite, and the route must not fail because of it. */
const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastArtifactVersion')
/* POST /v1/artifacts/generate only claims/creates the artifact and enqueues a job — the
   pipeline itself is exercised in tests/services/conceptGraph, so the job is spied out here. */
const scheduleSpy = jest.spyOn(schedule, 'generateConceptGraph')

beforeAll(async () => {
  await ArtifactVersion.syncIndexes()
})

let topic
let conversation

beforeEach(async () => {
  broadcastSpy.mockReset()
  broadcastSpy.mockResolvedValue(undefined)
  scheduleSpy.mockReset()
  scheduleSpy.mockResolvedValue(undefined)
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
  scheduleSpy.mockRestore()
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

/* The kind that exercises the discriminator for real: a payload with structure, rather
   than the single text field a DocumentArtifact carries. */
describe('concept graph artifacts', () => {
  const graphPayload = {
    originPrompts: [{ id: 'p1', text: 'What has to be trustworthy for a credential to mean anything?' }],
    concepts: [
      { id: 'c-issuer', label: 'Issuer', origin: 'p1' },
      { id: 'c-verifier', label: 'Verifier' },
      {
        id: 'c-trust-registry',
        label: 'Trust Registry',
        provenance: { messageId: '6750a665664156091cdf5a31', pseudonym: 'Bold Aardvark' }
      }
    ],
    contributions: [
      { id: 'k8', kind: 'listed in', concepts: ['c-issuer', 'c-trust-registry'] },
      { id: 'k15', kind: 'co-governs', concepts: ['c-issuer', 'c-verifier', 'c-trust-registry'] }
    ]
  }

  /* Typed loosely on purpose: some of these cases send a payload the schema must reject,
     which would not typecheck against the shape inferred from graphPayload. */
  const createGraph = async (payload: Record<string, unknown> = graphPayload, expected: number = httpStatus.CREATED) =>
    request(app)
      .post('/v1/artifacts')
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send({
        type: CONCEPT_GRAPH_ARTIFACT,
        conversationId: conversation._id.toString(),
        title: 'Concepts and contributions',
        payload
      })
      .expect(expected)

  it('round-trips a graph, including a contribution joining three concepts', async () => {
    const res = await createGraph()

    expect(res.body.type).toBe(CONCEPT_GRAPH_ARTIFACT)
    const stored = res.body.currentVersion.payload
    expect(stored.contributions.find((k) => k.id === 'k15').concepts).toEqual(['c-issuer', 'c-verifier', 'c-trust-registry'])
    expect(stored.concepts.find((c) => c.id === 'c-issuer').origin).toBe('p1')
    expect(stored.concepts.find((c) => c.id === 'c-trust-registry').provenance.pseudonym).toBe('Bold Aardvark')
    expect(stored.originPrompts).toHaveLength(1)
  })

  it('fills in the empty arrays, so an artifact can be created before an event populates it', async () => {
    const res = await createGraph({})

    expect(res.body.currentVersion.payload).toEqual({ concepts: [], contributions: [], originPrompts: [] })
  })

  it('rejects a graph whose contribution names a concept that is not there', async () => {
    await createGraph(
      { concepts: [{ id: 'c1', label: 'Alone' }], contributions: [{ id: 'k1', kind: 'points at', concepts: ['ghost'] }] },
      httpStatus.BAD_REQUEST
    )
  })

  it('rejects a document payload sent as a concept graph', async () => {
    await createGraph({ body: 'prose, not a graph' }, httpStatus.BAD_REQUEST)
  })

  it('versions a graph the same way as any other artifact, keeping the earlier one readable', async () => {
    const { body: created } = await createGraph()
    const grown = {
      ...graphPayload,
      concepts: [...graphPayload.concepts, { id: 'c-holder', label: 'Holder' }]
    }

    await request(app)
      .post(`/v1/artifacts/${created.id}/versions`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send({ payload: grown, note: 'Holder came up in the second half' })
      .expect(httpStatus.CREATED)

    const latest = await request(app)
      .get(`/v1/artifacts/${created.id}`)
      .query({ artifactPasscode: created.artifactPasscode })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .expect(httpStatus.OK)
    const first = await request(app)
      .get(`/v1/artifacts/${created.id}/versions/1`)
      .query({ artifactPasscode: created.artifactPasscode })
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .expect(httpStatus.OK)

    expect(latest.body.currentVersion.payload.concepts).toHaveLength(4)
    expect(first.body.payload.concepts).toHaveLength(3)
  })

  it('lists graph and document artifacts together, each with its own type', async () => {
    await createGraph()
    await createArtifact()

    const res = await request(app)
      .get('/v1/artifacts')
      .query({ conversationId: conversation._id.toString() })
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.OK)

    expect(res.body.map((a) => a.type).sort()).toEqual([CONCEPT_GRAPH_ARTIFACT, DOCUMENT_ARTIFACT])
  })
})

describe('POST /v1/artifacts/generate', () => {
  /* The pipeline itself never runs in this route anymore — it is enqueued as a job (see
     jobs/handlers/conceptGraph.ts) precisely so this request can't run long enough to hit
     the load balancer's backend timeout (infra/modules/webserver-mig/lb.tf). */
  it('responds 202 immediately with a pending artifact and enqueues a job, without running the pipeline', async () => {
    const res = await request(app)
      .post('/v1/artifacts/generate')
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send({ conversationId: conversation._id.toString() })
      .expect(httpStatus.ACCEPTED)

    expect(res.body.generated).toBe(true)
    expect(res.body.status).toBe('pending')
    expect(res.body.artifact.type).toBe(CONCEPT_GRAPH_ARTIFACT)
    expect(res.body.artifact.generationStatus).toBe('pending')
    expect(res.body.artifact.currentVersion).toBeUndefined()
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: res.body.artifact.id, conversationId: conversation._id.toString() })
    )
  })

  it('does not enqueue a second job while one is already pending', async () => {
    const first = await request(app)
      .post('/v1/artifacts/generate')
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send({ conversationId: conversation._id.toString() })
      .expect(httpStatus.ACCEPTED)
    scheduleSpy.mockClear()

    const second = await request(app)
      .post('/v1/artifacts/generate')
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send({ conversationId: conversation._id.toString() })
      .expect(httpStatus.ACCEPTED)

    expect(second.body.artifact.id).toBe(first.body.artifact.id)
    expect(second.body.status).toBe('pending')
    expect(scheduleSpy).not.toHaveBeenCalled()
  })

  it('refuses a participant, who may read the eventual graph but not trigger generation', async () => {
    await request(app)
      .post('/v1/artifacts/generate')
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .send({ conversationId: conversation._id.toString() })
      .expect(httpStatus.FORBIDDEN)
    expect(scheduleSpy).not.toHaveBeenCalled()
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
