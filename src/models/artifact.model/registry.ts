import Joi from 'joi'
/* Load-bearing beyond the constant: importing this module is what registers the
   discriminator with mongoose, and every writer reaches the registry before it creates an
   artifact. Inlining the string here would leave `Artifact.create({ __t: ... })` failing on
   an unregistered discriminator in any process that never imported the model directly. */
import { DOCUMENT_ARTIFACT } from './documentArtifact.js'

/*
 * Every artifact kind the API accepts, and the shape of that kind's version payload.
 *
 * This is the whole extension point. Adding a kind — a link to an external resource, a
 * custom data model the client renders its own way, whatever comes next — means adding a
 * discriminator model and one entry here. No route, controller, validation schema or
 * service function changes, because the generic create/append endpoints look the payload
 * rule up by the caller's `type` instead of switching on it.
 *
 * The payload is validated here rather than in the version schema because the version
 * model is shared by every kind and so has to store the payload as Mixed; a Joi schema per
 * kind is what keeps "Mixed" from meaning "unvalidated".
 */
export interface ArtifactKind {
  /* Human-readable name, used in the type-not-supported error and in the API docs. */
  label: string
  /* Validates the version payload for this kind. Unknown keys are rejected, so a client
     typo surfaces as a 400 rather than silently persisting a field nothing reads. */
  payloadSchema: Joi.Schema
}

const artifactKinds: Record<string, ArtifactKind> = {
  [DOCUMENT_ARTIFACT]: {
    label: 'Document',
    payloadSchema: Joi.object()
      .keys({
        body: Joi.string().required()
      })
      .required()
  }
}

/** The discriminator keys a client may pass as `type`, for validation and error messages. */
export const artifactTypes = Object.keys(artifactKinds)

/** The registered kind, or undefined when `type` names nothing this build supports. */
export const artifactKind = (type: string): ArtifactKind | undefined => artifactKinds[type]

export default artifactKinds
