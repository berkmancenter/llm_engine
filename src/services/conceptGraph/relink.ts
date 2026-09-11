import { z } from 'zod'
import { traceable } from 'langsmith/traceable'
import logger from '../../config/logger.js'
import { getChatPromptResponse } from '../../agents/helpers/llmChain.js'
import { ExtractionResult } from './assemble.js'

/*
 * Reconsiders what the series already believed in the light of what a new event introduced.
 *
 * Offering the extractor the established vocabulary (see knownConceptLabels) lets a NEW
 * statement reach an OLD concept. This is the other direction, which nothing else covers: an
 * OLD statement whose relevance only becomes visible once a later event names the idea it was
 * really about. Session one argues that a registry is worthless unless somebody checks it;
 * session four introduces revocation, and only then is it clear the two were about the same
 * thing. Without a pass like this the graph never makes that connection, because session
 * one's extraction could not have named a concept that did not exist yet.
 *
 * Two ways to record it, and the difference matters:
 *
 *   An EXTENSION adds a concept to an existing contribution. It is the tighter fit, but it
 *   changes what a settled claim asserts — a contribution is n-ary, so "checked by" over
 *   [Registry, Verifier] plus Revocation now says all three stand in that one relationship.
 *   Allowed only where the existing `kind` genuinely still holds over the larger set.
 *
 *   A BRIDGE is a new contribution joining the old concept to the new one, with its own
 *   relationship and its own sentence. It is what the reified-relationship model is for:
 *   "the series later connected these" is itself a fact about the series, and recording it as
 *   its own node leaves the original claim exactly as it was.
 *
 * Bridges are the default and extensions are the exception, because a wrong bridge is a
 * redundant edge while a wrong extension quietly rewrites something a person may already have
 * read. Neither ever removes anything.
 *
 * Auditability comes from versioning rather than from a marker on the node: ids are stable
 * across versions, so diffing the previous version against this one shows exactly which
 * contributions gained an endpoint and which bridges appeared.
 */

/* Per contribution, so an over-eager pass cannot turn one statement into a hub joining
   everything the series has ever discussed. */
const MAX_ADDITIONS_PER_CONTRIBUTION = 2

const RELINK_SCHEMA = z.object({
  extensions: z
    .array(
      z.object({
        index: z.number().describe('The [n] index of the existing statement.'),
        addConcepts: z.array(z.string()).describe('Newly introduced concept labels, copied exactly.'),
        kindStillHolds: z
          .boolean()
          .describe('True only if the statement’s existing relationship label is still accurate over the larger set.')
      })
    )
    .describe('Existing statements that are genuinely about a newly introduced concept. Usually few; empty is fine.'),
  bridges: z
    .array(
      z.object({
        kind: z.string().describe('The relationship in 1-3 words.'),
        concepts: z.array(z.string()).describe('Labels being joined: at least one established and one new, copied exactly.'),
        statement: z.string().describe('One sentence saying what connects them. Your own words.')
      })
    )
    .describe('New relationships the later event revealed between established and new concepts.')
})

const RELINK_PROMPT = `
You are maintaining a concept map built across a series of discussions. A new session has
just introduced some concepts the map did not have before. Your job is to notice where the
map ALREADY contained something that was really about one of those new concepts, without
having a name for it at the time.

You are given the existing statements, each numbered, and the list of newly introduced
concepts.

Return two kinds of connection:

EXTENSIONS — an existing statement that is genuinely, substantively about one of the new
concepts. Give the statement's index and the new concept labels it reaches. Also say whether
the statement's existing relationship label still describes the relationship accurately once
those concepts are included. Be strict about that: if adding the concept makes the existing
label a poor description of the whole set, say so, and it will be recorded as a bridge
instead.

BRIDGES — a relationship the new session reveals between an established concept and a new
one, that no existing statement already expresses. Give it a short relationship label, the
concepts it joins, and one sentence in your own words.

Hold a high bar. A map whose every statement reaches every concept says nothing at all; the
value here is in the few connections that are really there. Most existing statements will
have no relationship to the new concepts, and returning nothing for them is the correct
answer. Never connect two things merely because they share a topic, and never restate a
connection the map already has.

Do not name any person, and do not quote anyone. Write in your own words throughout.
`.trim()

export interface RelinkResult {
  /* Additions keyed by the contribution's index in the prior extraction. */
  extensions: Map<number, string[]>
  /* New contributions to append, in extraction form. */
  bridges: ExtractionResult['contributions']
}

const EMPTY: RelinkResult = { extensions: new Map(), bridges: [] }

/**
 * Asks which settled statements reach concepts a later event introduced.
 *
 * @param llm Chat model.
 * @param prior The series graph as it stood, in extraction form.
 * @param newConceptLabels Labels introduced by this refinement and not present before.
 * @param topicId For cost attribution.
 */
export const proposeRelinks = async (
  llm,
  prior: ExtractionResult,
  newConceptLabels: string[],
  topicId?: string
): Promise<RelinkResult> => {
  const statements = prior?.contributions ?? []
  if (statements.length === 0 || newConceptLabels.length === 0) return EMPTY

  const numbered = statements
    .map((c, i) => `[${i}] ${c.kind} — joins: ${c.concepts.join(', ')}${c.statement ? ` — "${c.statement}"` : ''}`)
    .join('\n')

  try {
    const result = (await traceable(
      async () =>
        getChatPromptResponse(
          llm,
          RELINK_PROMPT,
          'Existing statements:\n\n{numbered}\n\nNewly introduced concepts:\n\n{newConcepts}',
          { numbered, newConcepts: newConceptLabels.join('\n') },
          undefined,
          RELINK_SCHEMA
        ),
      { name: 'conceptGraphRelink', metadata: { topicId, costPhase: 'postEvent' as const } }
    )()) as z.infer<typeof RELINK_SCHEMA>

    const isNew = new Set(newConceptLabels.map((l) => l.toLowerCase().trim()))
    const known = new Set(
      [...(prior.concepts ?? []).map((c) => c.label), ...newConceptLabels].map((l) => l.toLowerCase().trim())
    )

    const extensions = new Map<number, string[]>()
    const bridges: ExtractionResult['contributions'] = []

    for (const proposal of result?.extensions ?? []) {
      const target = statements[proposal?.index]
      if (!target) continue
      /* Only labels this refinement actually introduced, and only ones the model copied
         rather than invented — an invented label would attach the statement to a node that
         does not exist, and assembly would then drop the whole contribution. */
      const additions = (proposal.addConcepts ?? [])
        .filter((label) => typeof label === 'string' && isNew.has(label.toLowerCase().trim()))
        .filter((label) => !target.concepts.some((existing) => existing.toLowerCase().trim() === label.toLowerCase().trim()))
        .slice(0, MAX_ADDITIONS_PER_CONTRIBUTION)
      if (additions.length === 0) continue

      if (proposal.kindStillHolds) {
        extensions.set(proposal.index, additions)
      } else {
        /* The connection is real but the old label no longer describes it, so it becomes its
           own relationship rather than distorting the original claim. */
        bridges.push({
          kind: 'relates to',
          concepts: [...target.concepts, ...additions],
          statement: target.statement
        })
      }
    }

    for (const bridge of result?.bridges ?? []) {
      const concepts = (bridge.concepts ?? []).filter(
        (label) => typeof label === 'string' && known.has(label.toLowerCase().trim())
      )
      /* A bridge that does not actually cross is just another within-session edge, and the
         extraction has already had its chance to produce those. */
      const crosses =
        concepts.some((l) => isNew.has(l.toLowerCase().trim())) && concepts.some((l) => !isNew.has(l.toLowerCase().trim()))
      if (concepts.length < 2 || !crosses || !bridge.kind?.trim()) continue
      bridges.push({ kind: bridge.kind.trim(), concepts, statement: bridge.statement })
    }

    if (extensions.size > 0 || bridges.length > 0) {
      logger.debug(`conceptGraph: relink proposed ${extensions.size} extension(s) and ${bridges.length} bridge(s)`)
    }
    return { extensions, bridges }
  } catch (error) {
    /* Fails open, like alias resolution and unlike the identity screen: a connection not
       made leaves the map as it already was, which is merely incomplete. */
    logger.warn(`conceptGraph: relink pass failed for topic ${topicId}, leaving the graph unlinked: ${error}`)
    return EMPTY
  }
}

/**
 * Applies a relink result, returning the extraction results to assemble.
 *
 * Extensions are folded into a copy of the prior extraction, so an extended contribution
 * keeps the provenance it was written with — the statement still came from the session that
 * made it, even though the series only later saw what it reached.
 *
 * Bridges come back as a separate result rather than being folded in, precisely so they do
 * NOT inherit that carried provenance: a bridge is a new observation, belonging to the
 * session that revealed it, and assembly stamps it accordingly.
 */
export const applyRelinks = (prior: ExtractionResult, { extensions, bridges }: RelinkResult): ExtractionResult[] => {
  const extended: ExtractionResult = {
    ...prior,
    contributions: prior.contributions.map((contribution, index) => {
      const additions = extensions.get(index)
      return additions ? { ...contribution, concepts: [...contribution.concepts, ...additions] } : contribution
    })
  }
  if (bridges.length === 0) return [extended]
  return [extended, { concepts: [], contributions: bridges, originPrompts: [] }]
}

export default { proposeRelinks, applyRelinks, MAX_ADDITIONS_PER_CONTRIBUTION }
