import slugify from 'slugify'
import { ConceptGraphPayload, GraphConcept, GraphContribution, GraphOriginPrompt } from '../../types/index.types.js'
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
  concepts: { label: string; gloss?: string; sourceRefs?: string[] }[]
  contributions: { kind: string; concepts: string[]; statement?: string; originPrompt?: string; sourceRefs?: string[] }[]
  originPrompts: { text: string; sourceRefs?: string[] }[]
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
  mergedConcepts: number
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

const idFor = (prefix: string, label: string, taken: Set<string>) => {
  const base = `${prefix}-${slugify(label, { lower: true, strict: true }) || 'node'}`.slice(0, 60)
  let id = base
  let n = 2
  while (taken.has(id)) {
    id = `${base}-${n}`
    n += 1
  }
  taken.add(id)
  return id
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
  conversationId?: string,
  sourceRefs: SourceRefMap = new Map()
): { payload: ConceptGraphPayload; report: AssemblyReport } => {
  const report: AssemblyReport = {
    droppedConcepts: 0,
    droppedContributions: 0,
    droppedStatements: 0,
    droppedOriginPrompts: 0,
    mergedConcepts: 0
  }
  const takenIds = new Set<string>()

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
  const provenanceFor = (refs?: string[]) => {
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
    const id = idFor('p', text.slice(0, 40), takenIds)
    promptIdByText.set(canonical(text), id)
    originPrompts.push({ id, text, ...provenanceFor(prompt.sourceRefs) })
  }

  /* Concepts, merged by canonical label. The first spelling seen wins as the display
     label, so an early chunk's phrasing stays stable as later chunks repeat the idea. */
  const conceptIdByLabel = new Map<string, string>()
  const concepts: GraphConcept[] = []
  for (const concept of results.flatMap((r) => r.concepts ?? [])) {
    const label = concept.label?.trim()
    if (!label) continue
    const key = canonical(label)
    if (!key) continue
    if (conceptIdByLabel.has(key)) {
      report.mergedConcepts += 1
      continue
    }
    /* A label naming a person cannot be made safe by trimming part of it, so the concept
       goes and every contribution touching it goes with it, below. */
    if (checkStatement(label, safety).length > 0) {
      report.droppedConcepts += 1
      continue
    }
    const id = idFor('c', label, takenIds)
    conceptIdByLabel.set(key, id)
    concepts.push({ id, label, ...provenanceFor(concept.sourceRefs) })
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

    /* Every referenced concept must have survived. A relationship missing one of its ends
       is not a partial truth, it is a different claim, so it is dropped rather than
       reconnected to whatever is left. */
    const conceptIds = (contribution.concepts ?? [])
      .map((label) => conceptIdByLabel.get(canonical(label ?? '')))
      .filter((id): id is string => !!id)
    if (conceptIds.length === 0 || conceptIds.length !== (contribution.concepts ?? []).length) {
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
      id: idFor('k', kind, takenIds),
      kind,
      concepts: conceptIds,
      ...(statement && { statement }),
      ...(originId && { origin: originId }),
      ...provenanceFor(contribution.sourceRefs)
    })
  }

  /* A concept nothing relates to is a dead node in a graph whose whole point is the
     relationships, and the model tends to over-produce them. Origin-prompt nodes are kept
     regardless: they are context, not endpoints. */
  const connected = new Set(contributions.flatMap((c) => c.concepts))
  const keptConcepts = concepts.filter((c) => connected.has(c.id))
  report.droppedConcepts += concepts.length - keptConcepts.length

  /* Likewise a prompt nothing points at. */
  const referencedPrompts = new Set(contributions.map((c) => c.origin).filter(Boolean))
  const keptPrompts = originPrompts.filter((p) => referencedPrompts.has(p.id))
  report.droppedOriginPrompts += originPrompts.length - keptPrompts.length

  return {
    payload: { concepts: keptConcepts, contributions, originPrompts: keptPrompts },
    report
  }
}

export default { assembleGraph }
