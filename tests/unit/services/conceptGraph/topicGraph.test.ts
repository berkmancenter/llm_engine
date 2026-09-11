import { payloadToExtraction, resolveConceptAliases } from '../../../../src/services/conceptGraph/topicGraph.js'
import { assembleGraph } from '../../../../src/services/conceptGraph/assemble.js'
import { ConceptGraphPayload } from '../../../../src/types/index.types.js'

const safety = { sourceTexts: [], knownIdentities: [] }

const graph = (): ConceptGraphPayload => ({
  concepts: [
    { id: 'c-trust-registry', label: 'Trust Registry', provenance: { conversationId: 'conv1', messageId: 'm-a' } },
    { id: 'c-verifier', label: 'Verifier', provenance: { conversationId: 'conv1' } }
  ],
  contributions: [
    {
      id: 'k-checked-by-abc',
      kind: 'checked by',
      concepts: ['c-trust-registry', 'c-verifier'],
      statement: 'A registry needs checking.',
      origin: 'p-what-matters',
      provenance: { conversationId: 'conv1' }
    }
  ],
  originPrompts: [{ id: 'p-what-matters', text: 'What has to be trustworthy?', provenance: { conversationId: 'conv1' } }]
})

describe('reading a stored graph back for merging', () => {
  it('turns ids back into labels the assembler can work in', () => {
    const extraction = payloadToExtraction(graph())

    expect(extraction.concepts.map((c) => c.label)).toEqual(['Trust Registry', 'Verifier'])
    expect(extraction.contributions[0].concepts).toEqual(['Trust Registry', 'Verifier'])
    expect(extraction.contributions[0].originPrompt).toBe('What has to be trustworthy?')
  })

  it('carries provenance across, so an earlier session keeps where its ideas came from', () => {
    const extraction = payloadToExtraction(graph())

    expect(extraction.concepts[0].provenance).toEqual({ conversationId: 'conv1', messageId: 'm-a' })
  })

  it('leaves behind a contribution whose concepts no longer resolve', () => {
    const broken = graph()
    broken.contributions[0].concepts = ['c-gone']

    expect(payloadToExtraction(broken).contributions).toHaveLength(0)
  })
})

describe('round-tripping a graph through a merge', () => {
  it('keeps concept ids stable, so two versions can be diffed', () => {
    const before = graph()

    const { payload } = assembleGraph([payloadToExtraction(before)], safety)

    expect(payload.concepts.map((c) => c.id).sort()).toEqual(before.concepts.map((c) => c.id).sort())
  })

  it('keeps a contribution id stable across a refinement', () => {
    const first = assembleGraph([payloadToExtraction(graph())], safety).payload
    const second = assembleGraph([payloadToExtraction(first)], safety).payload

    expect(second.contributions[0].id).toBe(first.contributions[0].id)
  })

  it('does not re-stamp a surviving node with the session that triggered the refinement', () => {
    const merged = assembleGraph([payloadToExtraction(graph())], safety, { conversationId: 'conv2' })

    expect(merged.payload.concepts[0].provenance).toEqual({ conversationId: 'conv1', messageId: 'm-a' })
  })

  it('folds a later session into the existing graph, adding only what is new', () => {
    const next = {
      concepts: [{ label: 'Trust Registry' }, { label: 'Revocation' }],
      contributions: [{ kind: 'depends on', concepts: ['Trust Registry', 'Revocation'] }],
      originPrompts: []
    }

    const { payload } = assembleGraph([payloadToExtraction(graph()), next], safety, { conversationId: 'conv2' })

    expect(payload.concepts.map((c) => c.label).sort()).toEqual(['Revocation', 'Trust Registry', 'Verifier'])
    expect(payload.contributions).toHaveLength(2)
    /* The idea that carried over keeps its identity; only the new one is stamped with the
       session that introduced it. */
    expect(payload.concepts.find((c) => c.label === 'Trust Registry')!.provenance!.conversationId).toBe('conv1')
    expect(payload.concepts.find((c) => c.label === 'Revocation')!.provenance!.conversationId).toBe('conv2')
  })
})

describe('cross-session aliases', () => {
  const across = [
    {
      concepts: [{ label: 'Trust Registry' }, { label: 'Verifier' }],
      contributions: [{ kind: 'checked by', concepts: ['Trust Registry', 'Verifier'] }],
      originPrompts: []
    },
    {
      concepts: [{ label: 'Registry of Trusted Issuers' }, { label: 'Revocation' }],
      contributions: [{ kind: 'depends on', concepts: ['Registry of Trusted Issuers', 'Revocation'] }],
      originPrompts: []
    }
  ]

  it('leaves differently worded concepts apart without an alias group', () => {
    const { payload } = assembleGraph(across, safety)

    expect(payload.concepts).toHaveLength(4)
  })

  it('merges them into one node when told they are the same idea', () => {
    const { payload } = assembleGraph(across, safety, {
      aliases: [['Trust Registry', 'Registry of Trusted Issuers']]
    })

    expect(payload.concepts.map((c) => c.label).sort()).toEqual(['Revocation', 'Trust Registry', 'Verifier'])
    /* Both sessions' relationships now hang off the one merged node, which is the point of
       merging a series rather than storing six disconnected graphs. */
    const registry = payload.concepts.find((c) => c.label === 'Trust Registry')!
    expect(payload.contributions.filter((k) => k.concepts.includes(registry.id))).toHaveLength(2)
  })

  it('keeps the group leader as the surviving label', () => {
    const { payload } = assembleGraph(across, safety, {
      aliases: [['Registry of Trusted Issuers', 'Trust Registry']]
    })

    expect(payload.concepts.map((c) => c.label)).toContain('Registry of Trusted Issuers')
    expect(payload.concepts.map((c) => c.label)).not.toContain('Trust Registry')
  })
})

describe('alias resolution guards', () => {
  it('returns no groups for a single label, without calling a model', async () => {
    expect(await resolveConceptAliases(null, ['Only One'])).toEqual([])
  })

  it('fails open rather than closed, since a missed merge is cosmetic', async () => {
    /* Opposite stance to the identity screen, which fails closed: an unmerged duplicate
       makes the map redundant, where a skipped safety check would leak a name. */
    expect(await resolveConceptAliases(null, ['One', 'Two'])).toEqual([])
  })
})
