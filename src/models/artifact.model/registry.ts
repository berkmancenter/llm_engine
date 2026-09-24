import Joi from 'joi'
/* Load-bearing beyond the constants: importing these modules is what registers the
   discriminators with mongoose, and every writer reaches the registry before it creates an
   artifact. Inlining the strings here would leave `Artifact.create({ __t: ... })` failing
   on an unregistered discriminator in any process that never imported the model directly. */
import { DOCUMENT_ARTIFACT } from './documentArtifact.js'
import { CONCEPT_GRAPH_ARTIFACT } from './conceptGraphArtifact.js'

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

/* Where a node came from. Optional throughout: a graph an agent assembles from a whole
   event, or one an organizer writes by hand, has no single message to point at, while one
   built live from the transcript can attribute nearly every node. `conversationId` earns
   its place even though the artifact already knows its own container, because a
   topic-scoped graph draws on several conversations. */
const PROVENANCE = Joi.object().keys({
  conversationId: Joi.string(),
  messageId: Joi.string(),
  pseudonym: Joi.string(),
  /* The poll a node was seeded or cited from — see PollRefMap / provenanceFor in
     services/conceptGraph/assemble.ts. */
  pollId: Joi.string()
})

/* An idea or entity. `id` is opaque and stable so renaming a concept stays an edit to one
   node rather than a delete plus a create, which is what keeps two versions of a graph
   diffable; `label` is what a client draws. */
const CONCEPT = Joi.object().keys({
  id: Joi.string().required(),
  label: Joi.string().required(),
  origin: Joi.string(),
  provenance: PROVENANCE
})

/* A relationship, reified as a node so it can join more than the two concepts an edge
   allows. `kind` is the relationship's name, the label a client renders on the node
   ("anchors", "issued by", "co-governs"). */
const CONTRIBUTION = Joi.object().keys({
  id: Joi.string().required(),
  kind: Joi.string().required(),
  /* The sentence behind the node's short `kind` label. Optional: a graph written by hand,
     or one whose relationships are self-evident from their labels, needs no prose. */
  statement: Joi.string(),
  /* One is allowed, not just two: a contribution attached to a single concept is a
     meaningful intermediate state while a graph is still being built live. */
  concepts: Joi.array().items(Joi.string()).min(1).required(),
  origin: Joi.string(),
  provenance: PROVENANCE
})

/* The prompt or question a concept or contribution came out of. */
const ORIGIN_PROMPT = Joi.object().keys({
  id: Joi.string().required(),
  text: Joi.string().required(),
  provenance: PROVENANCE
})

/*
 * The checks Joi's per-field rules cannot express, run once the individual nodes are known
 * to be well formed.
 *
 * Ids are unique across all three node arrays, not just within each one. A client builds a
 * single id-keyed map of every node to draw the graph, so a concept and a contribution
 * sharing an id silently loses one of them at render time rather than failing here.
 *
 * References have to resolve. A contribution naming a concept that is not in the payload,
 * or an `origin` naming no prompt, would draw an edge to nothing — and since the payload is
 * stored as Mixed, this validator is the only thing standing between a typo and a graph
 * that renders wrong for every future reader of that version.
 */
const graphIntegrity = (payload, helpers) => {
  const { concepts = [], contributions = [], originPrompts = [] } = payload

  const seen = new Set<string>()
  for (const node of [...concepts, ...contributions, ...originPrompts]) {
    if (seen.has(node.id)) return helpers.message(`Duplicate node id in graph: ${node.id}`)
    seen.add(node.id)
  }

  const conceptIds = new Set<string>(concepts.map((c) => c.id))
  for (const contribution of contributions) {
    for (const conceptId of contribution.concepts) {
      if (!conceptIds.has(conceptId)) {
        return helpers.message(`Contribution ${contribution.id} references unknown concept: ${conceptId}`)
      }
    }
  }

  const originIds = new Set<string>(originPrompts.map((p) => p.id))
  for (const node of [...concepts, ...contributions]) {
    if (node.origin && !originIds.has(node.origin)) {
      return helpers.message(`Node ${node.id} references unknown origin prompt: ${node.origin}`)
    }
  }

  return payload
}

/*
 * Concepts, the contributions relating them, and the prompts they came from.
 *
 * Every array defaults to empty, so an organizer can create the artifact when an event
 * starts and let it fill in as the conversation runs, rather than having to wait until
 * there is something to say.
 */
const CONCEPT_GRAPH_PAYLOAD = Joi.object()
  .keys({
    concepts: Joi.array().items(CONCEPT).default([]),
    contributions: Joi.array().items(CONTRIBUTION).default([]),
    originPrompts: Joi.array().items(ORIGIN_PROMPT).default([])
  })
  .required()
  .custom(graphIntegrity)

const artifactKinds: Record<string, ArtifactKind> = {
  [DOCUMENT_ARTIFACT]: {
    label: 'Document',
    payloadSchema: Joi.object()
      .keys({
        body: Joi.string().required()
      })
      .required()
  },
  [CONCEPT_GRAPH_ARTIFACT]: {
    label: 'Concept graph',
    payloadSchema: CONCEPT_GRAPH_PAYLOAD
  }
}

/** The discriminator keys a client may pass as `type`, for validation and error messages. */
export const artifactTypes = Object.keys(artifactKinds)

/** The registered kind, or undefined when `type` names nothing this build supports. */
export const artifactKind = (type: string): ArtifactKind | undefined => artifactKinds[type]

export default artifactKinds
