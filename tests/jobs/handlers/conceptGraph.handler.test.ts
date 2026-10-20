import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import handlers from '../../../src/jobs/handlers/conceptGraph.js'
import conceptGraphService from '../../../src/services/conceptGraph/index.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import Artifact from '../../../src/models/artifact.model/artifact.js'
import { CONCEPT_GRAPH_ARTIFACT } from '../../../src/models/artifact.model/conceptGraphArtifact.js'
import Conversation from '../../../src/models/conversation.model.js'
import { insertUsers, userTwo } from '../../fixtures/user.fixture.js'
import { newPublicTopic, insertTopics } from '../../fixtures/topic.fixture.js'
import logger from '../../../src/config/logger.js'
import setupIntTest from '../../utils/setupIntTest.js'

setupIntTest()

/* There is no socket server in the suite, and generateConceptGraph/refineTopicGraph's own
   LLM chain is exercised elsewhere (tests/services/conceptGraph) — this handler is a thin
   wrapper, so it is tested with both spied out, the same way conversationCost.handler.test.ts
   spies on its service. */
const generateSpy = jest.spyOn(conceptGraphService, 'generateConceptGraph')
const refineSpy = jest.spyOn(conceptGraphService, 'refineTopicGraph')
const broadcastFailedSpy = jest.spyOn(websocketGateway, 'broadcastArtifactGenerationFailed')

let topic
let conversation
let artifact

beforeEach(async () => {
  generateSpy.mockReset()
  refineSpy.mockReset()
  broadcastFailedSpy.mockReset()
  broadcastFailedSpy.mockResolvedValue(undefined)
  await insertUsers([userTwo])
  topic = newPublicTopic()
  topic.owner = userTwo._id
  await insertTopics([topic])
  conversation = await Conversation.create({
    name: 'Session one',
    slug: 'session-one',
    owner: userTwo._id,
    topic: topic._id
  })
  artifact = await Artifact.create({
    __t: CONCEPT_GRAPH_ARTIFACT,
    scope: 'conversation',
    topic: topic._id,
    conversation: conversation._id,
    title: 'Concept map — Session one',
    createdBy: userTwo._id,
    generationStatus: 'pending'
  })
})

afterAll(() => {
  generateSpy.mockRestore()
  refineSpy.mockRestore()
  broadcastFailedSpy.mockRestore()
})

/* Gives the shell a graph to fall back to, i.e. a re-run rather than a first-ever run. */
const withVersion = async () => {
  await Artifact.updateOne(
    { _id: artifact._id },
    { $set: { currentVersion: new mongoose.Types.ObjectId(), currentVersionNumber: 1 } }
  )
}

const rawArtifact = () => Artifact.collection.findOne({ _id: artifact._id })

const makeJob = (overrides: Record<string, unknown> = {}) => ({
  attrs: {
    data: {
      artifactId: artifact._id.toString(),
      conversationId: conversation._id.toString(),
      callerId: userTwo._id.toString(),
      ...overrides
    }
  }
})

describe('generateConceptGraph handler', () => {
  it('calls generateConceptGraph for a conversation-scoped job and leaves the artifact alone on success', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateSpy.mockResolvedValue({ artifact, version: {}, report: {} } as any)

    await handlers.generateConceptGraph(makeJob())

    expect(generateSpy).toHaveBeenCalledWith(conversation._id.toString(), expect.objectContaining({ _id: userTwo._id }))
    expect(refineSpy).not.toHaveBeenCalled()
    // A successful run's generationStatus flip and broadcast happen inside
    // artifactService.appendVersion, which is mocked out here — the handler itself must not
    // touch the artifact on success.
    const reloaded = await Artifact.findById(artifact._id)
    expect(reloaded!.generationStatus).toBe('pending')
    expect(broadcastFailedSpy).not.toHaveBeenCalled()
  })

  it('calls refineTopicGraph for a topic-scoped job', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refineSpy.mockResolvedValue({ artifact, version: {}, report: {} } as any)

    await handlers.generateConceptGraph(makeJob({ conversationId: undefined, topicId: topic._id.toString() }))

    expect(refineSpy).toHaveBeenCalledWith(topic._id.toString(), expect.objectContaining({ _id: userTwo._id }), undefined, {
      reset: undefined
    })
    expect(generateSpy).not.toHaveBeenCalled()
  })

  it('returns an artifact with a version to ready, and still broadcasts, when there was too little to map', async () => {
    await withVersion()
    await Artifact.updateOne({ _id: artifact._id }, { $set: { generationError: 'stale' } })
    generateSpy.mockResolvedValue(null)

    await handlers.generateConceptGraph(makeJob())

    const doc = await rawArtifact()
    expect(doc!.generationStatus).toBe('ready')
    expect(doc!.generationError).toBeUndefined()
    expect(doc!.isDeleted).toBe(false)
    expect(broadcastFailedSpy).toHaveBeenCalledWith(conversation._id.toString(), {
      artifactId: artifact._id.toString(),
      reason: 'Not enough of the record to map'
    })
  })

  it('marks the artifact failed with a fixed message, not the raw error, when generation throws', async () => {
    await withVersion()
    const loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger)
    const rawError = new Error('model call failed')
    generateSpy.mockRejectedValue(rawError)

    await expect(handlers.generateConceptGraph(makeJob())).resolves.not.toThrow()

    // the real error is kept for diagnostics, server-side only
    expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining(artifact._id.toString()), rawError)
    loggerErrorSpy.mockRestore()

    const reloaded = await Artifact.findById(artifact._id)
    expect(reloaded!.generationStatus).toBe('failed')
    expect(reloaded!.generationError).toBe('Generation failed. Try again, or check the server logs.')
    expect(broadcastFailedSpy).toHaveBeenCalledWith(conversation._id.toString(), {
      artifactId: artifact._id.toString(),
      reason: 'Generation failed. Try again, or check the server logs.'
    })
  })

  it('broadcasts a topic-scoped too-little-to-map notice to the topic room, not a conversation room', async () => {
    await withVersion()
    refineSpy.mockResolvedValue(null)

    await handlers.generateConceptGraph(makeJob({ conversationId: undefined, topicId: topic._id.toString() }))

    const reloaded = await Artifact.findById(artifact._id)
    expect(reloaded!.generationStatus).toBe('ready')
    expect(broadcastFailedSpy).toHaveBeenCalledWith(topic._id.toString(), {
      artifactId: artifact._id.toString(),
      reason: 'Not enough of the record to map'
    })
  })

  it('broadcasts a topic-scoped thrown error to the topic room, not a conversation room', async () => {
    await withVersion()
    refineSpy.mockRejectedValue(new Error('model call failed'))

    await handlers.generateConceptGraph(makeJob({ conversationId: undefined, topicId: topic._id.toString() }))

    const reloaded = await Artifact.findById(artifact._id)
    expect(reloaded!.generationStatus).toBe('failed')
    expect(reloaded!.generationError).toBe('Generation failed. Try again, or check the server logs.')
    expect(broadcastFailedSpy).toHaveBeenCalledWith(topic._id.toString(), {
      artifactId: artifact._id.toString(),
      reason: 'Generation failed. Try again, or check the server logs.'
    })
  })

  describe('a first-ever run with no version to fall back to', () => {
    it.each([
      ['finds too little to map', () => generateSpy.mockResolvedValue(null), 'Not enough of the record to map'],
      [
        'throws',
        () => generateSpy.mockRejectedValue(new Error('model call failed')),
        'Generation failed. Try again, or check the server logs.'
      ]
    ])('soft-deletes the shell and still broadcasts when it %s', async (_label, arrange, reason) => {
      arrange()

      await handlers.generateConceptGraph(makeJob())

      expect((await rawArtifact())!.isDeleted).toBe(true)
      expect(broadcastFailedSpy).toHaveBeenCalledWith(conversation._id.toString(), {
        artifactId: artifact._id.toString(),
        reason
      })
    })

    it('soft-deletes a topic-scoped shell and broadcasts to the topic room', async () => {
      refineSpy.mockResolvedValue(null)

      await handlers.generateConceptGraph(makeJob({ conversationId: undefined, topicId: topic._id.toString() }))

      expect((await rawArtifact())!.isDeleted).toBe(true)
      expect(broadcastFailedSpy).toHaveBeenCalledWith(
        topic._id.toString(),
        expect.objectContaining({ artifactId: artifact._id.toString() })
      )
    })

    it('soft-deletes the shell when the caller no longer exists', async () => {
      await handlers.generateConceptGraph(makeJob({ callerId: new mongoose.Types.ObjectId().toString() }))

      expect((await rawArtifact())!.isDeleted).toBe(true)
    })

    it('does not soft-delete an artifact that has a version', async () => {
      await withVersion()
      generateSpy.mockRejectedValue(new Error('model call failed'))

      await handlers.generateConceptGraph(makeJob())

      expect((await rawArtifact())!.isDeleted).toBe(false)
    })
  })

  it('skips a redelivered job whose artifact is no longer pending', async () => {
    await Artifact.updateOne({ _id: artifact._id }, { $set: { generationStatus: 'ready' } })

    await handlers.generateConceptGraph(makeJob())

    expect(generateSpy).not.toHaveBeenCalled()
    expect(refineSpy).not.toHaveBeenCalled()
    const reloaded = await Artifact.findById(artifact._id)
    expect(reloaded!.generationStatus).toBe('ready')
  })

  it('fails gracefully when the caller no longer exists, without calling the pipeline', async () => {
    await withVersion()
    await handlers.generateConceptGraph(makeJob({ callerId: new mongoose.Types.ObjectId().toString() }))

    const reloaded = await Artifact.findById(artifact._id)
    expect(reloaded!.generationStatus).toBe('failed')
    expect(reloaded!.generationError).toMatch(/no longer exists/)
    expect(generateSpy).not.toHaveBeenCalled()
    expect(refineSpy).not.toHaveBeenCalled()
  })
})
