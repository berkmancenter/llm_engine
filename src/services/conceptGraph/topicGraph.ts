import { z } from 'zod'
import { traceable } from 'langsmith/traceable'
import logger from '../../config/logger.js'
import { getChatPromptResponse } from '../../agents/helpers/llmChain.js'
import { ConceptGraphPayload } from '../../types/index.types.js'
import { ExtractionResult } from './assemble.js'

/*
 * The pieces a topic-wide graph needs on top of the per-conversation one.
 *
 * A series unfolds over time, so its graph is refined rather than rebuilt: each event that
 * ends is merged into what the topic already knows and saved as a new version. That is
 * cheaper than re-reading six transcripts every time, and it matches how the understanding
 * actually accumulates — but it makes the merge the load-bearing step, because the same idea
 * will come back in different words months apart.
 */

/* How many established concepts to offer the extractor. A series' vocabulary grows without
   bound while the prompt does not, and the most-connected concepts are the ones an event is
   most likely to touch — so the list is capped by degree rather than truncated by age. */
export const KNOWN_CONCEPT_LIMIT = 60

/* How large the series graph itself is allowed to grow before consolidate.ts folds its
   least-connected concepts into more central ones. Deliberately conservative to start:
   there's no usage data yet to calibrate against, and it's easier to raise this once a real
   long-running series approaches it than to have let an unreadable graph accumulate first.
   Below KNOWN_CONCEPT_LIMIT for now as a result — once real graphs approach this cap, revisit
   both together. */
export const CONCEPT_CAP = 42

/*
 * The concepts a series has already established, most connected first.
 *
 * Handing these to the extractor is what lets one event's discussion link into the rest of
 * the series: a model that cannot name an earlier concept cannot relate anything to it, so
 * without this every event's contributions stay inside that event and the topic graph is
 * only ever joined where two events happen to coin the same label independently.
 */
export const knownConceptLabels = (payload?: ConceptGraphPayload): string[] => {
  if (!payload?.concepts?.length) return []
  const degree = new Map<string, number>()
  for (const contribution of payload.contributions ?? []) {
    for (const id of contribution.concepts) degree.set(id, (degree.get(id) ?? 0) + 1)
  }
  return [...payload.concepts]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, KNOWN_CONCEPT_LIMIT)
    .map((c) => c.label)
}

/*
 * Reads a stored graph back into the shape the assembler works in.
 *
 * Assembly is written against labels rather than ids, so a round-trip through this is what
 * lets an existing graph be merged with a new extraction by exactly the same code path that
 * merges two chunks of one transcript — no second merge implementation to drift.
 *
 * Provenance is carried through deliberately. Ids are not: they are derived from canonical
 * content on the way back out, so a concept that survives the merge is assigned the same id
 * it already had, and versions stay diffable.
 */
export const payloadToExtraction = (payload: ConceptGraphPayload): ExtractionResult => {
  const labelById = new Map(payload.concepts.map((c) => [c.id, c.label]))
  const promptById = new Map(payload.originPrompts.map((p) => [p.id, p.text]))

  return {
    concepts: payload.concepts.map((c) => ({
      label: c.label,
      gloss: c.gloss,
      foldedFrom: c.foldedFrom,
      provenance: c.provenance
    })),
    contributions: payload.contributions
      .map((k) => ({
        id: k.id,
        kind: k.kind,
        concepts: k.concepts.map((id) => labelById.get(id)).filter((label): label is string => !!label),
        statement: k.statement,
        originPrompt: k.origin ? promptById.get(k.origin) : undefined,
        provenance: k.provenance
      }))
      /* A contribution whose concepts no longer resolve cannot be re-expressed in labels, so
         it is left behind rather than re-entered half-formed. In practice this only fires on
         a graph written before some concept was dropped by a later safety pass. */
      .filter((k) => k.concepts.length > 0),
    originPrompts: payload.originPrompts.map((p) => ({ text: p.text, provenance: p.provenance }))
  }
}

const ALIAS_SCHEMA = z.object({
  groups: z
    .array(
      z.object({
        canonical: z.string().describe('The clearest label for the shared idea, copied exactly from the list.'),
        aliases: z.array(z.string()).describe('The other labels for that same idea, copied exactly from the list.')
      })
    )
    .describe('Only genuine duplicates. Empty when every label is a distinct idea.')
})

const ALIAS_PROMPT = `
You are tidying the concept list of a map built across several sessions of one discussion
series. Because the sessions happened months apart, the same idea often appears under
different wording.

Given the list of concept labels, group together only those that name the SAME idea, and
pick the clearest label in each group as the canonical one.

Group these:
- straightforward rewordings of one idea ("trust registry" / "registry of trusted issuers")
- an abbreviation and its expansion ("VC" / "verifiable credential")
- singular and plural, or a different part of speech, for one idea

Do NOT group:
- two ideas that are merely related, or where one is part of the other ("credential" and
  "credential schema" are different concepts, and collapsing them loses the relationship
  between them, which is what this map is for)
- a general idea and a specific instance of it
- opposites, or two sides of a debate

Merging two distinct concepts destroys information that cannot be recovered, while leaving
a duplicate merely makes the map slightly redundant. When the two readings are close, leave
them apart.

Return only genuine duplicate groups. An empty list is a perfectly good answer.
`.trim()

/**
 * Asks a model which concept labels name the same idea, for AssemblyOptions.aliases.
 *
 * Canonical folding already collapses casing, punctuation and plurals; this catches what it
 * cannot see, which is the whole difficulty of merging a series rather than a single event.
 * Kept to labels alone — a short list, one call, no transcript — so it stays cheap enough to
 * run on every refinement.
 *
 * Fails open, unlike the identity screen: a merge that does not happen leaves a redundant
 * node, which is a cosmetic problem, where a dropped safety check would be a privacy one.
 */
export const resolveConceptAliases = async (llm, labels: string[], topicId?: string): Promise<string[][]> => {
  if (labels.length < 2) return []

  try {
    const result = (await traceable(
      async () =>
        getChatPromptResponse(
          llm,
          ALIAS_PROMPT,
          'Concept labels:\n\n{labels}',
          { labels: labels.join('\n') },
          undefined,
          ALIAS_SCHEMA
        ),
      { name: 'conceptGraphAliasResolution', metadata: { topicId, costPhase: 'postEvent' as const } }
    )()) as z.infer<typeof ALIAS_SCHEMA>

    const known = new Set(labels.map((l) => l.toLowerCase().trim()))
    const groups: string[][] = []
    for (const group of result?.groups ?? []) {
      /* Only labels that were actually in the list: a model that invents or paraphrases one
         would otherwise fold a concept onto a name nothing else uses, quietly renaming it. */
      const members = [group.canonical, ...(group.aliases ?? [])].filter(
        (label) => typeof label === 'string' && known.has(label.toLowerCase().trim())
      )
      if (members.length > 1) groups.push(members)
    }
    if (groups.length > 0) logger.debug(`conceptGraph: alias resolution merged ${groups.length} concept group(s)`)
    return groups
  } catch (error) {
    logger.warn(`conceptGraph: alias resolution failed for topic ${topicId}, merging on exact labels only: ${error}`)
    return []
  }
}

export default { payloadToExtraction, resolveConceptAliases, knownConceptLabels, KNOWN_CONCEPT_LIMIT, CONCEPT_CAP }
