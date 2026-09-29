import {
  knownConceptLabels,
  payloadToExtraction,
  resolveConceptAliases
} from '../../../../src/services/conceptGraph/topicGraph.js'
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

  it('carries each contribution id across, so a claim keeps its id from one version to the next', () => {
    const extraction = payloadToExtraction(graph())

    expect(extraction.contributions[0].id).toBe('k-checked-by-abc')
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

  it('carries a concept’s gloss and prior foldedFrom across, so a fold stays recorded across versions', () => {
    const withFold = graph()
    withFold.concepts[0].gloss = 'A registry participants check.'
    withFold.concepts[0].foldedFrom = ['Registry Interop']

    const extraction = payloadToExtraction(withFold)

    expect(extraction.concepts[0].gloss).toBe('A registry participants check.')
    expect(extraction.concepts[0].foldedFrom).toEqual(['Registry Interop'])
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

describe('series vocabulary offered to the next event', () => {
  it('ranks established concepts by how connected they are, not by age', () => {
    const payload: ConceptGraphPayload = {
      concepts: [
        { id: 'c-peripheral', label: 'Peripheral' },
        { id: 'c-hub', label: 'Hub' },
        { id: 'c-middle', label: 'Middle' }
      ],
      contributions: [
        { id: 'k1', kind: 'a', concepts: ['c-hub', 'c-middle'] },
        { id: 'k2', kind: 'b', concepts: ['c-hub', 'c-peripheral'] },
        { id: 'k3', kind: 'c', concepts: ['c-hub', 'c-middle'] }
      ],
      originPrompts: []
    }

    expect(knownConceptLabels(payload)[0]).toBe('Hub')
  })

  it('offers nothing for a series with no graph yet', () => {
    expect(knownConceptLabels(undefined)).toEqual([])
    expect(knownConceptLabels({ concepts: [], contributions: [], originPrompts: [] })).toEqual([])
  })

  it('caps the list, since a series grows without bound and the prompt does not', () => {
    const many: ConceptGraphPayload = {
      concepts: Array.from({ length: 80 }, (_, i) => ({ id: `c-${i}`, label: `Concept ${i}` })),
      contributions: [],
      originPrompts: []
    }

    expect(knownConceptLabels(many).length).toBeLessThanOrEqual(60)
  })
})

describe('an extended statement, end to end', () => {
  it('reaches a concept from a later session while keeping its own provenance', () => {
    /* The case the relink pass exists for: session one's claim, session four's concept. */
    const priorGraph: ConceptGraphPayload = {
      concepts: [
        { id: 'c-trust-registry', label: 'Trust Registry', provenance: { conversationId: 'session1' } },
        { id: 'c-verifier', label: 'Verifier', provenance: { conversationId: 'session1' } }
      ],
      contributions: [
        {
          id: 'k-old',
          kind: 'checked by',
          concepts: ['c-trust-registry', 'c-verifier'],
          statement: 'A registry is worthless unless somebody checks it.',
          provenance: { conversationId: 'session1' }
        }
      ],
      originPrompts: []
    }
    const prior = payloadToExtraction(priorGraph)
    const extended = {
      ...prior,
      contributions: [{ ...prior.contributions[0], concepts: [...prior.contributions[0].concepts, 'Revocation'] }]
    }
    const session4 = {
      concepts: [{ label: 'Revocation' }],
      contributions: [{ kind: 'introduced', concepts: ['Revocation'] }],
      originPrompts: []
    }

    const { payload } = assembleGraph([extended, session4], safety, { conversationId: 'session4' })

    const statement = payload.contributions.find((k) => k.statement?.startsWith('A registry is worthless'))!
    const revocation = payload.concepts.find((c) => c.label === 'Revocation')!
    expect(statement.concepts).toContain(revocation.id)
    /* The claim still belongs to the session that made it, even though the series only
       later saw what it reached. */
    expect(statement.provenance).toEqual({ conversationId: 'session1' })
    expect(revocation.provenance).toEqual({ conversationId: 'session4' })
  })
})
