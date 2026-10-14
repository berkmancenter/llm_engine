import path from 'path'
import { jest } from '@jest/globals'

/*
 * Exercises provenance stamping and session tracking on the series graph: the backfill path
 * (no `incoming` extraction — also what a reset takes) must stamp every node with the
 * conversation it was read from, a concept raised in two sessions must list both, carried
 * provenance must survive a later refinement, and the payload's `sessions` must be ordered by
 * event date. Real messages and a real backfill, mocked at the llmChain boundary like
 * refineTopicGraph.reset.test.ts (see that file for the ESM mocking trap this avoids).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule(path.resolve(process.cwd(), 'src/agents/helpers/llmChain.ts'), () => ({
  getChatPromptResponse: mockGetChatPromptResponse,
  getSinglePromptResponse: jest.fn(),
  getRAGAugmentedResponse: jest.fn(),
  shouldUseStructuredOutput: jest.fn(),
  pingLLM: jest.fn(),
  getStructuredResponseChain: jest.fn(),
  getAgentStructuredResponse: jest.fn(),
  extractToolCallTraceFromAgentResult: jest.fn(),
  extractCompleteSentences: jest.fn(),
  streamAgentAndReportChunks: jest.fn(),
  default: { getChatPromptResponse: mockGetChatPromptResponse }
}))

const { default: setupIntTest } = await import(path.resolve(process.cwd(), 'tests/utils/setupIntTest.ts'))
const { insertUsers, userOne } = await import(path.resolve(process.cwd(), 'tests/fixtures/user.fixture.ts'))
const { insertTopics, newPublicTopic } = await import(path.resolve(process.cwd(), 'tests/fixtures/topic.fixture.ts'))
const { Agent, Conversation, Message } = await import(path.resolve(process.cwd(), 'src/models/index.ts'))
const { default: conceptGraphService } = await import(path.resolve(process.cwd(), 'src/services/conceptGraph/index.ts'))

setupIntTest()
jest.setTimeout(20000)

const { default: mongoose } = await import('mongoose')

/** Routes the one mocked LLM entry point; the extraction answer depends on which session's
 *  transcript (identified by a marker in the chunk) it is reading. */
function mockModelResponses() {
  mockGetChatPromptResponse.mockImplementation(
    async (_llm: unknown, systemPrompt: string, _h: string, vars: { chunk?: string }) => {
      if (systemPrompt.includes('tidying the concept list')) return { groups: [] }
      if (systemPrompt.includes('Chatham House Rule')) return { flagged: [] }
      if (systemPrompt.includes('maintaining a concept map built across a series')) return { extensions: [] }
      if (systemPrompt.includes('building a concept map of what the discussion turned on')) {
        let pair = ['Delta', 'Epsilon']
        if (vars.chunk?.includes('SESSION-ONE')) pair = ['Alpha', 'Beta']
        else if (vars.chunk?.includes('SESSION-TWO')) pair = ['Alpha', 'Gamma']
        return {
          concepts: pair.map((label) => ({ label })),
          contributions: [{ kind: 'relates to', concepts: pair }],
          originPrompts: []
        }
      }
      throw new Error(`unexpected prompt: ${systemPrompt.slice(0, 80)}`)
    }
  )
}

describe('refineTopicGraph, stamping sessions on a series graph', () => {
  let agent
  let topicId: string
  let first
  let second

  beforeEach(async () => {
    mockGetChatPromptResponse.mockReset()
    mockModelResponses()
    await insertUsers([userOne])
    const topic = newPublicTopic()
    topic.owner = userOne._id
    await insertTopics([topic])
    topicId = topic._id.toString()
    // Created later-event-first so insertion order and date order disagree.
    second = await Conversation.create({
      name: 'Second session',
      slug: 'second-session',
      owner: userOne._id,
      topic: topic._id,
      startTime: new Date('2026-02-01T10:00:00Z')
    })
    first = await Conversation.create({
      name: 'First session',
      slug: 'first-session',
      owner: userOne._id,
      topic: topic._id,
      startTime: new Date('2026-01-01T10:00:00Z')
    })
    agent = new Agent({ agentType: 'conceptCartographer', conversation: first._id })
    await agent.save()
    for (const [conversation, marker] of [
      [first, 'SESSION-ONE'],
      [second, 'SESSION-TWO']
    ] as const) {
      await Message.create({
        conversation: conversation._id,
        channels: ['transcript'],
        pseudonym: 'Bold Aardvark',
        pseudonymId: agent._id,
        body: `${marker} a line about trust registries and verifiers, standing in for a transcript.`
      })
    }
  })

  it('stamps a backfill, unions a shared concept across sessions and orders sessions by date', async () => {
    const result = await conceptGraphService.refineTopicGraph(topicId, agent)
    const { payload } = result!.version
    const firstId = first._id.toString()
    const secondId = second._id.toString()

    const alpha = payload.concepts.find((c) => c.label === 'Alpha')
    const beta = payload.concepts.find((c) => c.label === 'Beta')
    const gamma = payload.concepts.find((c) => c.label === 'Gamma')
    expect(alpha.conversationIds.sort()).toEqual([firstId, secondId].sort())
    expect(beta.conversationIds).toEqual([firstId])
    expect(gamma.provenance).toEqual({ conversationId: secondId })
    expect(payload.contributions.map((k) => k.provenance.conversationId).sort()).toEqual([firstId, secondId].sort())

    expect(payload.sessions).toEqual([
      { conversationId: firstId, order: 1, title: 'First session', date: '2026-01-01T10:00:00.000Z' },
      { conversationId: secondId, order: 2, title: 'Second session', date: '2026-02-01T10:00:00.000Z' }
    ])
  })

  it('exposes no message id or pseudonym anywhere in the series payload', async () => {
    const result = await conceptGraphService.refineTopicGraph(topicId, agent)
    const json = JSON.stringify(result!.version.payload)

    expect(json).not.toContain('messageId')
    expect(json).not.toContain('pseudonym')
    expect(json).not.toContain('Bold Aardvark')
  })

  it('stamps new nodes from an incoming extraction without overwriting carried provenance', async () => {
    const before = await conceptGraphService.refineTopicGraph(topicId, agent)
    const carried = before!.version.payload.concepts.find((c) => c.label === 'Beta')
    const newcomer = new mongoose.Types.ObjectId().toString() // a conversation that cannot be loaded

    const after = await conceptGraphService.refineTopicGraph(topicId, agent, {
      results: [
        {
          concepts: [{ label: 'Beta' }, { label: 'Zeta' }],
          contributions: [{ kind: 'relates to', concepts: ['Beta', 'Zeta'] }],
          originPrompts: []
        }
      ],
      texts: ['x'],
      knownIdentities: [],
      conversationId: newcomer
    })
    const { payload } = after!.version
    const beta = payload.concepts.find((c) => c.label === 'Beta')
    const zeta = payload.concepts.find((c) => c.label === 'Zeta')

    expect(beta.provenance).toEqual(carried.provenance)
    expect(beta.conversationIds).toEqual([...carried.conversationIds, newcomer])
    expect(zeta.provenance).toEqual({ conversationId: newcomer })
    expect(payload.contributions.find((k) => k.concepts.includes(zeta.id)).provenance).toEqual({ conversationId: newcomer })
    // The unloadable conversation is still listed, last, with just its id and order.
    expect(payload.sessions.at(-1)).toEqual({ conversationId: newcomer, order: 3 })
    expect(payload.sessions.map((s) => s.order)).toEqual([1, 2, 3])
  })

  it('stamps a reset recompute, the supported way to regenerate a graph that lost its provenance', async () => {
    await conceptGraphService.refineTopicGraph(topicId, agent)
    const reset = await conceptGraphService.refineTopicGraph(topicId, agent, undefined, { reset: true })

    expect(reset!.version.payload.concepts.every((c) => c.provenance?.conversationId && c.conversationIds?.length)).toBe(
      true
    )
    expect(reset!.version.payload.sessions).toHaveLength(2)
  })
})
