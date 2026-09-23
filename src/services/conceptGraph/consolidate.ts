import { z } from 'zod'
import { traceable } from 'langsmith/traceable'
import logger from '../../config/logger.js'
import { getChatPromptResponse } from '../../agents/helpers/llmChain.js'

/*
 * Proposes AssemblyOptions.foldedGroups (assemble.ts) for a series graph that has grown past
 * CONCEPT_CAP (topicGraph.ts).
 *
 * Deliberately its own prompt, not a loosened ALIAS_PROMPT (topicGraph.ts): alias resolution's
 * whole job is catching genuine synonyms, and it is conservative on purpose — "merging two
 * distinct concepts destroys information that cannot be recovered." This pass is the opposite
 * instruction. It only runs once the map is too large to show every case at its own size, and
 * its job is to say which of the least-connected ideas are narrow enough cases of a more
 * central one that folding them in loses nothing a reader would miss — which is exactly the
 * kind of merge ALIAS_PROMPT is written to refuse. Reusing or loosening that prompt would teach
 * it to merge things it exists to leave alone; this module exists so it doesn't have to.
 */

const CONSOLIDATE_SCHEMA = z.object({
  folds: z
    .array(
      z.object({
        into: z
          .string()
          .describe('The more central concept this group folds into, copied exactly from the list of central concepts.'),
        fold: z
          .array(z.string())
          .describe('Labels of least-connected concepts that belong inside it, copied exactly from that list.')
      })
    )
    .describe('Only groups you are genuinely confident belong together at a coarser grain. Empty is a fine answer.')
})

const CONSOLIDATE_PROMPT = `
You are trimming an overgrown concept map, built across many sessions of one discussion
series, back down to a size a reader can actually take in.

You are given two lists: the map's LEAST-CONNECTED concepts — the ones with the fewest
relationships to the rest of the map — each with its own short gloss, and the map's MORE
CENTRAL concepts they might belong inside, each with its own gloss too.

For each least-connected concept that is genuinely a narrower case, a specific instance, or a
restatement of one of the central ideas, propose folding it into that central idea. The
central idea's own label and meaning are unaffected — the folded concept simply stops being
its own node, and what it meant is kept alongside the central concept's own description, so
nothing about it is lost, only shown at a coarser grain.

This is NOT the same job as spotting exact duplicates. You may fold a concept that is
related-but-distinct into a broader one specifically because the map has grown too large to
show every case at its own size — a concept close enough that a reader would comfortably find
it described under the central idea is worth folding, even if the two are not, strictly, the
same idea.

Still, do not fold:
- two ideas that are genuinely opposed, or two sides of a live debate — a fold should never
  make a central concept's own position look like something it never took
- a least-connected concept whose gloss describes something meaningfully distinct from
  anything the central concept's own gloss already covers
- two central, well-connected concepts into each other — only fold a least-connected concept
  into a more central one, never the reverse

Be decisive: this pass only runs because the map is over its size limit, so an empty or
overly cautious answer defeats the purpose of asking. But a fold that loses real, distinct
meaning is worse than leaving the map oversized, so hold the line above where it matters.
`.trim()

export interface ConsolidationCandidate {
  label: string
  gloss?: string
  /* How many contribution links this concept has — purely informational context for the
     model's own judgment; it does not change what a candidate/central split already decided. */
  degree: number
}

/**
 * @param candidates The least-connected concepts, fold candidates.
 * @param central The more central concepts a candidate might fold into.
 * @returns Groups shaped like AssemblyOptions.aliases/foldedGroups — each group's first entry
 *   is the surviving (central) label, the rest are labels to fold into it.
 *
 * Fails open, like alias resolution: a fold that doesn't happen leaves the graph merely over
 * size, which the caller re-checks on the series' next refinement — it never drops content on
 * its own, so a failure here costs nothing but a delay.
 */
export const proposeConsolidations = async (
  llm,
  candidates: ConsolidationCandidate[],
  central: ConsolidationCandidate[],
  topicId?: string
): Promise<string[][]> => {
  if (candidates.length === 0 || central.length === 0) return []

  const describe = (c: ConsolidationCandidate) => `- "${c.label}"${c.gloss ? `: ${c.gloss}` : ''} (connects to ${c.degree})`
  const listedCandidates = candidates.map(describe).join('\n')
  const listedCentral = central.map(describe).join('\n')

  try {
    const result = (await traceable(
      async () =>
        getChatPromptResponse(
          llm,
          CONSOLIDATE_PROMPT,
          'Least-connected concepts:\n\n{candidates}\n\nMore central concepts they might fold into:\n\n{central}',
          { candidates: listedCandidates, central: listedCentral },
          undefined,
          CONSOLIDATE_SCHEMA
        ),
      { name: 'conceptGraphConsolidation', metadata: { topicId, costPhase: 'postEvent' as const } }
    )()) as z.infer<typeof CONSOLIDATE_SCHEMA>

    const knownCandidates = new Set(candidates.map((c) => c.label.toLowerCase().trim()))
    const knownCentral = new Set(central.map((c) => c.label.toLowerCase().trim()))
    const groups: string[][] = []
    for (const fold of result?.folds ?? []) {
      /* Only labels actually offered, and only as the role they were offered in — a model
         that invents a label, or proposes folding a central concept as if it were a
         candidate, would otherwise merge onto or away something nothing else expects. */
      const into = fold.into?.trim()
      if (!into || !knownCentral.has(into.toLowerCase().trim())) continue
      const members = (fold.fold ?? [])
        .map((label) => label?.trim())
        .filter((label): label is string => !!label && knownCandidates.has(label.toLowerCase().trim()))
      if (members.length > 0) groups.push([into, ...members])
    }
    if (groups.length > 0) {
      const folded = groups.reduce((sum, g) => sum + g.length - 1, 0)
      logger.debug(`conceptGraph: consolidation proposed folding ${folded} concept(s) into ${groups.length} group(s)`)
    }
    return groups
  } catch (error) {
    logger.warn(`conceptGraph: consolidation failed for topic ${topicId}, leaving the graph over size: ${error}`)
    return []
  }
}

export default { proposeConsolidations }
