import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import artifactService from '../../src/services/artifact.service.js'
import Artifact from '../../src/models/artifact.model/artifact.js'
import ArtifactVersion from '../../src/models/artifact.model/version.js'
import { DOCUMENT_ARTIFACT } from '../../src/models/artifact.model/documentArtifact.js'
import Topic from '../../src/models/topic.model.js'
import Conversation from '../../src/models/conversation.model.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import { insertUsers, userOne, userTwo, participant } from '../fixtures/user.fixture.js'
import { newPublicTopic, insertTopics } from '../fixtures/topic.fixture.js'
import { insertDocumentArtifact } from '../fixtures/artifact.fixture.js'

setupIntTest()

/* There is no socket server in the suite, so the real broadcast would throw. Spying also
   lets the live-update assertion below check what a client would actually receive. */
const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastArtifactVersion')

beforeAll(async () => {
  await ArtifactVersion.syncIndexes()
})

let topic
let conversation

/* userOne owns the topic, userTwo owns the conversation inside it. That split is what makes
   the ownership branches distinguishable: a check that accepted any admin would pass even
   when it is wrong about which owner it is looking at. */
beforeEach(async () => {
  broadcastSpy.mockReset()
  broadcastSpy.mockResolvedValue(undefined)
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
  broadcastSpy.mockRestore()
})

const conversationBody = (overrides = {}) => ({
  type: DOCUMENT_ARTIFACT,
  conversationId: conversation._id.toString(),
  title: 'Shared priorities',
  payload: { body: 'The group converged on three priorities.' },
  ...overrides
})

const topicBody = (overrides = {}) => ({
  type: DOCUMENT_ARTIFACT,
  topicId: topic._id.toString(),
  title: 'Themes across the series',
  payload: { body: 'Across all six sessions...' },
  ...overrides
})

describe('createArtifact', () => {
  it('creates the artifact with its first version and returns the container passcode', async () => {
    const { artifact, version, passcode } = await artifactService.createArtifact(conversationBody(), userTwo)

    expect(artifact!.__t).toBe(DOCUMENT_ARTIFACT)
    expect(artifact!.scope).toBe('conversation')
    expect(artifact!.currentVersionNumber).toBe(1)
    expect(version.versionNumber).toBe(1)
    expect(version.payload).toEqual({ body: 'The group converged on three priorities.' })
    expect(passcode).toEqual(expect.any(String))
  })

  it('points currentVersion at the first version, so a fetch needs no sort', async () => {
    const { artifact, version } = await artifactService.createArtifact(conversationBody(), userTwo)

    /* The create response populates currentVersion, so this is the version document itself
       rather than its id — which is exactly what a client gets back. */
    const current = artifact!.currentVersion as { _id: mongoose.Types.ObjectId }
    expect(current._id.toString()).toBe(version._id!.toString())
  })

  it('denormalizes the conversation topic so the artifact shows up in topic listings', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)

    expect(artifact!.topic!.toString()).toBe(topic._id.toString())
  })

  it('mints the container passcode on first use and reuses it afterwards', async () => {
    const first = await artifactService.createArtifact(conversationBody(), userTwo)
    const second = await artifactService.createArtifact(conversationBody({ title: 'Second' }), userTwo)

    expect(second.passcode).toBe(first.passcode)
    const reloaded = await Conversation.findById(conversation._id).select('artifactPasscode').lean()
    expect(reloaded!.artifactPasscode).toBe(first.passcode)
  })

  it('lets the topic owner create an artifact on a conversation inside their topic', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userOne)

    expect(artifact!.title).toBe('Shared priorities')
  })

  it('refuses a participant who owns neither the conversation nor the topic', async () => {
    await expect(artifactService.createArtifact(conversationBody(), participant)).rejects.toThrow(
      'Only the conversation owner, the topic owner, or an administrator can create artifacts for a conversation'
    )
  })

  it('refuses a participant creating a topic-scoped artifact, which needs an administrator', async () => {
    await expect(artifactService.createArtifact(topicBody(), participant)).rejects.toThrow(
      'Only an administrator can create artifacts for a topic'
    )
  })

  it('lets an administrator create a topic-scoped artifact', async () => {
    const { artifact } = await artifactService.createArtifact(topicBody(), userOne)

    expect(artifact!.scope).toBe('topic')
    expect(artifact!.conversation).toBeUndefined()
  })

  // An agent shaped like the Concept Cartographer: write grant on its own conversation.
  const agentOn = (ownConversation) => ({
    _id: new mongoose.Types.ObjectId(),
    __t: 'Agent',
    conversation: ownConversation,
    capabilities: { read: [{ type: 'ownConversation' }], write: [{ type: 'ownConversation' }] }
  })

  it('lets an agent write a topic-scoped artifact for the topic its own conversation belongs to', async () => {
    const { artifact } = await artifactService.createArtifact(topicBody(), agentOn(conversation))

    expect(artifact!.scope).toBe('topic')
    expect(artifact!.topic?.toString()).toBe(topic._id.toString())
  })

  it('refuses an agent writing to a topic its conversation is not part of', async () => {
    const otherTopic = newPublicTopic()
    otherTopic.owner = userOne._id
    await insertTopics([otherTopic])

    await expect(
      artifactService.createArtifact(topicBody({ topicId: otherTopic._id.toString() }), agentOn(conversation))
    ).rejects.toThrow('An agent may only write artifacts for its own conversation or the topic')
  })

  it('refuses an agent writing to a conversation other than its own', async () => {
    const sibling = await Conversation.create({
      name: 'Session two',
      slug: 'session-two',
      owner: userTwo._id,
      topic: topic._id
    })

    await expect(
      artifactService.createArtifact(conversationBody({ conversationId: sibling._id.toString() }), agentOn(conversation))
    ).rejects.toThrow()
    expect(await Artifact.countDocuments({})).toBe(0)
  })

  it('requires exactly one container', async () => {
    await expect(
      artifactService.createArtifact({ ...conversationBody(), topicId: topic._id.toString() }, userOne)
    ).rejects.toThrow('Provide exactly one of topicId or conversationId')
    await expect(
      artifactService.createArtifact({ ...conversationBody(), conversationId: undefined }, userOne)
    ).rejects.toThrow('Provide exactly one of topicId or conversationId')
  })

  it('rejects an artifact type this build does not support', async () => {
    await expect(artifactService.createArtifact(conversationBody({ type: 'HologramArtifact' }), userTwo)).rejects.toThrow(
      'Unsupported artifact type: HologramArtifact'
    )
  })

  it('rejects a payload that does not match the type, which the Mixed column would not catch', async () => {
    await expect(
      artifactService.createArtifact(conversationBody({ payload: { headline: 'wrong field' } }), userTwo)
    ).rejects.toThrow('Invalid Document artifact payload')
  })

  it('writes nothing for a container that does not exist', async () => {
    await expect(
      artifactService.createArtifact(conversationBody({ conversationId: new mongoose.Types.ObjectId().toString() }), userOne)
    ).rejects.toThrow('not found')
    expect(await Artifact.countDocuments({})).toBe(0)
  })
})

describe('appendVersion', () => {
  it('adds a version, makes it current, and keeps the previous one readable', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)

    const second = await artifactService.appendVersion(
      artifact!._id!.toString(),
      { payload: { body: 'Revised after the breakout.' }, note: 'Folded in breakout notes' },
      userTwo
    )

    const reloaded = await Artifact.findById(artifact!._id).populate('currentVersion')
    expect(second.versionNumber).toBe(2)
    expect(reloaded!.currentVersionNumber).toBe(2)
    expect((reloaded!.currentVersion as { payload: unknown }).payload).toEqual({ body: 'Revised after the breakout.' })
    expect(await ArtifactVersion.countDocuments({ artifact: artifact!._id })).toBe(2)
  })

  it('broadcasts the new version so a client can re-render mid-conversation', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)
    broadcastSpy.mockClear()

    await artifactService.appendVersion(artifact!._id!.toString(), { payload: { body: 'Live update.' } }, userTwo)

    expect(broadcastSpy).toHaveBeenCalledWith(
      conversation._id.toString(),
      expect.objectContaining({ artifactId: artifact!._id!.toString(), type: DOCUMENT_ARTIFACT })
    )
  })

  it('does not lose the append when the broadcast fails', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)
    broadcastSpy.mockRejectedValueOnce(new Error('no socket server'))

    const second = await artifactService.appendVersion(
      artifact!._id!.toString(),
      { payload: { body: 'Survives a dead socket.' } },
      userTwo
    )

    expect(second.versionNumber).toBe(2)
  })

  it('does not broadcast a topic-scoped artifact, which has no conversation room', async () => {
    const { artifact } = await artifactService.createArtifact(topicBody(), userOne)
    broadcastSpy.mockClear()

    await artifactService.appendVersion(artifact!._id!.toString(), { payload: { body: 'Revised.' } }, userOne)

    expect(broadcastSpy).not.toHaveBeenCalled()
  })

  it('refuses a caller holding only the read passcode, which must never authorize a write', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)

    await expect(
      artifactService.appendVersion(artifact!._id!.toString(), { payload: { body: 'Not mine to edit.' } }, participant)
    ).rejects.toThrow('Only the conversation owner, the topic owner, or an administrator')
  })

  it('refuses to revise a locked artifact but leaves its history intact', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)
    await Artifact.updateOne({ _id: artifact!._id }, { $set: { locked: true } })

    await expect(
      artifactService.appendVersion(artifact!._id!.toString(), { payload: { body: 'Too late.' } }, userTwo)
    ).rejects.toThrow('This artifact is locked and cannot be revised')
    expect(await ArtifactVersion.countDocuments({ artifact: artifact!._id })).toBe(1)
  })

  it('rejects a payload that does not match the artifact type', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)

    await expect(
      artifactService.appendVersion(artifact!._id!.toString(), { payload: { body: 42 } }, userTwo)
    ).rejects.not.toBeUndefined()
    expect(await ArtifactVersion.countDocuments({ artifact: artifact!._id })).toBe(1)
  })
})

describe('reads', () => {
  it('lets a passcode holder read the artifact at its latest version', async () => {
    const { artifact, passcode } = await artifactService.createArtifact(conversationBody(), userTwo)
    await artifactService.appendVersion(artifact!._id!.toString(), { payload: { body: 'Latest.' } }, userTwo)

    const read = await artifactService.getArtifact(artifact!._id!.toString(), participant, passcode)

    expect((read.currentVersion as { payload: unknown }).payload).toEqual({ body: 'Latest.' })
  })

  it('lets an owner read without a passcode, since an admin view has none to present', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)

    const read = await artifactService.getArtifact(artifact!._id!.toString(), userTwo)

    expect(read._id!.toString()).toBe(artifact!._id!.toString())
  })

  it('refuses a wrong passcode', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)

    await expect(artifactService.getArtifact(artifact!._id!.toString(), participant, 'wrong-code')).rejects.toThrow(
      artifactService.READ_REFUSAL
    )
  })

  it('refuses a missing passcode', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)

    await expect(artifactService.getArtifact(artifact!._id!.toString(), participant)).rejects.toThrow(
      artifactService.READ_REFUSAL
    )
  })

  it('refuses an unknown artifact id identically, so ids cannot be probed', async () => {
    await expect(
      artifactService.getArtifact(new mongoose.Types.ObjectId().toString(), participant, 'any-code')
    ).rejects.toThrow(artifactService.READ_REFUSAL)
  })

  it('does not accept the topic passcode for a conversation artifact', async () => {
    const { passcode: topicPasscode } = await artifactService.createArtifact(topicBody(), userOne)
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)

    await expect(artifactService.getArtifact(artifact!._id!.toString(), participant, topicPasscode)).rejects.toThrow(
      artifactService.READ_REFUSAL
    )
  })

  it('does not accept a conversation passcode for a sibling conversation artifact', async () => {
    const sibling = await Conversation.create({
      name: 'Session two',
      slug: 'session-two',
      owner: userTwo._id,
      topic: topic._id
    })
    const { passcode: siblingPasscode } = await artifactService.createArtifact(
      conversationBody({ conversationId: sibling._id.toString() }),
      userTwo
    )
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)

    await expect(artifactService.getArtifact(artifact!._id!.toString(), participant, siblingPasscode)).rejects.toThrow(
      artifactService.READ_REFUSAL
    )
  })

  it('never treats a container with no minted passcode as open', async () => {
    const { artifact } = await insertDocumentArtifact({
      topic: topic._id,
      conversation: conversation._id,
      createdBy: userTwo._id
    })

    await expect(artifactService.getArtifact(artifact._id!.toString(), participant, undefined)).rejects.toThrow(
      artifactService.READ_REFUSAL
    )
  })
})

describe('listArtifacts', () => {
  it('returns a conversation artifacts newest first, with the current version inlined', async () => {
    const { passcode } = await artifactService.createArtifact(conversationBody({ title: 'Older' }), userTwo)
    await artifactService.createArtifact(conversationBody({ title: 'Newer' }), userTwo)

    const artifacts = await artifactService.listArtifacts(
      { conversationId: conversation._id.toString() },
      participant,
      passcode
    )

    expect(artifacts.map((a) => a.title)).toEqual(['Newer', 'Older'])
    expect(artifacts[0].currentVersion).toHaveProperty('payload')
  })

  it("includes a topic's conversations' artifacts in the topic listing", async () => {
    await artifactService.createArtifact(conversationBody({ title: 'From the conversation' }), userTwo)
    const { passcode } = await artifactService.createArtifact(topicBody({ title: 'From the topic' }), userOne)

    const artifacts = await artifactService.listArtifacts({ topicId: topic._id.toString() }, participant, passcode)

    expect(artifacts.map((a) => a.title).sort()).toEqual(['From the conversation', 'From the topic'])
  })

  it('excludes another conversation artifacts', async () => {
    const other = await Conversation.create({
      name: 'Unrelated',
      slug: 'unrelated',
      owner: userTwo._id,
      topic: topic._id
    })
    await artifactService.createArtifact(conversationBody({ conversationId: other._id.toString() }), userTwo)
    const { passcode } = await artifactService.createArtifact(conversationBody({ title: 'Mine' }), userTwo)

    const artifacts = await artifactService.listArtifacts(
      { conversationId: conversation._id.toString() },
      participant,
      passcode
    )

    expect(artifacts.map((a) => a.title)).toEqual(['Mine'])
  })

  it('refuses a container that does not exist with the same message as a bad passcode', async () => {
    await expect(
      artifactService.listArtifacts({ conversationId: new mongoose.Types.ObjectId().toString() }, participant, 'code')
    ).rejects.toThrow(artifactService.READ_REFUSAL)
  })

  it('omits a soft-deleted artifact', async () => {
    const { artifact, passcode } = await artifactService.createArtifact(conversationBody(), userTwo)
    await Artifact.updateOne({ _id: artifact!._id }, { $set: { isDeleted: true } })

    const artifacts = await artifactService.listArtifacts(
      { conversationId: conversation._id.toString() },
      participant,
      passcode
    )

    expect(artifacts).toHaveLength(0)
  })
})

describe('version history', () => {
  it('returns every version newest first, paginated', async () => {
    const { artifact, passcode } = await artifactService.createArtifact(conversationBody(), userTwo)
    await artifactService.appendVersion(artifact!._id!.toString(), { payload: { body: 'Second.' } }, userTwo)
    await artifactService.appendVersion(artifact!._id!.toString(), { payload: { body: 'Third.' } }, userTwo)

    const history = await artifactService.listVersions(artifact!._id!.toString(), participant, passcode, {})

    expect(history.totalResults).toBe(3)
    expect(history.results.map((v) => v.versionNumber)).toEqual([3, 2, 1])
  })

  it('fetches one numbered version, so a client can show a point in the history', async () => {
    const { artifact, passcode } = await artifactService.createArtifact(conversationBody(), userTwo)
    await artifactService.appendVersion(artifact!._id!.toString(), { payload: { body: 'Second.' } }, userTwo)

    const version = await artifactService.getVersion(artifact!._id!.toString(), 1, participant, passcode)

    expect(version.payload).toEqual({ body: 'The group converged on three priorities.' })
  })

  it('404s a version number the artifact never had', async () => {
    const { artifact, passcode } = await artifactService.createArtifact(conversationBody(), userTwo)

    await expect(artifactService.getVersion(artifact!._id!.toString(), 9, participant, passcode)).rejects.toThrow(
      'has no version 9'
    )
  })

  it('guards the history behind the same passcode as the artifact', async () => {
    const { artifact } = await artifactService.createArtifact(conversationBody(), userTwo)

    await expect(artifactService.listVersions(artifact!._id!.toString(), participant, 'wrong-code', {})).rejects.toThrow(
      artifactService.READ_REFUSAL
    )
  })
})

describe('getContainerPasscode', () => {
  it('mints a passcode before any artifact exists, so a link can be built first', async () => {
    const passcode = await artifactService.getContainerPasscode({ conversationId: conversation._id.toString() }, userTwo)

    expect(passcode).toEqual(expect.any(String))
    const reloaded = await Conversation.findById(conversation._id).select('artifactPasscode').lean()
    expect(reloaded!.artifactPasscode).toBe(passcode)
  })

  it('returns the existing passcode rather than rotating it and invalidating shared links', async () => {
    const { passcode } = await artifactService.createArtifact(conversationBody(), userTwo)

    const fetched = await artifactService.getContainerPasscode({ conversationId: conversation._id.toString() }, userTwo)

    expect(fetched).toBe(passcode)
  })

  it('refuses a caller who may read the artifacts but not hand out the key', async () => {
    await artifactService.createArtifact(conversationBody(), userTwo)

    await expect(
      artifactService.getContainerPasscode({ conversationId: conversation._id.toString() }, participant)
    ).rejects.toThrow('Only the conversation owner, the topic owner, or an administrator')
  })

  it('keeps the topic passcode out of the serialized topic', async () => {
    await artifactService.getContainerPasscode({ topicId: topic._id.toString() }, userOne)

    const reloaded = await Topic.findById(topic._id)

    expect(reloaded!.artifactPasscode).toEqual(expect.any(String))
    expect(reloaded!.toJSON()).not.toHaveProperty('artifactPasscode')
  })
})
