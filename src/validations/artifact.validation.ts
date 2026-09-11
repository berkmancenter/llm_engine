import Joi from 'joi'
import { objectId } from './custom.validation.js'
import { artifactTypes } from '../models/artifact.model/registry.js'

/* The passcode a client presents to read an artifact. Every read route accepts it as a
   query parameter, the same way transcript routes take their channel credentials, so a
   link can carry it and an owner can leave it off. */
const artifactPasscode = Joi.string()

/* Deliberately unvalidated here beyond "an object": the payload's real shape depends on the
   artifact type, and artifact.service.ts validates it against that type's schema from the
   registry. Duplicating the per-type rules in this file would mean adding a new artifact
   kind in two places. */
const payload = Joi.object().required()

const createArtifact = {
  body: Joi.object()
    .keys({
      type: Joi.string()
        .valid(...artifactTypes)
        .required(),
      topicId: Joi.string().custom(objectId),
      conversationId: Joi.string().custom(objectId),
      title: Joi.string().required(),
      description: Joi.string().allow('', null),
      payload,
      note: Joi.string().allow('', null)
    })
    /* Exactly one container. Enforced here so the obvious client mistake is a clear 400
       rather than reaching the service, and again in the service for non-HTTP callers. */
    .xor('topicId', 'conversationId')
}

const appendVersion = {
  params: Joi.object().keys({
    artifactId: Joi.string().custom(objectId).required()
  }),
  body: Joi.object().keys({
    payload,
    note: Joi.string().allow('', null)
  })
}

const listArtifacts = {
  query: Joi.object()
    .keys({
      topicId: Joi.string().custom(objectId),
      conversationId: Joi.string().custom(objectId),
      artifactPasscode
    })
    .xor('topicId', 'conversationId')
}

/* Either one event, or a whole series. A conversation builds a graph from that event's own
   record; a topic folds every conversation under it into one graph, and is also how a series
   that predates this feature gets backfilled. */
const generateConceptGraph = {
  body: Joi.object()
    .keys({
      conversationId: Joi.string().custom(objectId),
      topicId: Joi.string().custom(objectId)
    })
    .xor('conversationId', 'topicId')
}

const getContainerPasscode = {
  query: Joi.object()
    .keys({
      topicId: Joi.string().custom(objectId),
      conversationId: Joi.string().custom(objectId)
    })
    .xor('topicId', 'conversationId')
}

const getArtifact = {
  params: Joi.object().keys({
    artifactId: Joi.string().custom(objectId).required()
  }),
  query: Joi.object().keys({
    artifactPasscode
  })
}

const listVersions = {
  params: Joi.object().keys({
    artifactId: Joi.string().custom(objectId).required()
  }),
  query: Joi.object().keys({
    artifactPasscode,
    sortBy: Joi.string(),
    limit: Joi.number().integer().min(1),
    page: Joi.number().integer().min(1)
  })
}

const getVersion = {
  params: Joi.object().keys({
    artifactId: Joi.string().custom(objectId).required(),
    versionNumber: Joi.number().integer().min(1).required()
  }),
  query: Joi.object().keys({
    artifactPasscode
  })
}

const artifactValidation = {
  createArtifact,
  appendVersion,
  generateConceptGraph,
  listArtifacts,
  getContainerPasscode,
  getArtifact,
  listVersions,
  getVersion
}
export default artifactValidation
