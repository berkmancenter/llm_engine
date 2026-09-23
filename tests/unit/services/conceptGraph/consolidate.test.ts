import path from 'path'
import { jest } from '@jest/globals'

/* Mocked at the llmChain boundary with unstable_mockModule — the only mocking that works
   under this repo's ESM Jest setup — so the module under test is imported dynamically, after
   the mock. Mirrors aliasResolution.test.ts, consolidation's closest sibling. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule(path.resolve(process.cwd(), 'src/agents/helpers/llmChain.ts'), () => ({
  getChatPromptResponse: mockGetChatPromptResponse,
  default: { getChatPromptResponse: mockGetChatPromptResponse }
}))

const { proposeConsolidations } = await import(path.resolve(process.cwd(), 'src/services/conceptGraph/consolidate.ts'))

const CANDIDATES = [
  { label: 'Revocation Latency', gloss: 'How quickly a revoked credential stops verifying.', degree: 1 },
  { label: 'Some Other Fringe Idea', gloss: 'Barely touched on.', degree: 1 }
]
const CENTRAL = [{ label: 'Trust Registry', gloss: 'A registry participants check credentials against.', degree: 12 }]

beforeEach(() => {
  mockGetChatPromptResponse.mockReset()
})

describe('proposeConsolidations', () => {
  it('returns nothing without calling the model when either side is empty', async () => {
    expect(await proposeConsolidations({}, [], CENTRAL, 'topic1')).toEqual([])
    expect(await proposeConsolidations({}, CANDIDATES, [], 'topic1')).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  it('returns a fold group shaped survivor-first, like an alias group', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      folds: [{ into: 'Trust Registry', fold: ['Revocation Latency'] }]
    })

    expect(await proposeConsolidations({}, CANDIDATES, CENTRAL, 'topic1')).toEqual([['Trust Registry', 'Revocation Latency']])
  })

  it('drops a fold whose survivor was not offered as a central concept', async () => {
    /* Otherwise a model could name any label as "into" and it would be treated as a real
       consolidation target nothing else expects. */
    mockGetChatPromptResponse.mockResolvedValue({
      folds: [{ into: 'Something Invented', fold: ['Revocation Latency'] }]
    })

    expect(await proposeConsolidations({}, CANDIDATES, CENTRAL, 'topic1')).toEqual([])
  })

  it('drops a member the model invented rather than copied from the candidate list', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      folds: [{ into: 'Trust Registry', fold: ['Something Invented'] }]
    })

    expect(await proposeConsolidations({}, CANDIDATES, CENTRAL, 'topic1')).toEqual([])
  })

  it('drops a fold naming a central concept as if it were a candidate', async () => {
    /* Only a least-connected concept may be folded away — the reverse would let two central,
       well-established concepts collapse into each other. */
    mockGetChatPromptResponse.mockResolvedValue({
      folds: [{ into: 'Trust Registry', fold: ['Trust Registry'] }]
    })

    expect(await proposeConsolidations({}, CANDIDATES, CENTRAL, 'topic1')).toEqual([])
  })

  it('keeps only the members that survive, when some do and some do not', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      folds: [{ into: 'Trust Registry', fold: ['Revocation Latency', 'Something Invented'] }]
    })

    expect(await proposeConsolidations({}, CANDIDATES, CENTRAL, 'topic1')).toEqual([['Trust Registry', 'Revocation Latency']])
  })

  it('treats an empty answer as the normal case, not a failure', async () => {
    mockGetChatPromptResponse.mockResolvedValue({ folds: [] })

    expect(await proposeConsolidations({}, CANDIDATES, CENTRAL, 'topic1')).toEqual([])
  })

  it('fails open when the model call throws, leaving the graph over size', async () => {
    mockGetChatPromptResponse.mockRejectedValue(new Error('model unavailable'))

    expect(await proposeConsolidations({}, CANDIDATES, CENTRAL, 'topic1')).toEqual([])
  })
})
