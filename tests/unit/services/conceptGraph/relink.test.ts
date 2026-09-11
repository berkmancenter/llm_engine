import path from 'path'
import { jest } from '@jest/globals'

/* The relink pass is the only place a settled statement can change, so its guards get a
   test of their own. Mocked at the llmChain boundary with unstable_mockModule and an
   absolute specifier — the only mocking that works under this repo's ESM Jest setup. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule(path.resolve(process.cwd(), 'src/agents/helpers/llmChain.ts'), () => ({
  getChatPromptResponse: mockGetChatPromptResponse,
  default: { getChatPromptResponse: mockGetChatPromptResponse }
}))

const { proposeRelinks, applyRelinks } = await import(path.resolve(process.cwd(), 'src/services/conceptGraph/relink.ts'))

const prior = {
  concepts: [{ label: 'Trust Registry' }, { label: 'Verifier' }],
  contributions: [
    {
      kind: 'checked by',
      concepts: ['Trust Registry', 'Verifier'],
      statement: 'A registry is worthless unless somebody actually checks it.'
    }
  ],
  originPrompts: []
}
const NEW_CONCEPTS = ['Revocation', 'Key Rotation']

beforeEach(() => {
  mockGetChatPromptResponse.mockReset()
})

describe('proposing relinks', () => {
  it('extends a settled statement that really was about a newly named concept', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      extensions: [{ index: 0, addConcepts: ['Revocation'], kindStillHolds: true }],
      bridges: []
    })

    const result = await proposeRelinks({}, prior, NEW_CONCEPTS, 'topic1')

    expect(result.extensions.get(0)).toEqual(['Revocation'])
    expect(result.bridges).toHaveLength(0)
  })

  it('records a bridge instead when the old relationship label no longer fits', async () => {
    /* The connection is real but "checked by" would no longer describe the larger set, so
       the original claim is left alone and the connection becomes its own edge. */
    mockGetChatPromptResponse.mockResolvedValue({
      extensions: [
        {
          index: 0,
          addConcepts: ['Revocation'],
          kindStillHolds: false,
          bridgeKind: 'made moot by',
          bridgeStatement: 'Checking a registry means little if the entry was already revoked.'
        }
      ],
      bridges: []
    })

    const result = await proposeRelinks({}, prior, NEW_CONCEPTS, 'topic1')

    expect(result.extensions.size).toBe(0)
    expect(result.bridges[0].kind).toBe('made moot by')
    expect(result.bridges[0].concepts).toEqual(['Trust Registry', 'Verifier', 'Revocation'])
  })

  it('never copies the original sentence onto the bridge, which would read as a duplicate', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      extensions: [
        {
          index: 0,
          addConcepts: ['Revocation'],
          kindStillHolds: false,
          bridgeKind: 'made moot by',
          bridgeStatement: 'Checking a registry means little if the entry was already revoked.'
        }
      ],
      bridges: []
    })

    const result = await proposeRelinks({}, prior, NEW_CONCEPTS, 'topic1')

    expect(result.bridges[0].statement).not.toBe(prior.contributions[0].statement)
  })

  it('drops a rejected extension the model could not relabel, rather than fabricating one', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      extensions: [{ index: 0, addConcepts: ['Revocation'], kindStillHolds: false }],
      bridges: []
    })

    const result = await proposeRelinks({}, prior, NEW_CONCEPTS, 'topic1')

    expect(result.extensions.size).toBe(0)
    expect(result.bridges).toHaveLength(0)
  })

  it('accepts a bridge that crosses from an established concept to a new one', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      extensions: [],
      bridges: [{ kind: 'depends on', concepts: ['Trust Registry', 'Revocation'], statement: 'One needs the other.' }]
    })

    const result = await proposeRelinks({}, prior, NEW_CONCEPTS, 'topic1')

    expect(result.bridges).toHaveLength(1)
    expect(result.bridges[0].kind).toBe('depends on')
  })

  it('rejects a bridge that never crosses, since the extraction already had that chance', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      extensions: [],
      bridges: [{ kind: 'relates to', concepts: ['Trust Registry', 'Verifier'], statement: 'Both matter.' }]
    })

    expect((await proposeRelinks({}, prior, NEW_CONCEPTS, 'topic1')).bridges).toHaveLength(0)
  })

  it('ignores a concept the model invented rather than copied', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      extensions: [{ index: 0, addConcepts: ['Something Imagined'], kindStillHolds: true }],
      bridges: []
    })

    expect((await proposeRelinks({}, prior, NEW_CONCEPTS, 'topic1')).extensions.size).toBe(0)
  })

  it('ignores an addition that is not actually new to the graph', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      extensions: [{ index: 0, addConcepts: ['Verifier'], kindStillHolds: true }],
      bridges: []
    })

    expect((await proposeRelinks({}, prior, NEW_CONCEPTS, 'topic1')).extensions.size).toBe(0)
  })

  it('caps how many concepts one statement can gain', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      extensions: [{ index: 0, addConcepts: ['Revocation', 'Key Rotation'], kindStillHolds: true }],
      bridges: []
    })

    const result = await proposeRelinks({}, prior, [...NEW_CONCEPTS, 'Schema', 'Attestation'], 'topic1')

    expect(result.extensions.get(0)!.length).toBeLessThanOrEqual(2)
  })

  it('ignores an index naming no existing statement', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      extensions: [{ index: 99, addConcepts: ['Revocation'], kindStillHolds: true }],
      bridges: []
    })

    expect((await proposeRelinks({}, prior, NEW_CONCEPTS, 'topic1')).extensions.size).toBe(0)
  })

  it('does nothing when the event introduced no new concepts', async () => {
    await proposeRelinks({}, prior, [], 'topic1')

    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  it('fails open, leaving the map as it already was', async () => {
    mockGetChatPromptResponse.mockRejectedValue(new Error('model unavailable'))

    const result = await proposeRelinks({}, prior, NEW_CONCEPTS, 'topic1')

    expect(result.extensions.size).toBe(0)
    expect(result.bridges).toHaveLength(0)
  })
})

describe('applying relinks', () => {
  it('adds to a statement without removing what it already joined', () => {
    const [extended] = applyRelinks(prior, { extensions: new Map([[0, ['Revocation']]]), bridges: [] })

    expect(extended.contributions[0].concepts).toEqual(['Trust Registry', 'Verifier', 'Revocation'])
    expect(extended.contributions[0].statement).toBe(prior.contributions[0].statement)
  })

  it('leaves the original extraction untouched', () => {
    applyRelinks(prior, { extensions: new Map([[0, ['Revocation']]]), bridges: [] })

    expect(prior.contributions[0].concepts).toEqual(['Trust Registry', 'Verifier'])
  })

  it('returns bridges separately, so they are not stamped with the old session', () => {
    /* A bridge belongs to the session that revealed it, not to the one whose statement it
       connects — keeping it out of the carried extraction is what lets assembly say so. */
    const bridge = { kind: 'depends on', concepts: ['Trust Registry', 'Revocation'], statement: 'One needs the other.' }

    const results = applyRelinks(prior, { extensions: new Map(), bridges: [bridge] })

    expect(results).toHaveLength(2)
    expect(results[1].contributions).toEqual([bridge])
    expect(results[1].concepts).toEqual([])
  })

  it('returns a single result when there are no bridges', () => {
    expect(applyRelinks(prior, { extensions: new Map(), bridges: [] })).toHaveLength(1)
  })
})
