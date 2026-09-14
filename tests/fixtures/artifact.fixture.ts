/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from 'mongoose'
import faker from 'faker'
import Artifact from '../../src/models/artifact.model/artifact.js'
import ArtifactVersion from '../../src/models/artifact.model/version.js'
import { DOCUMENT_ARTIFACT } from '../../src/models/artifact.model/documentArtifact.js'

/* Built through the models rather than insertMany so the discriminator key lands on the
   document — an artifact inserted without `__t` would fail payload validation on every
   later append, since the service looks the payload rule up by that key. */
const insertDocumentArtifact = async ({
  topic,
  conversation,
  createdBy,
  title = faker.lorem.words(),
  body = faker.lorem.paragraph(),
  locked = false
}: any) => {
  const artifact = await Artifact.create({
    __t: DOCUMENT_ARTIFACT,
    scope: conversation ? 'conversation' : 'topic',
    topic,
    ...(conversation && { conversation }),
    title,
    createdBy,
    locked,
    currentVersionNumber: 1
  })
  const version = await ArtifactVersion.create({
    artifact: artifact._id,
    versionNumber: 1,
    payload: { body },
    createdBy
  })
  artifact.currentVersion = version._id
  await artifact.save()
  return { artifact, version }
}

const documentArtifactPost = (container: any) => ({
  type: DOCUMENT_ARTIFACT,
  ...container,
  title: faker.lorem.words(),
  payload: { body: faker.lorem.paragraph() }
})

const unknownArtifactId = () => new mongoose.Types.ObjectId().toString()

export { insertDocumentArtifact, documentArtifactPost, unknownArtifactId }
