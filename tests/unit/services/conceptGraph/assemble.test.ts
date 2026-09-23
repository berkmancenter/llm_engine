import { assembleGraph, ExtractionResult } from '../../../../src/services/conceptGraph/assemble.js'
import { artifactKind } from '../../../../src/models/artifact.model/registry.js'
import { CONCEPT_GRAPH_ARTIFACT } from '../../../../src/models/artifact.model/conceptGraphArtifact.js'

const safety = { sourceTexts: [], knownIdentities: ['Rosa Klein', 'Bold Aardvark'] }

const result = (overrides: Partial<ExtractionResult> = {}): ExtractionResult => ({
  concepts: [{ label: 'Trust Registry' }, { label: 'Verifier' }],
  contributions: [{ kind: 'checked by', concepts: ['Trust Registry', 'Verifier'], statement: 'A registry needs checking.' }],
  originPrompts: [],
  ...overrides
})

describe('assembly', () => {
  it('assigns ids the model never saw and resolves references to them', () => {
    const { payload } = assembleGraph([result()], safety)

    expect(payload.concepts.map((c) => c.label)).toEqual(['Trust Registry', 'Verifier'])
    expect(payload.contributions[0].concepts).toEqual(payload.concepts.map((c) => c.id))
  })

  it('produces a payload the artifact validator accepts', () => {
    /* The point of assembling in code: the backend validator should be a backstop that
       never fires, not a live failure mode for the job. */
    const { payload } = assembleGraph([result()], safety)

    const { error } = artifactKind(CONCEPT_GRAPH_ARTIFACT)!.payloadSchema.validate(payload)

    expect(error).toBeUndefined()
  })

  it('drops a contribution naming a concept that did not survive, rather than reconnecting it', () => {
    const { payload, report } = assembleGraph(
      [result({ contributions: [{ kind: 'points at', concepts: ['Trust Registry', 'Never Mentioned'] }] })],
      safety
    )

    expect(payload.contributions).toHaveLength(0)
    expect(report.droppedContributions).toBe(1)
  })

  it('keeps a settled claim when a concept a relink pass added to it does not survive', () => {
    // Losing an added concept must not delete a claim because of something said sessions later.
    const { payload, report } = assembleGraph(
      [
        result({
          concepts: [{ label: 'Trust Registry' }, { label: 'Verifier' }, { label: 'Rosa Klein' }],
          contributions: [
            {
              kind: 'checked by',
              concepts: ['Trust Registry', 'Verifier', 'Rosa Klein'],
              extendedWith: ['Rosa Klein'],
              statement: 'A registry needs checking.'
            }
          ]
        })
      ],
      safety
    )

    expect(payload.contributions).toHaveLength(1)
    expect(payload.contributions[0].concepts).toEqual(payload.concepts.map((c) => c.id))
    expect(payload.concepts.map((c) => c.label)).toEqual(['Trust Registry', 'Verifier'])
    expect(report.droppedContributions).toBe(0)
  })

  it('still drops a claim when one of its original concepts does not survive', () => {
    const { payload } = assembleGraph(
      [
        result({
          concepts: [{ label: 'Rosa Klein' }, { label: 'Verifier' }, { label: 'Revocation' }],
          contributions: [
            { kind: 'checked by', concepts: ['Rosa Klein', 'Verifier', 'Revocation'], extendedWith: ['Revocation'] }
          ]
        })
      ],
      safety
    )

    expect(payload.contributions).toHaveLength(0)
  })

  it('keeps the id a stored claim was read back with, even once it has been extended', () => {
    const { payload } = assembleGraph(
      [
        result({
          concepts: [{ label: 'Trust Registry' }, { label: 'Verifier' }, { label: 'Revocation' }],
          contributions: [
            {
              id: 'k-checked-by-abc123',
              kind: 'checked by',
              concepts: ['Trust Registry', 'Verifier', 'Revocation'],
              extendedWith: ['Revocation']
            }
          ]
        })
      ],
      safety
    )

    expect(payload.contributions[0].id).toBe('k-checked-by-abc123')
    expect(payload.contributions[0].concepts).toHaveLength(3)
  })

  it('merges the same concept across chunks instead of drawing it twice', () => {
    const { payload, report } = assembleGraph(
      [
        result(),
        result({
          concepts: [{ label: 'trust registries' }, { label: 'Revocation' }],
          contributions: [{ kind: 'listed in', concepts: ['trust registries', 'Revocation'] }]
        })
      ],
      safety
    )

    expect(payload.concepts.filter((c) => /registr/i.test(c.label))).toHaveLength(1)
    expect(report.mergedConcepts).toBeGreaterThan(0)
  })

  it('keeps the first spelling as the display label when chunks disagree', () => {
    const { payload } = assembleGraph(
      [
        result(),
        result({
          concepts: [{ label: 'trust registries' }],
          contributions: [{ kind: 'checked by', concepts: ['trust registries', 'Verifier'] }]
        })
      ],
      safety
    )

    expect(payload.concepts.find((c) => /registr/i.test(c.label))!.label).toBe('Trust Registry')
  })

  it('collapses the same relationship reported by two chunks into one edge', () => {
    const { payload } = assembleGraph([result(), result()], safety)

    expect(payload.contributions).toHaveLength(1)
  })

  it('preserves a contribution joining three concepts', () => {
    const { payload } = assembleGraph(
      [
        result({
          concepts: [{ label: 'Issuer' }, { label: 'Verifier' }, { label: 'Trust Registry' }],
          contributions: [{ kind: 'co-governs', concepts: ['Issuer', 'Verifier', 'Trust Registry'] }]
        })
      ],
      safety
    )

    expect(payload.contributions[0].concepts).toHaveLength(3)
  })

  it('drops a concept nothing relates to', () => {
    const { payload } = assembleGraph(
      [result({ concepts: [{ label: 'Trust Registry' }, { label: 'Verifier' }, { label: 'Orphan' }] })],
      safety
    )

    expect(payload.concepts.map((c) => c.label)).not.toContain('Orphan')
  })

  it('keeps a poll-derived origin prompt even when nothing references it yet', () => {
    /* Unlike an organic origin prompt, which only means anything once a contribution says
       it came out of it, a poll names a real thing the room did — it survives on its own. */
    const pollRefs = new Map([['p1', 'poll-1']])

    const { payload, report } = assembleGraph(
      [result({ originPrompts: [{ text: 'Does the trust registry model scale?', sourceRefs: ['p1'] }] })],
      safety,
      { pollRefs }
    )

    expect(payload.originPrompts).toHaveLength(1)
    expect(report.droppedOriginPrompts).toBe(0)
  })

  it('still drops an organic origin prompt nothing references', () => {
    const { payload, report } = assembleGraph(
      [result({ originPrompts: [{ text: 'What has to be trustworthy here?' }] })],
      safety
    )

    expect(payload.originPrompts).toHaveLength(0)
    expect(report.droppedOriginPrompts).toBe(1)
  })
})

describe('assembly enforces the attribution rule', () => {
  it('strips an unsafe statement but keeps the relationship it describes', () => {
    const { payload, report } = assembleGraph(
      [
        result({
          contributions: [
            {
              kind: 'checked by',
              concepts: ['Trust Registry', 'Verifier'],
              statement: 'Rosa Klein said registries are pointless.'
            }
          ]
        })
      ],
      safety
    )

    expect(payload.contributions).toHaveLength(1)
    expect(payload.contributions[0].statement).toBeUndefined()
    expect(report.droppedStatements).toBe(1)
  })

  it('drops a concept whose own label names someone, and everything touching it', () => {
    const { payload, report } = assembleGraph(
      [
        result({
          concepts: [{ label: 'Rosa Klein' }, { label: 'Verifier' }],
          contributions: [{ kind: 'proposed by', concepts: ['Rosa Klein', 'Verifier'] }]
        })
      ],
      safety
    )

    expect(payload.concepts).toHaveLength(0)
    expect(payload.contributions).toHaveLength(0)
    expect(report.droppedConcepts).toBeGreaterThan(0)
  })

  it('drops an origin prompt that names someone', () => {
    const { payload, report } = assembleGraph(
      [
        result({
          originPrompts: [{ text: 'What did Rosa Klein mean by that?' }],
          contributions: [
            {
              kind: 'checked by',
              concepts: ['Trust Registry', 'Verifier'],
              originPrompt: 'What did Rosa Klein mean by that?'
            }
          ]
        })
      ],
      safety
    )

    expect(payload.originPrompts).toHaveLength(0)
    expect(payload.contributions[0].origin).toBeUndefined()
    expect(report.droppedOriginPrompts).toBeGreaterThan(0)
  })

  it('drops a poll-derived origin prompt naming someone, the same as any other', () => {
    /* A poll built with allowNewChoices lets a participant type a novel choice — the one
       free-text risk in the whole poll data model. Nothing poll-specific has to catch it:
       a poll question flows in as ordinary origin-prompt text, so the existing screen
       already applies with no special-casing. */
    const { payload, report } = assembleGraph(
      [result({ originPrompts: [{ text: 'Should Rosa Klein chair the working group?', sourceRefs: ['p1'] }] })],
      safety
    )

    expect(payload.originPrompts).toHaveLength(0)
    expect(report.droppedOriginPrompts).toBeGreaterThan(0)
  })

  it('keeps a clean origin prompt and links it', () => {
    const { payload } = assembleGraph(
      [
        result({
          originPrompts: [{ text: 'What has to be trustworthy here?' }],
          contributions: [
            {
              kind: 'checked by',
              concepts: ['Trust Registry', 'Verifier'],
              originPrompt: 'What has to be trustworthy here?'
            }
          ]
        })
      ],
      safety
    )

    expect(payload.originPrompts).toHaveLength(1)
    expect(payload.contributions[0].origin).toBe(payload.originPrompts[0].id)
  })
})

describe('provenance', () => {
  it('resolves a cited tag to the message it names', () => {
    const refs = new Map([['m4', '6750a665664156091cdf5a31']])

    const { payload } = assembleGraph(
      [result({ contributions: [{ kind: 'checked by', concepts: ['Trust Registry', 'Verifier'], sourceRefs: ['m4'] }] })],
      safety,
      { conversationId: 'conv1', sourceRefs: refs }
    )

    expect(payload.contributions[0].provenance).toEqual({
      conversationId: 'conv1',
      messageId: '6750a665664156091cdf5a31'
    })
  })

  it('ignores a tag naming no real message rather than storing a dangling reference', () => {
    const { payload } = assembleGraph(
      [result({ contributions: [{ kind: 'checked by', concepts: ['Trust Registry', 'Verifier'], sourceRefs: ['m99'] }] })],
      safety,
      { conversationId: 'conv1', sourceRefs: new Map() }
    )

    expect(payload.contributions[0].provenance).toEqual({ conversationId: 'conv1' })
  })

  it('resolves a cited poll tag to pollId rather than messageId', () => {
    const pollRefs = new Map([['p1', '6750a665664156091cdf5a99']])

    const { payload } = assembleGraph(
      [result({ originPrompts: [{ text: 'Does the trust registry model scale?', sourceRefs: ['p1'] }] })],
      safety,
      { conversationId: 'conv1', pollRefs }
    )

    expect(payload.originPrompts[0].provenance).toEqual({
      conversationId: 'conv1',
      pollId: '6750a665664156091cdf5a99'
    })
  })

  it('records no pseudonym, since the graph is unattributed by construction', () => {
    const { payload } = assembleGraph([result()], safety, { conversationId: 'conv1' })

    for (const node of [...payload.concepts, ...payload.contributions]) {
      expect(node.provenance).not.toHaveProperty('pseudonym')
    }
  })
})
