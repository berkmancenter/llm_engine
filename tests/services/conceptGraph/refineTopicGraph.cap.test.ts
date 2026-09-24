import path from 'path'
import { jest } from '@jest/globals'
import type { ExtractionResult } from '../../../src/services/conceptGraph/assemble.js'

/*
 * Exercises refineTopicGraph's cap-triggering glue itself — the block in index.ts that
 * checks payload.concepts.length against CONCEPT_CAP, computes degree, splits candidates from
 * central concepts, and calls proposeConsolidations before applying the fold. Everything on
 * either side of that glue already has its own isolated coverage: proposeConsolidations in
 * consolidate.test.ts, and the fold-application path through assembleGraph in assemble.test.ts.
 * This is the one thing neither of those exercises as wired code.
 *
 * Mocked at the llmChain boundary, same as consolidate.test.ts/aliasResolution.test.ts — the
 * only reliable way to mock an ES module here (see tests/CLAUDE.md). getModelChat itself is
 * left real: it only builds a chat-model client object (cheap, no network call at
 * construction), and every actual model call — alias resolution, the identity screen,
 * consolidation — goes through the one mocked getChatPromptResponse below regardless of which
 * client it was handed, keyed off which prompt is asking.
 *
 * The mock below stubs every one of llmChain.ts's exports, not just getChatPromptResponse:
 * models/index.js's Agent model imports the full agent-type registry (agents/index.js),
 * which eagerly loads every agent implementation, several of which import other llmChain
 * helpers (getStructuredResponseChain, etc.) purely as references, never called here. Under
 * ESM, ANY named import a module needs but a mock factory doesn't provide is a hard link-time
 * SyntaxError for the whole file — not a missing-stub problem only at the call site that
 * needed it — so the stub list has to be complete even though this test only ever drives
 * getChatPromptResponse.
 *
 * Every other import below is dynamic, deliberately: a static import of models/index.js (or
 * of anything transitively pulling in agent registrations, e.g. via setupIntTest's own import
 * of src/jobs) would resolve the real llmChain.js into the module cache before the mock below
 * ever registers, and the mock would silently do nothing — the same trap tests/CLAUDE.md warns
 * about, just one hop further away than the usual case.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule(path.resolve(process.cwd(), 'src/agents/helpers/llmChain.ts'), () => ({
  getChatPromptResponse: mockGetChatPromptResponse,
  // Never called by this test — every one of these belongs to some other agent type that
  // models/index.js's Agent model transitively loads, not to the concept graph path.
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
const { Agent, Conversation } = await import(path.resolve(process.cwd(), 'src/models/index.ts'))
const { default: conceptGraphService } = await import(path.resolve(process.cwd(), 'src/services/conceptGraph/index.ts'))
const { CONCEPT_CAP } = await import(path.resolve(process.cwd(), 'src/services/conceptGraph/topicGraph.ts'))

setupIntTest()
jest.setTimeout(20000)

/* A hub joined to CONCEPT_CAP leaves is CONCEPT_CAP + 1 concepts, one over the cap: every leaf
   has degree 1, the hub has degree CONCEPT_CAP, so byDegreeAsc's stable sort puts exactly one
   concept — the first leaf — below the cap line as the sole fold candidate, with the hub among
   the central concepts it might fold into. Deterministic without depending on real extraction.
   Derived from the real constant rather than a copied number, so this stays in sync with
   whatever CONCEPT_CAP is currently set to. */
const LEAF_COUNT = CONCEPT_CAP
const overCapExtraction = (): ExtractionResult => ({
  concepts: [{ label: 'Hub Concept' }, ...Array.from({ length: LEAF_COUNT }, (_, i) => ({ label: `Leaf ${i + 1}` }))],
  contributions: Array.from({ length: LEAF_COUNT }, (_, i) => ({
    kind: 'relates to',
    concepts: ['Hub Concept', `Leaf ${i + 1}`]
  })),
  originPrompts: []
})

const underCapExtraction = (): ExtractionResult => ({
  concepts: [{ label: 'Hub Concept' }, { label: 'Leaf 1' }],
  contributions: [{ kind: 'relates to', concepts: ['Hub Concept', 'Leaf 1'] }],
  originPrompts: []
})

/** Routes the one mocked LLM entry point to the right canned answer for whichever pass is
 *  asking, identified by a distinctive substring of that pass's own system prompt. */
function mockModelResponses(consolidationFolds: { into: string; fold: string[] }[]) {
  mockGetChatPromptResponse.mockImplementation(async (_llm: unknown, systemPrompt: string) => {
    if (systemPrompt.includes('tidying the concept list')) return { groups: [] } // ALIAS_PROMPT
    if (systemPrompt.includes('Chatham House Rule')) return { flagged: [] } // SCREEN_PROMPT
    if (systemPrompt.includes('trimming an overgrown concept map')) return { folds: consolidationFolds } // CONSOLIDATE_PROMPT
    throw new Error(`refineTopicGraph.cap.test: unexpected prompt: ${systemPrompt.slice(0, 80)}`)
  })
}

const consolidationCalls = () =>
  mockGetChatPromptResponse.mock.calls.filter(([, systemPrompt]) =>
    (systemPrompt as string).includes('trimming an overgrown concept map')
  )

describe('refineTopicGraph, folding a graph that has outgrown CONCEPT_CAP', () => {
  let topic
  let agent

  beforeEach(async () => {
    mockGetChatPromptResponse.mockReset()
    await insertUsers([userOne])
    topic = newPublicTopic()
    topic.owner = userOne._id
    await insertTopics([topic])
    const conversation = await Conversation.create({
      name: 'Mapped session',
      slug: 'mapped-session',
      owner: userOne._id,
      topic: topic._id
    })
    // An agent whose own conversation belongs to this topic may write the topic's artifacts —
    // see auth/access.ts's default ownConversation write grant — the same setup
    // conceptCartographer.agent.test.ts uses to exercise a real artifact write.
    agent = new Agent({ agentType: 'conceptCartographer', conversation: conversation._id })
    await agent.save()
  })

  it('invokes the fold path and folds the graph down when assembly produces more than CONCEPT_CAP concepts', async () => {
    mockModelResponses([{ into: 'Hub Concept', fold: ['Leaf 1'] }])

    const result = await conceptGraphService.refineTopicGraph(topic._id.toString(), agent, {
      results: [overCapExtraction()],
      texts: [],
      knownIdentities: []
    })

    expect(result).not.toBeNull()
    // Consolidation was actually asked, not skipped — the glue under test ran.
    expect(consolidationCalls()).toHaveLength(1)
    expect(result.report.foldedConcepts).toBeGreaterThan(0)
    // Fewer concepts survived than went in: assembly produced CONCEPT_CAP + 1, the fold above
    // removes one.
    expect(result.version.payload.concepts).toHaveLength(CONCEPT_CAP)
    expect(result.version.note).toMatch(/folded/i)
    // Versioning already preserves the pre-fold detail — the note should say so rather than
    // reading as if the fold were the only record of it.
    expect(result.version.note).toMatch(/previous version/i)
  })

  it('does not invoke the fold path for a graph that stays within CONCEPT_CAP', async () => {
    mockModelResponses([])

    const result = await conceptGraphService.refineTopicGraph(topic._id.toString(), agent, {
      results: [underCapExtraction()],
      texts: [],
      knownIdentities: []
    })

    expect(result).not.toBeNull()
    // Consolidation was never asked at all — the cap check itself did not fire.
    expect(consolidationCalls()).toHaveLength(0)
    expect(result.report.foldedConcepts).toBe(0)
    expect(result.version.payload.concepts).toHaveLength(2)
    expect(result.version.note).not.toMatch(/folded/i)
  })
})
