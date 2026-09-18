import mongoose from 'mongoose'
import Artifact from './artifact.js'
import { IArtifact } from '../../types/index.types.js'

/*
 * The first concrete artifact kind: prose the client renders. Its version payload is a
 * single `body` text field (see DOCUMENT_ARTIFACT_PAYLOAD in registry.ts).
 *
 * It adds no paths of its own, which is the normal case rather than an omission — what
 * distinguishes one kind of artifact from another is the shape of its version payload and
 * how a client renders it, both of which live outside the base schema. The discriminator
 * exists so `__t` tells a client which renderer to reach for, and so a kind that genuinely
 * does need its own indexed field later has somewhere to put it.
 */
const documentArtifactSchema = new mongoose.Schema<IArtifact>({})

export const DOCUMENT_ARTIFACT = 'DocumentArtifact' as const

/**
 * @typedef DocumentArtifact
 */
const DocumentArtifact = Artifact.discriminator<IArtifact>(DOCUMENT_ARTIFACT, documentArtifactSchema)
export default DocumentArtifact
