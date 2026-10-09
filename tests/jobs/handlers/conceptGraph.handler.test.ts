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

    expect(refineSpy).toHaveBeenCalledWith(
      topic._id.toString(),
      expect.objectContaining({ _id: userTwo._id }),
      undefined,
      { reset: undefined }
    )
    expect(generateSpy).not.toHaveBeenCalled()
  })

  it('marks the artifact failed and broadcasts when there was too little to map', async () => {
    generateSpy.mockResolvedValue(null)

    await handlers.generateConceptGraph(makeJob())

    const reloaded = await Artifact.findById(artifact._id)
    expect(reloaded!.generationStatus).toBe('failed')
    expect(reloaded!.generationError).toBe('Not enough of the record to map')
    expect(broadcastFailedSpy).toHaveBeenCalledWith(conversation._id.toString(), {
      artifactId: artifact._id.toString(),
      reason: 'Not enough of the record to map'
    })
  })

  it('marks the artifact failed with the error message when generation throws', async () => {
    generateSpy.mockRejectedValue(new Error('model call failed'))

    await expect(handlers.generateConceptGraph(makeJob())).resolves.not.toThrow()

    const reloaded = await Artifact.findById(artifact._id)
    expect(reloaded!.generationStatus).toBe('failed')
    expect(reloaded!.generationError).toBe('model call failed')
    expect(broadcastFailedSpy).toHaveBeenCalledWith(conversation._id.toString(), {
      artifactId: artifact._id.toString(),
      reason: 'model call failed'
    })
  })

  it('broadcasts a topic-scoped failure to the topic room, not a conversation room', async () => {
    refineSpy.mockResolvedValue(null)

    await handlers.generateConceptGraph(makeJob({ conversationId: undefined, topicId: topic._id.toString() }))

    const reloaded = await Artifact.findById(artifact._id)
    expect(reloaded!.generationStatus).toBe('failed')
    expect(broadcastFailedSpy).toHaveBeenCalledWith(topic._id.toString(), {
      artifactId: artifact._id.toString(),
      reason: 'Not enough of the record to map'
    })
  })

  it('broadcasts a topic-scoped thrown error to the topic room, not a conversation room', async () => {
    refineSpy.mockRejectedValue(new Error('model call failed'))

    await handlers.generateConceptGraph(makeJob({ conversationId: undefined, topicId: topic._id.toString() }))

    const reloaded = await Artifact.findById(artifact._id)
    expect(reloaded!.generationStatus).toBe('failed')
    expect(reloaded!.generationError).toBe('model call failed')
    expect(broadcastFailedSpy).toHaveBeenCalledWith(topic._id.toString(), {
      artifactId: artifact._id.toString(),
      reason: 'model call failed'
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
    await handlers.generateConceptGraph(makeJob({ callerId: new mongoose.Types.ObjectId().toString() }))

    const reloaded = await Artifact.findById(artifact._id)
    expect(reloaded!.generationStatus).toBe('failed')
    expect(reloaded!.generationError).toMatch(/no longer exists/)
    expect(generateSpy).not.toHaveBeenCalled()
    expect(refineSpy).not.toHaveBeenCalled()
  })
})
