import mongoose, { HydratedDocument, Model } from 'mongoose'
import { toJSON, paginate } from '../plugins/index.js'
import { IArtifact, PaginateResults } from '../../types/index.types.js'

interface ArtifactStatics {
  paginate(filter: unknown, options: unknown): Promise<PaginateResults<IArtifact>>
}

type ArtifactModel = Model<IArtifact, Record<string, never>> & ArtifactStatics

/*
 * The base of the artifact hierarchy. An artifact is a shared object that emerges from one
 * or more conversations — a document, a link, a data model the client renders its own way —
 * and this schema holds only what every kind of artifact has in common. Concrete kinds are
 * mongoose discriminators off this model (see documentArtifact.ts), which keeps them all in
 * one collection so "the artifacts for this conversation" is a single query no matter how
 * many kinds exist.
 *
 * Content is deliberately not here. Every revision of an artifact is kept, so the content
 * lives in ArtifactVersion documents and this schema points at the newest one through
 * `currentVersion`. A discriminator therefore usually adds no paths at all: what varies by
 * kind is the shape of the version payload, declared in registry.ts.
 */
const artifactSchema = new mongoose.Schema<IArtifact, ArtifactModel>(
  {
    scope: {
      type: String,
      enum: ['topic', 'conversation'],
      required: true,
      index: true
    },
    /* Always set, for a conversation-scoped artifact too: denormalizing the conversation's
       topic here is what lets a topic-wide listing stay one indexed query instead of first
       resolving the topic's conversations. artifact.service.ts is the only writer, and a
       conversation never changes topic, so it cannot drift. */
    topic: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Topic',
      required: true,
      index: true
    },
    /* Set only when scope is 'conversation'; the pre-validate hook below enforces that. */
    conversation: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      index: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      trim: true
    },
    currentVersion: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'ArtifactVersion'
    },
    /* Doubles as the version-number allocator: appendVersion claims the next number with a
       single atomic $inc on this field, so two concurrent appends — an agent revising the
       artifact mid-conversation while an organizer saves an edit — get 4 and 5 rather than
       both computing 4 from a stale read. Starts at 0, since a freshly created artifact has
       no version until its first one is appended. */
    currentVersionNumber: {
      type: Number,
      default: 0,
      min: 0
    },
    /* A BaseUser: an organizer who asked for the artifact through the API, or the agent
       that produced it during the conversation. */
    createdBy: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'BaseUser',
      index: true
    },
    /* Refuses further versions. The artifact and its whole history stay readable — this
       closes an artifact for editing, it does not hide it. */
    locked: {
      type: Boolean,
      default: false,
      index: true
    },
    isDeleted: {
      type: Boolean,
      default: false,
      private: true,
      index: true // we query on this
    }
  },
  {
    timestamps: true,
    /* Publish the discriminator key as `type`. Clients switch their renderer on it and pass
       the same word back as `type` when creating an artifact, so leaking mongoose's
       internal `__t` here would make the request and response disagree about the name of
       the one field that identifies the kind. Runs after the toJSON plugin's own transform,
       which is what strips _id and the private paths. */
    toJSON: {
      transform(doc, ret) {
        const { __t, ...rest } = ret
        return { ...rest, ...(__t && { type: __t }) }
      }
    }
  }
)

artifactSchema.plugin(toJSON)
artifactSchema.plugin(paginate)

/* Listing an artifact set is always "this container, newest first", so index it that way
   rather than leaving mongo to sort in memory once an event accumulates versions. */
artifactSchema.index({ conversation: 1, isDeleted: 1, createdAt: -1 })
artifactSchema.index({ topic: 1, isDeleted: 1, createdAt: -1 })

/* The scope field and the two refs have to agree, or a listing silently returns the wrong
   set: a 'conversation' artifact with no conversation would never appear in its own
   conversation's list, and a 'topic' artifact carrying a conversation would appear in a
   list it does not belong to. Enforced here rather than only in the service so no other
   writer (a migration, a future agent tool) can create that state. */
artifactSchema.pre('validate', function (next) {
  if (this.scope === 'conversation' && !this.conversation) {
    next(new Error('A conversation-scoped artifact must reference a conversation.'))
    return
  }
  if (this.scope === 'topic' && this.conversation) {
    next(new Error('A topic-scoped artifact must not reference a conversation.'))
    return
  }
  next()
})

export type ArtifactDocument = HydratedDocument<IArtifact>

/**
 * @typedef Artifact
 */
const Artifact = mongoose.model<IArtifact, ArtifactModel>('Artifact', artifactSchema)
export default Artifact
