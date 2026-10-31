import { jest } from '@jest/globals'

/* Whole socratic stage with only the LLM chain mocked, dispatching on which prompt is being run, so
   the real writer, judge, checks and template are exercised. */

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

const GOOD = 'When we say "healthy", does Okonkwo-Reyes on quota crowding mean the same thing by it?'
const LEAKY = 'Okonkwo-Reyes found replies fell by a third, so is "healthy" about quota crowding?'

type Handlers = {
  writer?: (call: number) => unknown
  judge?: () => unknown
}

function wire({ writer, judge }: Handlers) {
  let writerCalls = 0
  mockChat.mockImplementation(async (_llm, system: string) => {
    if (system.startsWith('You write one Socratic question')) {
      const out = await (writer ?? (() => ({ question: GOOD })))(++writerCalls)
      return out
    }
    return (judge ?? (() => ({ span: null })))()
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

  it('never gives the writer the passage or judge output on redrafts', async () => {
    wire({
      judge: (() => {
        let n = 0
        return () => (++n === 1 ? { span: 'mean the same thing' } : { span: null })
      })()
    })
    const result = await runSocraticStage(input())

    expect(result).toEqual({ message: GOOD, source: 'writer' })
    const calls = writerCallsArgs()
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      const serialized = JSON.stringify(c)
      expect(serialized).not.toContain('falls by roughly')
      expect(serialized).not.toContain('presupposes')
      expect(serialized).not.toContain('mean the same thing"')
    }
    expect(calls[1][3].rejected).toContain('only ask how the source treats the concept')
  })

  it('passes when the judge quotes a span that is not in the draft', async () => {
    wire({ judge: () => ({ span: 'replies fell by a third' }) })
    expect(await runSocraticStage(input())).toEqual({ message: GOOD, source: 'writer' })
    expect(writerCallsArgs()).toHaveLength(1)
  })

  it('verifies the span case-, whitespace- and punctuation-insensitively', async () => {
    wire({ judge: () => ({ span: 'MEAN  the same, thing' }) })
    expect((await runSocraticStage(input()))?.source).toBe('template')
  })

  it('logs each rejected draft with stage and reason, and a summary, without leaking them to the writer', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation((() => logger) as never)
    wire({
      judge: () => ({ span: 'Okonkwo-Reyes on quota crowding' }),
      writer: (n) => ({ question: n === 1 ? 'Okonkwo-Reyes found it fell, no?' : GOOD })
    })
    await runSocraticStage(input())

    const lines = info.mock.calls.map((c) => String(c[0]))
    info.mockRestore()
    const rejects = lines.filter((l) => l.includes('draft rejected'))
    expect(rejects).toHaveLength(4)
    expect(rejects[0]).toContain('"attempt":1')
    expect(rejects[0]).toContain('"stage":"shape"')
    expect(rejects[0]).toContain('Okonkwo-Reyes found it fell, no?')
    expect(rejects[1]).toContain('judge:span')
    expect(rejects[1]).toContain('Okonkwo-Reyes on quota crowding')
    expect(lines.some((l) => l.includes('summary') && l.includes('"outcome":"posted-template"'))).toBe(true)
    expect(lines.some((l) => l.includes('"attempts":4'))).toBe(true)
    for (const c of writerCallsArgs()) expect(JSON.stringify(c)).not.toContain('judge:span')
  })

  it('does not go silent or post the unchecked draft when the judge errors: it posts the template', async () => {
    wire({
      judge: () => {
        throw new Error('llm down')
      }
    })
    const result = await runSocraticStage(input())
    expect(result?.source).toBe('template')
    expect(result?.message).not.toBe(GOOD)
  })

  it('skips the judge when SOCRATIC_JUDGE=off', async () => {
    process.env.SOCRATIC_JUDGE = 'off'
    try {
      wire({
        judge: () => {
          throw new Error('should not be called')
        }
      })
      expect(await runSocraticStage(input())).toEqual({ message: GOOD, source: 'writer' })
    } finally {
      delete process.env.SOCRATIC_JUDGE
    }
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
})
