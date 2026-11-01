import { jest } from '@jest/globals'

/* Whole socratic stage with only the LLM chain mocked, dispatching on which prompt is being run, so
   the real writer, checks and template are exercised. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockChat = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockChat
}))

const { default: logger } = await import('../../../../src/config/logger.js')
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

const GOOD = 'When we say "healthy", does Okonkwo-Reyes mean the same thing by it?'
const LEAKY = 'Okonkwo-Reyes found replies fell by a third, so is "healthy" about quota crowding?'

type Handlers = {
  writer?: (call: number) => unknown
}

function wire({ writer }: Handlers) {
  let writerCalls = 0
  mockChat.mockImplementation(async (_llm, system: string) => {
    if (system.startsWith('You write one Socratic question')) {
      return (writer ?? (() => ({ question: GOOD })))(++writerCalls)
    }
    throw new Error('unexpected LLM call')
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
    expect(String(calls[0][1])).toContain('IMPORTANT: keep the question genuinely open')
    expect(String(calls[0][1])).toContain("IMPORTANT: do not credit the source with the group's words")
    expect(String(calls[0][1])).toContain('IMPORTANT: ask exactly one thing')
    expect(calls[0][3]).toEqual(
      expect.objectContaining({ sourceLabel: 'Okonkwo-Reyes', concept: '(none)', loadedWord: 'healthy' })
    )
  })

  it('withholds the concept from the writer only when a loaded word is present', async () => {
    wire({ writer: () => ({ question: 'How does Okonkwo-Reyes treat quota crowding?' }) })
    await runSocraticStage(input({ slots: { ...slots, loadedWord: null } }))
    expect(writerCallsArgs()[0][3]).toEqual(expect.objectContaining({ concept: 'quota crowding' }))
  })

  it('redrafts a draft that pairs the loaded word with the concept, or uses a pronoun for the source', async () => {
    const drafts = [
      'When we say "healthy", would Okonkwo-Reyes mean quota crowding by that, or something broader?',
      'When we say "healthy", would Okonkwo-Reyes say that is what she means?',
      GOOD
    ]
    wire({ writer: (n) => ({ question: drafts[n - 1] }) })
    expect(await runSocraticStage(input())).toEqual({ message: GOOD, source: 'writer' })
    expect(writerCallsArgs()).toHaveLength(3)
    expect(writerCallsArgs()[1][3].rejected).toContain('do not pair it with any other term')
    expect(writerCallsArgs()[2][3].rejected).toContain('refer to the source only by its name')
  })

  it('redrafts a compound draft with the one-ask reason', async () => {
    const compound = 'When we say "healthy", would Okonkwo-Reyes use it, and does it match what we mean?'
    wire({ writer: (n) => ({ question: n === 1 ? compound : GOOD }) })
    expect(await runSocraticStage(input())).toEqual({ message: GOOD, source: 'writer' })
    expect(writerCallsArgs()[1][3].rejected).toContain('ask one thing only')
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

  it('logs each rejected draft with stage and reason, and a summary, without leaking them to the writer', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation((() => logger) as never)
    wire({
      writer: () => ({ question: 'Okonkwo-Reyes found it fell, no?' })
    })
    await runSocraticStage(input())

    const lines = info.mock.calls.map((c) => String(c[0]))
    info.mockRestore()
    const rejects = lines.filter((l) => l.includes('draft rejected'))
    expect(rejects).toHaveLength(4)
    expect(rejects[0]).toContain('"attempt":1')
    expect(rejects[0]).toContain('"stage":"shape"')
    expect(rejects[0]).toContain('Okonkwo-Reyes found it fell, no?')
    expect(rejects[3]).toContain('"attempt":4')
    expect(lines.some((l) => l.includes('summary') && l.includes('"outcome":"posted-template"'))).toBe(true)
    expect(lines.some((l) => l.includes('"attempts":4'))).toBe(true)
    for (const c of writerCallsArgs()) expect(JSON.stringify(c)).not.toContain('"stage"')
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
    expect(result?.message).toBe("How does Okonkwo-Reyes treat quota crowding?")
  })
})
