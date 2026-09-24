import slugify from 'slugify'
import logger from '../../config/logger.js'
import {
  ConceptGraphPayload,
  GraphConcept,
  GraphContribution,
  GraphNodeProvenance,
  GraphOriginPrompt
} from '../../types/index.types.js'
import { checkStatement, StatementCheckInput } from './quoteSafety.js'

/*
 * Turns what the model returned — possibly several chunks of it — into a payload the
 * artifact validator will accept, and strips anything that fails the attribution and
 * quoting rules on the way.
 *
 * Everything structural happens here in code rather than in the prompt. The model works in
 * labels; this assigns the ids, resolves every reference, and drops what does not resolve.
 * That is what makes referential integrity a property of the assembly step instead of
 * something the model has to get right across a long generation — and it means the
 * backend's payload validator is a backstop that should never actually fire, rather than a
 * live failure mode for the job.
 *
 * The safety filter removes the smallest thing that carries the risk. An unsafe statement
 * costs its sentence, not its edge: the relationship is structural information the graph
 * still wants, while the prose is the only part that can leak a name. A concept whose own
 * label names a person is different — there is nothing safe left once the label goes, so it
 * and everything referencing it are dropped.
 */

/* What the model returns, before ids exist. Mirrors EXTRACTION_SCHEMA in prompt.ts. */
export interface ExtractionResult {
  concepts: {
    label: string
    gloss?: string
    // Carried over from a stored graph so a concept folded in an earlier version stays
    // folded — the model never produces this, the same way it never produces a contribution's
    // carried `id` below.
    foldedFrom?: string[]
    sourceRefs?: string[]
    provenance?: GraphNodeProvenance
  }[]
  contributions: {
    // Carried over from a stored graph so a surviving claim keeps its id.
    id?: string
    kind: string
    concepts: string[]
    /* Concepts a relink pass added after the claim was made. Losing one of these keeps the
       claim; losing an original concept drops it. */
    extendedWith?: string[]
    statement?: string
    originPrompt?: string
    sourceRefs?: string[]
    provenance?: GraphNodeProvenance
  }[]
  originPrompts: { text: string; sourceRefs?: string[]; provenance?: GraphNodeProvenance }[]
}

/* Maps the [m#] tags the record was labelled with back to real message ids, so a node can
   carry the message it came from. The record is tagged rather than handed raw message ids
   because a 24-character ObjectId repeated through a long generation is exactly the kind of
   token a model corrupts, while "m12" survives. */
export type SourceRefMap = Map<string, string>

export interface AssemblyReport {
  droppedConcepts: number
  droppedContributions: number
  droppedStatements: number
  droppedOriginPrompts: number
  /* A gloss that failed the quoting/attribution check, costing that sentence rather than the
     concept it describes — the same "drop the smallest thing" rule statements already get. */
  droppedGlosses: number
  mergedConcepts: number
  /* Distinct from mergedConcepts: a merge means two labels always named the same idea: the
     duplicate carries nothing an id vanishing doesn't already say. A fold means a genuinely
     distinct idea was consolidated into a related one because the graph outgrew CONCEPT_CAP
     (see topicGraph.ts) — a reader needs to be able to tell "recognised as identical" apart
     from "consolidated for space," which is what this counts and GraphConcept.foldedFrom
     records. */
  foldedConcepts: number
}

/* Case and punctuation folded away, so "Trust Registry", "trust registry" and "trust
   registries" collapse toward one concept instead of drawing three nodes for one idea. */
const canonical = (label: string) =>
  label
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(?:ies)$/, 'y')
    .replace(/(?<=[^s])s$/, '')

/*
 * Ids are derived from a node's canonical content, not from the order it happened to be
 * generated in, which is what makes them stable across versions.
 *
 * That matters because a topic graph is refined incrementally: a concept that survives from
 * one session to the next keeps the same id, so two versions can be diffed, and a client can
 * animate a node moving rather than watching it vanish and a stranger appear in its place.
 * Deriving from the *canonical* form rather than the display label means a change of casing
 * or plural does not rename the node either.
 *
 * The suffix on a collision is deterministic for the same input set, since assembly always
 * walks the nodes in the same order.
 */
const idFor = (prefix: string, key: string, taken: Set<string>) => {
  const base = `${prefix}-${slugify(key, { lower: true, strict: true }) || 'node'}`.slice(0, 60)
  let id = base
  let n = 2
  while (taken.has(id)) {
    id = `${base}-${n}`
    n += 1
  }
  taken.add(id)
  return id
}

/* Short, stable digest of a relation's endpoints, so the same relationship over the same
   concepts keeps its id however many sessions later it recurs. */
const digest = (input: string) => {
  /* Modulo a large prime rather than the usual bitwise fold: this only needs to be stable
     and well spread, not fast or cryptographic, and the intermediate stays far inside the
     safe integer range. */
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) % 2147483647
  }
  return hash.toString(36).slice(0, 6)
}

/* Keeps a stored id so a version diff shows a claim changing, not one claim vanishing and
   another appearing. Falls back to a derived id on collision. */
const carriedId = (id: string | undefined, taken: Set<string>) => {
  if (!id || taken.has(id)) return undefined
  taken.add(id)
  return id
}

/*
 * Options beyond the extraction itself.
 *
 * `aliases` carries the cross-session merges that canonical folding cannot see: two sessions
 * calling the same idea "trust registry" and "credential registry" fold to different keys,
 * and only a reader who understands both can say they are one concept. Each group's first
 * entry is the label the merged node keeps.
 *
 * `foldedGroups` is shaped the same way — each group's first entry is the label the surviving
 * node keeps — but means something different: a fold is proposed by consolidate.ts when the
 * graph has grown past CONCEPT_CAP, and its members are genuinely distinct ideas, not
 * synonyms. Unlike an alias, a fold is applied order-independently regardless of which member
 * of the group this call happens to encounter first in `results`: the survivor's own entry is
 * always what the merged node's gloss and provenance come from, and every other member's
 * label and gloss are recorded onto it (GraphConcept.foldedFrom / an appended gloss) rather
 * than silently discarded the way an ordinary alias's losing spelling is.
 */
export interface AssemblyOptions {
  conversationId?: string
  sourceRefs?: SourceRefMap
  aliases?: string[][]
  foldedGroups?: string[][]
}

/**
 * The key a label folds onto once alias groups are applied — the same folding assembly does
 * internally, exposed so callers can ask "is this concept genuinely new?" and get an answer
 * that agrees with what assembly will actually do.
 */
export const aliasedKey = (label: string, aliases: string[][] = []): string => {
  const key = canonical(label)
  for (const group of aliases) {
    const keys = group.map(canonical).filter(Boolean)
    if (keys.includes(key)) return keys[0]
  }
  return key
}

/**
 * Assembles one payload from one or more extraction results.
 *
 * @param results One per transcript chunk, in order. Concepts repeated across chunks merge.
 * @param safety Source texts and known identities for the attribution and quoting checks.
 * @param conversationId Stamped on every node's provenance.
 */
export const assembleGraph = (
  results: ExtractionResult[],
  safety: StatementCheckInput,
  { conversationId, sourceRefs = new Map(), aliases = [], foldedGroups = [] }: AssemblyOptions = {}
): { payload: ConceptGraphPayload; report: AssemblyReport } => {
  const report: AssemblyReport = {
    droppedConcepts: 0,
    droppedContributions: 0,
    droppedStatements: 0,
    droppedOriginPrompts: 0,
    droppedGlosses: 0,
    mergedConcepts: 0,
    foldedConcepts: 0
  }
  const takenIds = new Set<string>()

  /* Folds every alias in a group onto the group's first entry, so the rest of assembly can
     keep treating one canonical key as one concept. */
  const aliasTo = new Map<string, string>()
  /* The leader's own spelling wins for the merged node, overriding the usual first-seen
     rule. The leader is whichever label was judged clearest for the shared idea, whereas
     first-seen is just whichever session happened to run first — and across a series, the
     later, better wording is often the one worth keeping. */
  const leaderLabel = new Map<string, string>()
  for (const group of aliases) {
    const display = group.find((label) => canonical(label))
    if (!display) continue
    const leader = canonical(display)
    leaderLabel.set(leader, display)
    for (const alias of group.map(canonical).filter(Boolean)) {
      if (alias !== leader) aliasTo.set(alias, leader)
    }
  }
  /* An alias key: what canonical folding plus alias resolution alone would call this label,
     before any fold is applied. Folds are proposed over already-alias-resolved labels, so
     this is the space `foldedGroups` groups its members in. */
  const aliasKeyFor = (label: string) => {
    const key = canonical(label)
    return aliasTo.get(key) ?? key
  }

  /* Same shape as aliasTo/leaderLabel, kept separate rather than merged into them: `foldTo`
     answers a different question ("was this label folded away for space?") that the concepts
     loop below needs to ask independently of ordinary alias resolution — see foldedLabel. */
  const foldTo = new Map<string, string>()
  const foldLeaderLabel = new Map<string, string>()
  for (const group of foldedGroups) {
    const display = group.find((label) => aliasKeyFor(label))
    if (!display) continue
    const leader = aliasKeyFor(display)
    foldLeaderLabel.set(leader, display)
    for (const member of group.map(aliasKeyFor).filter(Boolean)) {
      if (member === leader) continue
      const existing = foldTo.get(member)
      if (existing && existing !== leader) {
        /* Two different fold groups both claim this label — first group wins, matching the
           "first entry / first seen" convention used elsewhere in this file, rather than
           letting the later group silently overwrite the mapping. */
        logger.warn(
          `conceptGraph: fold conflict for "${member}" — already folding into "${existing}", ` +
            `ignoring the later group's claim to fold it into "${leader}"`
        )
        continue
      }
      foldTo.set(member, leader)
    }
  }
  const keyFor = (label: string) => {
    const aliasKey = aliasKeyFor(label)
    return foldTo.get(aliasKey) ?? aliasKey
  }
  /* Whether this label's alias-resolved key is itself being folded away — i.e. this entry is
     a fold's member, never its survivor, regardless of which one the concepts loop happens to
     reach first. */
  const isFoldedAway = (label: string) => foldTo.has(aliasKeyFor(label))

  /* Provenance is the conversation plus, where the model cited one, the message. Only the
     first citation is kept: the field holds one message, and the first is the one the node
     originated in rather than the ones that echoed it. A tag naming no real message is
     dropped rather than passed through, since a dangling reference is worse than none.

     FUTURE CONSIDERATION — messageId is in tension with the Chatham House Rule this graph
     is otherwise built to honour. Every other precaution here works to make a node
     unattributable: no pseudonym is ever stored, the model is shown the record with the
     speaker labels stripped, and both safety layers drop anything naming a participant.
     messageId undoes that for anyone who can read messages, because the message it points
     at has an owner. It is deliberate — it buys the jump-to-the-moment affordance a reader
     of the graph actually wants — but it means the graph is only as anonymous as the
     narrowest audience allowed to resolve a message id.

     So the artifact passcode, which is one shared key per conversation, is a weaker
     boundary than it looks: hand it to a participant and they hold every node's pointer
     back into the transcript. Worth revisiting as either (a) omitting messageId when the
     conversation ran under stricter terms, (b) storing it privately so only organizers see
     it, or (c) graded artifact visibility, which was scoped out of the original API and is
     what would let the pointer exist for organizers and not for everyone else. */
  const provenanceFor = (refs?: string[], carried?: GraphNodeProvenance) => {
    /* A node carried in from an earlier version of this graph keeps the provenance it was
       written with. Re-deriving it would stamp every surviving node with whichever session
       happened to trigger the latest refinement, quietly rewriting where the idea came
       from — the opposite of what provenance is for. */
    if (carried) return { provenance: carried }
    const messageId = (refs ?? []).map((ref) => sourceRefs.get(ref.replace(/[[\]]/g, '').trim())).find(Boolean)
    if (!conversationId && !messageId) return {}
    return { provenance: { ...(conversationId && { conversationId }), ...(messageId && { messageId }) } }
  }

  /* Origin prompts first: contributions reference them, and one may be dropped for naming
     someone, in which case the references have to fall away with it. */
  const promptIdByText = new Map<string, string>()
  const originPrompts: GraphOriginPrompt[] = []
  for (const prompt of results.flatMap((r) => r.originPrompts ?? [])) {
    const text = prompt.text?.trim()
    if (!text || promptIdByText.has(canonical(text))) continue
    if (checkStatement(text, safety).length > 0) {
      report.droppedOriginPrompts += 1
      continue
    }
    const id = idFor('p', canonical(text).slice(0, 40), takenIds)
    promptIdByText.set(canonical(text), id)
    originPrompts.push({ id, text, ...provenanceFor(prompt.sourceRefs, prompt.provenance) })
  }

  /* Concepts, merged by canonical label. The first spelling seen wins as the display
     label, so an early chunk's phrasing stays stable as later chunks repeat the idea.

     A folded-away member is the exception: it never claims a slot's identity even if it is
     the first entry this loop reaches for its key, because "first seen wins" is the wrong
     rule for it specifically — the survivor's own gloss and provenance must win regardless of
     processing order, since `results` here can be a single flattened extraction (see
     payloadToExtraction) with no guarantee the survivor's own entry precedes its members'.
     Every folded-away entry is queued in `pendingFolds` instead, and applied once the whole
     loop has run and every slot's real survivor is known to exist. */
  const conceptIdByLabel = new Map<string, string>()
  const concepts: GraphConcept[] = []
  const conceptById = new Map<string, GraphConcept>()
  const pendingFolds = new Map<string, { label: string; gloss?: string }[]>()
  /* Keys whose node so far exists only as a placeholder created by a folded-away member that
     happened to be processed before its own survivor — see isFoldedAway below. Removed the
     moment the survivor's real entry arrives and claims it. */
  const placeholderKeys = new Set<string>()

  const safeGloss = (gloss: string | undefined): string | undefined => {
    const trimmed = gloss?.trim()
    if (!trimmed) return undefined
    if (checkStatement(trimmed, safety).length > 0) {
      report.droppedGlosses += 1
      return undefined
    }
    return trimmed
  }

  for (const concept of results.flatMap((r) => r.concepts ?? [])) {
    const label = concept.label?.trim()
    if (!label) continue
    const key = keyFor(label)
    if (!key) continue

    if (isFoldedAway(label)) {
      /* A label naming a person cannot be made safe by trimming part of it, the same rule the
         ordinary concept path below applies. This has to run once per member, before anything
         is queued into pendingFolds, regardless of whether this member happens to be the one
         creating the placeholder — otherwise an unsafe label skips the check entirely whenever
         a placeholder already exists (the survivor already resolved, or an earlier member
         already created one), and still ends up applied to survivor.foldedFrom below. */
      if (checkStatement(label, safety).length > 0) {
        report.droppedConcepts += 1
        continue
      }
      if (!pendingFolds.has(key)) pendingFolds.set(key, [])
      pendingFolds.get(key)!.push({ label, gloss: concept.gloss })
      report.foldedConcepts += 1
      if (!conceptIdByLabel.has(key)) {
        /* No survivor slot yet — create a placeholder so contributions can still resolve
           against it. In the ordinary case the survivor's own entry appears somewhere else in
           `results` and fills this in properly below; if it never does (the survivor was
           itself dropped, or this call was never handed it), this placeholder — labelled with
           the fold's own designated survivor label — is what's left, which is a reasonable
           fallback rather than a dangling reference. */
        const id = idFor('c', key, takenIds)
        conceptIdByLabel.set(key, id)
        placeholderKeys.add(key)
        const node: GraphConcept = {
          id,
          label: foldLeaderLabel.get(key) ?? leaderLabel.get(key) ?? label,
          ...provenanceFor(concept.sourceRefs, concept.provenance)
        }
        concepts.push(node)
        conceptById.set(id, node)
      }
      continue
    }

    if (conceptIdByLabel.has(key)) {
      if (placeholderKeys.has(key)) {
        /* This is the survivor's own entry, arriving after a member folded into it was
           already processed and left a placeholder — claim the slot properly rather than
           treating this as a discardable duplicate, which would silently drop the survivor's
           own gloss and provenance in favour of whichever member happened to come first. */
        placeholderKeys.delete(key)
        const node = conceptById.get(conceptIdByLabel.get(key)!)!
        const gloss = safeGloss(concept.gloss)
        if (gloss) node.gloss = gloss
        Object.assign(node, provenanceFor(concept.sourceRefs, concept.provenance))
        /* Carry the survivor's own fold history (from an earlier version of this graph) onto
           the node too — lost otherwise, since only gloss/provenance were copied above. Merge
           rather than overwrite: pendingFolds may already have queued this session's own
           members onto this key by the time this runs. */
        if (concept.foldedFrom?.length) {
          node.foldedFrom = node.foldedFrom ?? []
          for (const foldedLabel of concept.foldedFrom)
            if (!node.foldedFrom.includes(foldedLabel)) node.foldedFrom.push(foldedLabel)
        }
        continue
      }
      report.mergedConcepts += 1
      continue
    }
    /* A label naming a person cannot be made safe by trimming part of it, so the concept
       goes and every contribution touching it goes with it, below. */
    if (checkStatement(label, safety).length > 0) {
      report.droppedConcepts += 1
      continue
    }
    const id = idFor('c', key, takenIds)
    conceptIdByLabel.set(key, id)
    const gloss = safeGloss(concept.gloss)
    const node: GraphConcept = {
      id,
      label: leaderLabel.get(key) ?? label,
      ...(gloss && { gloss }),
      ...(concept.foldedFrom?.length && { foldedFrom: [...concept.foldedFrom] }),
      ...provenanceFor(concept.sourceRefs, concept.provenance)
    }
    concepts.push(node)
    conceptById.set(id, node)
  }

  /* Apply every deferred fold onto whatever node actually ended up at each key — see the loop
     above for why this has to wait until here. */
  for (const [key, members] of pendingFolds) {
    const id = conceptIdByLabel.get(key)
    const survivor = id ? conceptById.get(id) : undefined
    if (!survivor) continue
    const seenGlosses = new Set(survivor.gloss ? [survivor.gloss] : [])
    for (const member of members) {
      survivor.foldedFrom = survivor.foldedFrom ?? []
      if (!survivor.foldedFrom.includes(member.label)) survivor.foldedFrom.push(member.label)
      const gloss = safeGloss(member.gloss)
      if (gloss && !seenGlosses.has(gloss)) {
        seenGlosses.add(gloss)
        survivor.gloss = survivor.gloss ? `${survivor.gloss} ${gloss}` : gloss
      }
    }
  }

  /* Contributions last, once every id they could reference exists. */
  const contributions: GraphContribution[] = []
  const seenRelations = new Set<string>()
  for (const contribution of results.flatMap((r) => r.contributions ?? [])) {
    const kind = contribution.kind?.trim()
    if (!kind) {
      report.droppedContributions += 1
      continue
    }

    /* A claim missing one of its original concepts is a different claim, so it is dropped.
       A concept a relink pass added later is different: losing it returns the claim to what
       it was. */
    const extended = new Set((contribution.extendedWith ?? []).map((label) => keyFor(label ?? '')))
    const originalLabels = (contribution.concepts ?? []).filter((label) => !extended.has(keyFor(label ?? '')))
    const originalIds = originalLabels
      .map((label) => conceptIdByLabel.get(keyFor(label ?? '')))
      .filter((id): id is string => !!id)
    if (originalIds.length === 0 || originalIds.length !== originalLabels.length) {
      report.droppedContributions += 1
      continue
    }
    const addedIds = [...extended]
      .map((key) => conceptIdByLabel.get(key))
      .filter((id): id is string => !!id && !originalIds.includes(id))
    /* Deduped: two of this contribution's own labels can resolve to the same id once a fold
       (or, in principle, an alias) collapses them onto one concept — most plausibly when the
       contribution already joined the very two concepts a fold pass just decided belong
       together. A contribution that only ever named one concept is a meaningful intermediate
       state (see the CONTRIBUTION schema's `concepts` comment in artifact.model/registry.ts)
       and is kept; it is only a fold collapsing what were originally two-or-more distinct
       endpoints down to one that is genuinely degenerate — a claim about nothing but
       itself — and dropped below. */
    const rawIds = [...originalIds, ...addedIds]
    const conceptIds = [...new Set(rawIds)]
    if (conceptIds.length === 0 || (rawIds.length > 1 && conceptIds.length < 2)) {
      report.droppedContributions += 1
      continue
    }

    /* One relationship of the same kind over the same set of concepts is one edge, however
       many chunks mentioned it. */
    const relationKey = `${canonical(kind)}::${[...conceptIds].sort().join('+')}`
    if (seenRelations.has(relationKey)) {
      report.droppedContributions += 1
      continue
    }
    seenRelations.add(relationKey)

    let { statement } = contribution
    if (statement && checkStatement(statement, safety).length > 0) {
      statement = undefined
      report.droppedStatements += 1
    }

    const originId = contribution.originPrompt ? promptIdByText.get(canonical(contribution.originPrompt)) : undefined

    contributions.push({
      id: carriedId(contribution.id, takenIds) ?? idFor('k', `${canonical(kind)}-${digest(relationKey)}`, takenIds),
      kind,
      concepts: conceptIds,
      ...(statement && { statement }),
      ...(originId && { origin: originId }),
      ...provenanceFor(contribution.sourceRefs, contribution.provenance)
    })
  }

  /* A concept nothing relates to is a dead node in a graph whose whole point is the
     relationships, and the model tends to over-produce them. Origin-prompt nodes are kept
     regardless: they are context, not endpoints. */
  const connected = new Set(contributions.flatMap((c) => c.concepts))
  const keptConcepts = concepts.filter((c) => connected.has(c.id))
  report.droppedConcepts += concepts.length - keptConcepts.length

  /* Likewise a prompt nothing points at. */
  const referencedPrompts = new Set([...keptConcepts, ...contributions].map((c) => c.origin).filter(Boolean))
  const keptPrompts = originPrompts.filter((p) => referencedPrompts.has(p.id))
  report.droppedOriginPrompts += originPrompts.length - keptPrompts.length

  return {
    payload: { concepts: keptConcepts, contributions, originPrompts: keptPrompts },
    report
  }
}

export default { assembleGraph }
