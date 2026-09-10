import mongoose, { HydratedDocument, Model } from 'mongoose'
import { toJSON, paginate } from '../plugins/index.js'
import { IArtifactVersion, PaginateResults } from '../../types/index.types.js'

interface ArtifactVersionStatics {
  paginate(filter: unknown, options: unknown): Promise<PaginateResults<IArtifactVersion>>
}

type ArtifactVersionModel = Model<IArtifactVersion, Record<string, never>> & ArtifactVersionStatics

/*
 * One immutable revision of an artifact.
 *
 * Append-only by design: an edit writes a new version and repoints the artifact's
 * `currentVersion`, and nothing in the codebase updates or deletes a version document. That
 * is what makes the whole history available through the versions API, and it is why an
 * artifact updated live during a conversation leaves a readable trail of how it got there
 * rather than just its final state.
 *
 * Separate collection rather than an array on the artifact: a live-updated artifact can
 * accumulate a lot of revisions, and embedding them would put the history under mongo's
 * 16MB document ceiling and make every "just give me the current artifact" read pull every
 * revision ever written.
 */
const artifactVersionSchema = new mongoose.Schema<IArtifactVersion, ArtifactVersionModel>(
  {
    artifact: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Artifact',
      required: true,
      index: true
    },
    /* 1-based and contiguous per artifact. Clients address a version by this number, not by
       id, since it is what a history view shows. */
    versionNumber: {
      type: Number,
      required: true,
      min: 1
    },
    /* Shape depends on the artifact's discriminator, so it cannot be declared here; it is
       validated against the kind's schema in registry.ts before the write. */
    payload: {
      type: mongoose.SchemaTypes.Mixed,
      required: true
    },
    createdBy: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'BaseUser',
      index: true
    },
    note: {
      type: String,
      trim: true
    }
  },
  {
    /* No updatedAt: a version is never updated, so a field implying it could be would be a
       lie to anyone reading a history. */
    timestamps: { createdAt: true, updatedAt: false }
  }
)

artifactVersionSchema.plugin(toJSON)
artifactVersionSchema.plugin(paginate)

/* The real guard on version numbering. artifact.service.ts derives the next number from the
   current highest, which two concurrent appends (an agent mid-conversation and an organizer
   saving an edit) can read as the same value; this index makes the loser fail loudly so the
   service can retry, instead of writing a duplicate version 4 and losing one of the two. */
artifactVersionSchema.index({ artifact: 1, versionNumber: 1 }, { unique: true })

export type ArtifactVersionDocument = HydratedDocument<IArtifactVersion>

/**
 * @typedef ArtifactVersion
 */
const ArtifactVersion = mongoose.model<IArtifactVersion, ArtifactVersionModel>('ArtifactVersion', artifactVersionSchema)
export default ArtifactVersion
