import { createHash } from 'crypto'
import { analyticsIdFor, withAnalyticsIds, serializeWithAnalyticsIds } from '../../../../src/services/conceptGraph/analyticsId.js'
import { CONCEPT_GRAPH_ARTIFACT } from '../../../../src/models/artifact.model/conceptGraphArtifact.js'

const SECRET = 'test-analytics-secret'

interface Graph {
  concepts: { id: string; label: string; analyticsId?: string }[]
  contributions: { id: string; kind: string; concepts: string[] }[]
  originPrompts: { id: string; text: string; analyticsId?: string }[]
}

const graph = (): Graph => ({
  concepts: [
    { id: 'c-trust', label: 'Trust' },
    { id: 'c-registry', label: 'Registry' }
  ],
  contributions: [{ id: 'k-anchors', kind: 'anchors', concepts: ['c-trust'] }],
  originPrompts: [{ id: 'p-what-has-to-be-trustworthy', text: 'What has to be trustworthy?' }]
})

describe('analyticsIdFor', () => {
  it('is 16 hex characters and deterministic', () => {
    const id = analyticsIdFor('c-trust', SECRET)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(analyticsIdFor('c-trust', SECRET)).toBe(id)
  })

  it('differs per node id and per secret', () => {
    expect(analyticsIdFor('c-trust', SECRET)).not.toBe(analyticsIdFor('c-registry', SECRET))
    expect(analyticsIdFor('c-trust', SECRET)).not.toBe(analyticsIdFor('c-trust', 'another-secret'))
  })

  it('is not an unkeyed hash of the id', () => {
    const id = analyticsIdFor('c-trust', SECRET)
    for (const algorithm of ['sha256', 'md5', 'sha1']) {
      expect(createHash(algorithm).update('c-trust').digest('hex').slice(0, 16)).not.toBe(id)
    }
  })

  it('returns nothing when no secret is configured', () => {
    expect(analyticsIdFor('c-trust', undefined)).toBeUndefined()
    expect(analyticsIdFor('c-trust', '')).toBeUndefined()
  })
})

describe('withAnalyticsIds', () => {
  it('adds the id to concepts and origin prompts only, without mutating the input', () => {
    const input = graph()
    const out = withAnalyticsIds(input, SECRET)

    expect(out.concepts[0].analyticsId).toBe(analyticsIdFor('c-trust', SECRET))
    expect(out.concepts[1].analyticsId).toBe(analyticsIdFor('c-registry', SECRET))
    expect(out.originPrompts[0].analyticsId).toBe(analyticsIdFor('p-what-has-to-be-trustworthy', SECRET))
    expect(out.contributions[0]).not.toHaveProperty('analyticsId')
    expect(out.concepts[0].id).toBe('c-trust')
    expect(input).toEqual(graph())
  })

  it('adds no field at all when the secret is unset', () => {
    expect(withAnalyticsIds(graph(), undefined)).toEqual(graph())
    expect(JSON.stringify(withAnalyticsIds(graph(), undefined))).not.toContain('analyticsId')
  })

  it('leaves a payload with no node arrays untouched', () => {
    expect(withAnalyticsIds({ body: 'prose' }, SECRET)).toEqual({ body: 'prose' })
  })
})

describe('serializeWithAnalyticsIds', () => {
  it('handles a version, and an artifact with an inlined current version', () => {
    const version = { versionNumber: 1, payload: graph() }
    expect(serializeWithAnalyticsIds(version, SECRET).payload.concepts[0].analyticsId).toBeDefined()

    const artifact = { type: CONCEPT_GRAPH_ARTIFACT, currentVersion: version }
    const out = serializeWithAnalyticsIds(artifact, SECRET)
    expect(out.currentVersion.payload.originPrompts[0].analyticsId).toBeDefined()
    expect(version.payload).toEqual(graph())
  })

  it('passes an artifact with an unpopulated version pointer through', () => {
    const artifact = { type: CONCEPT_GRAPH_ARTIFACT, currentVersion: 'abc123' }
    expect(serializeWithAnalyticsIds(artifact, SECRET)).toEqual(artifact)
  })
})
