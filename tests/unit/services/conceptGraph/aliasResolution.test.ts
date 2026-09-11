import path from 'path'
import { jest } from '@jest/globals'

/* The alias pass is the one place a model's answer is allowed to rename a concept, so its
   guards get a test of their own. Mocked at the llmChain boundary with
   unstable_mockModule — the only mocking that works under this repo's ESM Jest setup — so
   the module under test is imported dynamically, after the mock. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
/* Absolute specifier: a relative one resolves against this file's directory rather than the
   module under test's, and jest reports it as an unmapped module. */
jest.unstable_mockModule(path.resolve(process.cwd(), 'src/agents/helpers/llmChain.ts'), () => ({
  getChatPromptResponse: mockGetChatPromptResponse,
  default: { getChatPromptResponse: mockGetChatPromptResponse }
}))

const { resolveConceptAliases } = await import(path.resolve(process.cwd(), 'src/services/conceptGraph/topicGraph.ts'))

const LABELS = ['Trust Registry', 'Registry of Trusted Issuers', 'Revocation']

beforeEach(() => {
  mockGetChatPromptResponse.mockReset()
})

describe('resolveConceptAliases', () => {
  it('returns a group the model proposed over labels that really exist', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      groups: [{ canonical: 'Trust Registry', aliases: ['Registry of Trusted Issuers'] }]
    })

    expect(await resolveConceptAliases({}, LABELS, 'topic1')).toEqual([['Trust Registry', 'Registry of Trusted Issuers']])
  })

  it('drops a label the model invented rather than copied', async () => {
    /* Otherwise the invented word becomes the group leader and silently renames a concept
       to something nothing else in the graph uses. */
    mockGetChatPromptResponse.mockResolvedValue({
      groups: [{ canonical: 'Credential Directory', aliases: ['Trust Registry'] }]
    })

    expect(await resolveConceptAliases({}, LABELS, 'topic1')).toEqual([])
  })

  it('keeps a group only when at least two real labels survive the filter', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      groups: [{ canonical: 'Trust Registry', aliases: ['Something Invented', 'Registry of Trusted Issuers'] }]
    })

    expect(await resolveConceptAliases({}, LABELS, 'topic1')).toEqual([['Trust Registry', 'Registry of Trusted Issuers']])
  })

  it('matches labels case-insensitively, since the model reformats freely', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      groups: [{ canonical: 'trust registry', aliases: ['registry of trusted issuers'] }]
    })

    expect(await resolveConceptAliases({}, LABELS, 'topic1')).toHaveLength(1)
  })

  it('treats an empty answer as the normal case, not a failure', async () => {
    mockGetChatPromptResponse.mockResolvedValue({ groups: [] })

    expect(await resolveConceptAliases({}, LABELS, 'topic1')).toEqual([])
  })

  it('fails open when the model call throws, leaving concepts unmerged', async () => {
    mockGetChatPromptResponse.mockRejectedValue(new Error('model unavailable'))

    expect(await resolveConceptAliases({}, LABELS, 'topic1')).toEqual([])
  })

  it('does not call a model at all for a single label', async () => {
    await resolveConceptAliases({}, ['Only One'], 'topic1')

    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })
})
