import { jest } from '@jest/globals'

/* Whole socratic stage with only the LLM chain mocked, dispatching on which prompt is being run, so
   the real writer, judges, checks and template are exercised. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockChat = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockChat
}))

const { default: runSocraticStage } = await import('../../../../src/agents/helpers/socraticPipeline.js')

const PASSAGE =
  "Okonkwo-Reyes reports that mandatory posting quotas produce what she terms 'quota crowding': the share of substantive replies falls by roughly a third and participation recovered within two quarters."
const slots = { sourceLabel: 'Okonkwo-Reyes', concept: 'quota crowding', loadedWord: 'healthy' as string | null }
const input = (over = {}) => ({
  llm: {},
  slots,
  passage: PASSAGE,
  humanChatLines: ['A healthy forum is busy', 'healthy means busy'],
  recentPosts: [] as string[],
  participantNames: ['Badger', 'Fox', 'Owl'],
  ...over
})

const GOOD = 'When we say "healthy", does Okonkwo-Reyes on quota crowding mean the same thing by it?'
const LEAKY = 'Okonkwo-Reyes found replies fell by a third, so is "healthy" about quota crowding?'

type Handlers = {
  writer?: (call: number) => unknown
  judgeA?: () => unknown
  judgeB?: () => unknown
}

function wire({ writer, judgeA, judgeB }: Handlers) {
  let writerCalls = 0
  mockChat.mockImplementation(async (_llm, system: string) => {
    if (system.startsWith('You write one Socratic question')) {
      const out = await (writer ?? (() => ({ question: GOOD })))(++writerCalls)
      return out
    }
    if (system.startsWith('You check a facilitator')) return (judgeA ?? (() => ({ reasoning: '', revealsFinding: false })))()
    return (judgeB ?? (() => ({ impliedFindings: [] })))()
  })
}

const writerCallsArgs = () => mockChat.mock.calls.filter((c) => String(c[1]).startsWith('You write one Socratic question'))

describe('runSocraticStage', () => {
  beforeEach(() => {
    mockChat.mockReset()
  })

  it('posts a valid first draft and never shows the writer the passage', async () => {
    wire({})
    const result = await runSocraticStage(input())

    expect(result).toEqual({ message: GOOD, source: 'writer' })
    const calls = writerCallsArgs()
    expect(calls).toHaveLength(1)
    const serialized = JSON.stringify(calls[0])
    expect(serialized).not.toContain('falls by roughly')
    expect(serialized).not.toContain('two quarters')
    expect(serialized).not.toContain('substantive replies')
    expect(calls[0][3]).toEqual(
      expect.objectContaining({ sourceLabel: 'Okonkwo-Reyes', concept: 'quota crowding', loadedWord: 'healthy' })
    )
  })

  it('redrafts via the writer only, with the rejection reasons, and never re-runs anything else', async () => {
    wire({ writer: (n) => ({ question: n === 1 ? 'Okonkwo-Reyes found it fell, no?' : GOOD }) })
    const result = await runSocraticStage(input())

    expect(result).toEqual({ message: GOOD, source: 'writer' })
    const calls = writerCallsArgs()
    expect(calls).toHaveLength(2)
    expect(calls[1][3].rejected).toContain('Okonkwo-Reyes found it fell, no?')
    expect(calls[1][3].rejected).toContain('Fix:')
  })

  it('posts the template, free of findings, when every draft leaks', async () => {
    wire({ writer: () => ({ question: LEAKY }) })
    const result = await runSocraticStage(input())

    expect(writerCallsArgs()).toHaveLength(4)
    expect(result?.source).toBe('template')
    expect(result?.message).toBe('When we say "healthy", would Okonkwo-Reyes mean the same thing by it?')
    expect(result?.message).not.toMatch(/third|fell|quarter|recover/i)
  })

  it('does not feed judge reasoning (which may quote the passage) back to the writer', async () => {
    wire({
      judgeA: () => ({ reasoning: 'it reveals that engagement collapsed 62 percent', revealsFinding: true }),
      writer: () => ({ question: GOOD })
    })
    await runSocraticStage(input())

    for (const c of writerCallsArgs()) expect(JSON.stringify(c)).not.toContain('collapsed 62')
  })

  it('fails closed when judge (a) throws: the draft is not posted', async () => {
    wire({
      judgeA: () => {
        throw new Error('llm down')
      }
    })
    const result = await runSocraticStage(input())

    expect(result?.source).toBe('template')
    expect(result?.message).not.toBe(GOOD)
  })

  it('fails closed when judge (b) throws or extracts a finding', async () => {
    wire({
      judgeB: () => {
        throw new Error('llm down')
      }
    })
    expect((await runSocraticStage(input()))?.source).toBe('template')

    wire({ judgeB: () => ({ impliedFindings: ['replies fell'] }) })
    expect((await runSocraticStage(input()))?.source).toBe('template')
  })

  it('counts a writer error as a failed attempt and keeps trying', async () => {
    wire({
      writer: (n) => {
        if (n === 1) throw new Error('boom')
        return { question: GOOD }
      }
    })
    expect(await runSocraticStage(input())).toEqual({ message: GOOD, source: 'writer' })
  })

  it('stays silent when the template would repeat a recent post', async () => {
    wire({ writer: () => ({ question: LEAKY }) })
    const result = await runSocraticStage(
      input({ recentPosts: ['When we say "healthy", would Okonkwo-Reyes mean the same thing by it?'] })
    )
    expect(result).toBeNull()
  })

  it('uses the concept template when there is no loaded word', async () => {
    wire({ writer: () => ({ question: LEAKY }) })
    const result = await runSocraticStage(input({ slots: { ...slots, loadedWord: null } }))
    expect(result?.message).toBe("How does Okonkwo-Reyes treat quota crowding, and does that fit what we're describing?")
  })

  it('jumps to the template (not silence) when the time budget runs out', async () => {
    wire({ writer: () => new Promise(() => undefined) })
    const result = await runSocraticStage(input({ budgetMs: 20 }))
    expect(result?.source).toBe('template')
  })
})
