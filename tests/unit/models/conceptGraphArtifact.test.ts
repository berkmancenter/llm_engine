import { artifactKind } from '../../../src/models/artifact.model/registry.js'
import { CONCEPT_GRAPH_ARTIFACT } from '../../../src/models/artifact.model/conceptGraphArtifact.js'

/* Pure schema tests: the payload validator is the only thing standing between a typo and a
   graph that renders wrong for every future reader of that version, since the version
   model stores the payload as Mixed. No Mongo needed. */
const validate = (payload) => artifactKind(CONCEPT_GRAPH_ARTIFACT)!.payloadSchema.validate(payload, { convert: true })

const graph = (overrides = {}) => ({
  concepts: [
    { id: 'c1', label: 'Verifiable Credential' },
    { id: 'c2', label: 'Issuer' },
    { id: 'c3', label: 'Trust Registry' }
  ],
  contributions: [{ id: 'k1', kind: 'issued by', concepts: ['c1', 'c2'] }],
  originPrompts: [],
  ...overrides
})

describe('concept graph payload', () => {
  it('accepts a graph of concepts joined through a contribution', () => {
    const { error } = validate(graph())

    expect(error).toBeUndefined()
  })

  it('accepts a contribution joining three concepts, which a plain edge could not express', () => {
    const { error, value } = validate(
      graph({ contributions: [{ id: 'k15', kind: 'co-governs', concepts: ['c1', 'c2', 'c3'] }] })
    )

    expect(error).toBeUndefined()
    expect(value.contributions[0].concepts).toHaveLength(3)
  })

  it('accepts an empty graph, so an artifact can be created before an event fills it in', () => {
    const { error, value } = validate({})

    expect(error).toBeUndefined()
    expect(value).toEqual({ concepts: [], contributions: [], originPrompts: [] })
  })

  it('keeps a concept id and its label separate, so a rename stays one edit', () => {
    const { error, value } = validate(graph({ concepts: [{ id: 'c1', label: 'Renamed' }], contributions: [] }))

    expect(error).toBeUndefined()
    expect(value.concepts[0]).toEqual({ id: 'c1', label: 'Renamed' })
  })
})

describe('concept graph referential integrity', () => {
  it('rejects a contribution naming a concept that is not in the payload', () => {
    const { error } = validate(graph({ contributions: [{ id: 'k1', kind: 'anchors', concepts: ['c1', 'ghost'] }] }))

    expect(error?.message).toContain('Contribution k1 references unknown concept: ghost')
  })

  it('rejects an origin naming no prompt', () => {
    const { error } = validate(
      graph({ concepts: [{ id: 'c1', label: 'Orphaned', origin: 'p-missing' }], contributions: [] })
    )

    expect(error?.message).toContain('Node c1 references unknown origin prompt: p-missing')
  })

  it('resolves an origin that does exist', () => {
    const { error } = validate(
      graph({
        concepts: [{ id: 'c1', label: 'Verifiable Credential', origin: 'p1' }],
        contributions: [],
        originPrompts: [{ id: 'p1', text: 'What has to be trustworthy here?' }]
      })
    )

    expect(error).toBeUndefined()
  })

  it('rejects a duplicate id within one array', () => {
    const { error } = validate(
      graph({
        concepts: [
          { id: 'c1', label: 'One' },
          { id: 'c1', label: 'Two' }
        ],
        contributions: []
      })
    )

    expect(error?.message).toContain('Duplicate node id in graph: c1')
  })

  it('rejects an id reused across arrays, which would collide in the client id map', () => {
    const { error } = validate(
      graph({
        concepts: [{ id: 'shared', label: 'A concept' }],
        contributions: [{ id: 'shared', kind: 'relates to', concepts: ['shared'] }],
        originPrompts: []
      })
    )

    expect(error?.message).toContain('Duplicate node id in graph: shared')
  })

  it('rejects an origin prompt colliding with a concept id', () => {
    const { error } = validate(
      graph({
        concepts: [{ id: 'x', label: 'A concept' }],
        contributions: [],
        originPrompts: [{ id: 'x', text: 'A prompt' }]
      })
    )

    expect(error?.message).toContain('Duplicate node id in graph: x')
  })
})

describe('concept graph node shape', () => {
  it('requires a label on a concept and a kind on a contribution', () => {
    expect(validate(graph({ concepts: [{ id: 'c1' }], contributions: [] })).error).toBeDefined()
    expect(validate(graph({ contributions: [{ id: 'k1', concepts: ['c1'] }] })).error).toBeDefined()
  })

  it('requires a contribution to join at least one concept', () => {
    const { error } = validate(graph({ contributions: [{ id: 'k1', kind: 'floats', concepts: [] }] }))

    expect(error).toBeDefined()
  })

  it('accepts optional provenance on any node kind', () => {
    const { error } = validate({
      concepts: [
        {
          id: 'c1',
          label: 'Trust Registry',
          provenance: {
            conversationId: '6733fe79ca20209f1fa02168',
            messageId: '6750a665664156091cdf5a31',
            pseudonym: 'Bold Aardvark'
          }
        }
      ],
      contributions: [{ id: 'k1', kind: 'raised in', concepts: ['c1'], provenance: { messageId: 'm2' } }],
      originPrompts: [{ id: 'p1', text: 'A prompt', provenance: { messageId: 'm3' } }]
    })

    expect(error).toBeUndefined()
  })

  it('rejects an unknown field, so a client typo is a 400 rather than dead data', () => {
    const { error } = validate(graph({ concepts: [{ id: 'c1', label: 'One', colour: 'blue' }], contributions: [] }))

    expect(error?.message).toContain('colour')
  })

  it('rejects a concept referencing another concept directly, which the model routes through a contribution', () => {
    const { error } = validate(graph({ concepts: [{ id: 'c1', label: 'One', concepts: ['c2'] }], contributions: [] }))

    expect(error).toBeDefined()
  })
})
