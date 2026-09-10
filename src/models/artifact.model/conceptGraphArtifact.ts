import mongoose from 'mongoose'
import Artifact from './artifact.js'
import { IArtifact } from '../../types/index.types.js'

/*
 * A graph of the concepts an event surfaced and how they relate.
 *
 * The shape that makes it worth its own kind: a relationship is not an edge, it is a node.
 * A contribution reifies the relationship between concepts, which lets one contribution
 * link three or more concepts at once — "Issuer / Verifier / Trust Registry co-governs" —
 * something a plain edge cannot express. Concepts therefore never reference each other
 * directly; they are always joined through a contribution.
 *
 * Origin prompts are the third node kind: the question or prompt a concept or contribution
 * came out of. They attach by a direct optional `origin` reference rather than through a
 * contribution, because an origin is attribution rather than a relationship between
 * concepts — and because a client sizes nodes by how many links touch them, so counting
 * origins as contributions would inflate whichever concepts happen to be best attributed.
 *
 * Nothing about layout is stored: position, radius and colour are all derived by the
 * client from the graph itself (see CONCEPT_GRAPH_PAYLOAD in registry.ts for the full
 * shape).
 */
const conceptGraphArtifactSchema = new mongoose.Schema<IArtifact>({})

export const CONCEPT_GRAPH_ARTIFACT = 'ConceptGraphArtifact' as const

/**
 * @typedef ConceptGraphArtifact
 */
const ConceptGraphArtifact = Artifact.discriminator<IArtifact>(CONCEPT_GRAPH_ARTIFACT, conceptGraphArtifactSchema)
export default ConceptGraphArtifact
