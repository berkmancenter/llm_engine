import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import Artifact from '../../src/models/artifact.model/artifact.js'
import ArtifactVersion from '../../src/models/artifact.model/version.js'
import DocumentArtifact, { DOCUMENT_ARTIFACT } from '../../src/models/artifact.model/documentArtifact.js'

setupIntTest()

/* The unique index on { artifact, versionNumber } is the backstop behind the version
   allocator, and setupIntTest only clears documents — it never builds indexes. Without
   this the duplicate-version assertion below would silently pass for the wrong reason. */
beforeAll(async () => {
  await ArtifactVersion.syncIndexes()
})

const baseArtifact = (overrides = {}) => ({
  scope: 'conversation' as const,
  topic: new mongoose.Types.ObjectId(),
  conversation: new mongoose.Types.ObjectId(),
  title: 'Shared priorities',
  ...overrides
})

describe('artifact discriminator', () => {
  it('stamps the discriminator key so a client knows which renderer to use', async () => {
    const artifact = await DocumentArtifact.create(baseArtifact())

    const reloaded = await Artifact.findById(artifact._id)

    expect(reloaded!.__t).toBe(DOCUMENT_ARTIFACT)
  })

  it('finds every kind of artifact through the base model, since they share one collection', async () => {
    const conversation = new mongoose.Types.ObjectId()
    await DocumentArtifact.create(baseArtifact({ conversation, title: 'One' }))
    await DocumentArtifact.create(baseArtifact({ conversation, title: 'Two' }))

    const found = await Artifact.find({ conversation })

    expect(found).toHaveLength(2)
  })

  it('publishes the discriminator as `type`, the same name the create request uses', async () => {
    const artifact = await DocumentArtifact.create(baseArtifact())

    const json = artifact.toJSON()

    expect(json.id).toBe(artifact._id!.toString())
    expect(json.type).toBe(DOCUMENT_ARTIFACT)
    expect(json).not.toHaveProperty('__t')
    expect(json).not.toHaveProperty('_id')
    expect(json).not.toHaveProperty('isDeleted')
  })
})

describe('artifact scope invariants', () => {
  it('refuses a conversation-scoped artifact with no conversation, which no listing would return', async () => {
    await expect(
      DocumentArtifact.create({
        scope: 'conversation',
        topic: new mongoose.Types.ObjectId(),
        title: 'Orphan'
      })
    ).rejects.toThrow('A conversation-scoped artifact must reference a conversation.')
  })

  it('refuses a topic-scoped artifact that carries a conversation, which would appear in that conversation', async () => {
    await expect(
      DocumentArtifact.create({
        scope: 'topic',
        topic: new mongoose.Types.ObjectId(),
        conversation: new mongoose.Types.ObjectId(),
        title: 'Mislabelled'
      })
    ).rejects.toThrow('A topic-scoped artifact must not reference a conversation.')
  })

  it('requires a topic even for a conversation-scoped artifact, so topic listings stay complete', async () => {
    await expect(
      DocumentArtifact.create({
        scope: 'conversation',
        conversation: new mongoose.Types.ObjectId(),
        title: 'Topicless'
      })
    ).rejects.toThrow()
  })

  it('accepts a topic-scoped artifact with no conversation', async () => {
    const artifact = await DocumentArtifact.create({
      scope: 'topic',
      topic: new mongoose.Types.ObjectId(),
      title: 'Themes across the series'
    })

    expect(artifact.scope).toBe('topic')
    expect(artifact.conversation).toBeUndefined()
  })
})

describe('artifact version numbering', () => {
  it('starts a new artifact at version 0, since its first version has not landed yet', async () => {
    const artifact = await DocumentArtifact.create(baseArtifact())

    expect(artifact.currentVersionNumber).toBe(0)
  })

  it('allocates a distinct number to each concurrent claim, so neither append loses its edit', async () => {
    const artifact = await DocumentArtifact.create(baseArtifact())

    const claims = await Promise.all(
      [1, 2, 3].map(() =>
        Artifact.findOneAndUpdate({ _id: artifact._id }, { $inc: { currentVersionNumber: 1 } }, { new: true }).exec()
      )
    )

    expect(claims.map((c) => c!.currentVersionNumber).sort()).toEqual([1, 2, 3])
  })

  it('rejects a second version claiming a number already used', async () => {
    const artifact = await DocumentArtifact.create(baseArtifact())
    await ArtifactVersion.create({ artifact: artifact._id, versionNumber: 1, payload: { body: 'first' } })

    await expect(
      ArtifactVersion.create({ artifact: artifact._id, versionNumber: 1, payload: { body: 'collision' } })
    ).rejects.toThrow()
  })

  it('lets two different artifacts each have their own version 1', async () => {
    const one = await DocumentArtifact.create(baseArtifact())
    const two = await DocumentArtifact.create(baseArtifact())

    await ArtifactVersion.create({ artifact: one._id, versionNumber: 1, payload: { body: 'one' } })
    await ArtifactVersion.create({ artifact: two._id, versionNumber: 1, payload: { body: 'two' } })

    expect(await ArtifactVersion.countDocuments({ versionNumber: 1 })).toBe(2)
  })

  it('records no updatedAt on a version, which is never updated', async () => {
    const artifact = await DocumentArtifact.create(baseArtifact())
    const version = await ArtifactVersion.create({
      artifact: artifact._id,
      versionNumber: 1,
      payload: { body: 'first' }
    })

    expect(version.createdAt).toBeDefined()
    expect(version.toJSON()).not.toHaveProperty('updatedAt')
  })
})
