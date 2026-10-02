import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import conceptGraphService from '../../../src/services/conceptGraph/index.js'
import schedule from '../../../src/jobs/schedule.js'
import Artifact from '../../../src/models/artifact.model/artifact.js'
import { CONCEPT_GRAPH_ARTIFACT } from '../../../src/models/artifact.model/conceptGraphArtifact.js'
import Conversation from '../../../src/models/conversation.model.js'
import { insertUsers, userOne, userTwo, participant } from '../../fixtures/user.fixture.js'
import { newPublicTopic, insertTopics } from '../../fixtures/topic.fixture.js'

/*
 * enqueueGeneration is the only thing standing between POST /v1/artifacts/generate and the
 * job queue — see jobs/handlers/conceptGraph.ts and docs/pages/developers/artifacts.md's
 * "Generating a concept graph" section. It never touches the LLM boundary itself, so the
 * job is mocked out entirely: these tests are about the claim/create/dedup logic, not the
 * pipeline schedule.generateConceptGraph eventually kicks off.
 */

setupIntTest()

const scheduleSpy = jest.spyOn(schedule, 'generateConceptGraph')

let topic
let conversation

beforeEach(async () => {
  scheduleSpy.mockReset()
  scheduleSpy.mockResolvedValue(undefined)
  await insertUsers([userOne, userTwo, participant])
  topic = newPublicTopic()
  topic.owner = userOne._id
  await insertTopics([topic])
  conversation = await Conversation.create({
    name: 'Session one',
    slug: 'session-one',
    owner: userTwo._id,
    topic: topic._id
  })
})

afterAll(() => {
  scheduleSpy.mockRestore()
})

describe('enqueueGeneration', () => {
  it('creates a pending shell artifact and enqueues a job when none exists yet', async () => {
    const artifact = await conceptGraphService.enqueueGeneration({ conversationId: conversation._id.toString() }, userTwo)

    expect(artifact!.generationStatus).toBe('pending')
    expect(artifact!.currentVersion).toBeUndefined()
    expect(artifact!.currentVersionNumber).toBe(0)
    expect(await Artifact.countDocuments({ conversation: conversation._id, __t: CONCEPT_GRAPH_ARTIFACT })).toBe(1)
    expect(scheduleSpy).toHaveBeenCalledWith({
      artifactId: artifact!._id!.toString(),
      conversationId: conversation._id.toString(),
      topicId: undefined,
      callerId: userTwo._id.toString(),
      reset: undefined
    })
  })

  it('creates a pending shell for a topic-scoped generation', async () => {
    const artifact = await conceptGraphService.enqueueGeneration({ topicId: topic._id.toString() }, userOne)

    expect(artifact!.scope).toBe('topic')
    expect(artifact!.generationStatus).toBe('pending')
    expect(artifact!.conversation).toBeUndefined()
  })

  it('claims an existing, non-pending artifact and enqueues a job', async () => {
    const existing = await Artifact.create({
      __t: CONCEPT_GRAPH_ARTIFACT,
      scope: 'conversation',
      topic: topic._id,
      conversation: conversation._id,
      title: 'Concept map — Session one',
      createdBy: userTwo._id,
      generationStatus: 'failed',
      generationError: 'a previous run failed'
    })

    const claimed = await conceptGraphService.enqueueGeneration({ conversationId: conversation._id.toString() }, userTwo)

    expect(claimed!._id!.toString()).toBe(existing._id!.toString())
    expect(claimed!.generationStatus).toBe('pending')
    expect(claimed!.generationError).toBeUndefined()
    expect(scheduleSpy).toHaveBeenCalledTimes(1)
    expect(await Artifact.countDocuments({ conversation: conversation._id, __t: CONCEPT_GRAPH_ARTIFACT })).toBe(1)
  })

  it('does not start a second job for a generation already in flight', async () => {
    const existing = await Artifact.create({
      __t: CONCEPT_GRAPH_ARTIFACT,
      scope: 'conversation',
      topic: topic._id,
      conversation: conversation._id,
      title: 'Concept map — Session one',
      createdBy: userTwo._id,
      generationStatus: 'pending'
    })

    const result = await conceptGraphService.enqueueGeneration({ conversationId: conversation._id.toString() }, userTwo)

    expect(result!._id!.toString()).toBe(existing._id!.toString())
    expect(result!.generationStatus).toBe('pending')
    expect(scheduleSpy).not.toHaveBeenCalled()
  })

  it('requires exactly one container', async () => {
    await expect(conceptGraphService.enqueueGeneration({}, userTwo)).rejects.toThrow(
      'Provide exactly one of topicId or conversationId'
    )
    await expect(
      conceptGraphService.enqueueGeneration(
        { conversationId: conversation._id.toString(), topicId: topic._id.toString() },
        userTwo
      )
    ).rejects.toThrow('Provide exactly one of topicId or conversationId')
    expect(scheduleSpy).not.toHaveBeenCalled()
  })

  it('refuses a participant who owns neither the conversation nor the topic', async () => {
    await expect(
      conceptGraphService.enqueueGeneration({ conversationId: conversation._id.toString() }, participant)
    ).rejects.toThrow('Only the conversation owner, the topic owner, or an administrator')
    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(await Artifact.countDocuments({})).toBe(0)
  })

  it('writes nothing for a container that does not exist', async () => {
    await expect(
      conceptGraphService.enqueueGeneration({ conversationId: new mongoose.Types.ObjectId().toString() }, userTwo)
    ).rejects.toThrow('not found')
    expect(await Artifact.countDocuments({})).toBe(0)
    expect(scheduleSpy).not.toHaveBeenCalled()
  })
})
