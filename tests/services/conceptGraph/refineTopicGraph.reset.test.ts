import path from 'path'
import { jest } from '@jest/globals'

/*
 * Exercises refineTopicGraph's `reset` option: an ordinary re-run folds the graph's current
 * version in as a merge source (`prior`), which is right for redoing a bad extraction but
 * means a concept already folded away by CONCEPT_CAP stays folded even after raising it — the
 * folded concept's own node is gone, and only its label survives on its survivor's
 * `foldedFrom`. `reset` exists to recompute from the raw transcripts alone instead, still
 * appending a version rather than overwriting, so the pre-reset graph is never lost.
 *
 * Real messages and a real backfill pass, since `reset` only has any effect on the backfill
 * path (see index.ts) — a mocked `incoming` extraction would skip straight past the thing
 * under test. Mocked at the llmChain boundary, same as refineTopicGraph.cap.test.ts and for
 * the same reasons — see that file's own comment for the ESM mocking trap this avoids.
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

/** A two-concept, one-contribution extraction naming `pair`, so each mocked pass through
 *  EXTRACTION_PROMPT can be told apart by the labels it lands in the assembled graph. */
const extractionOf = (pair: [string, string]) => ({
  concepts: pair.map((label) => ({ label })),
  contributions: [{ kind: 'relates to', concepts: pair }],
  originPrompts: []
})

/** Routes the one mocked LLM entry point to the right canned answer for whichever pass is
 *  asking, identified by a distinctive substring of that pass's own system prompt. */
function mockModelResponses(extraction: ReturnType<typeof extractionOf>) {
  mockGetChatPromptResponse.mockImplementation(async (_llm: unknown, systemPrompt: string) => {
    if (systemPrompt.includes('tidying the concept list')) return { groups: [] } // ALIAS_PROMPT
    if (systemPrompt.includes('Chatham House Rule')) return { flagged: [] } // SCREEN_PROMPT
    if (systemPrompt.includes('building a concept map of what the discussion turned on')) return extraction // EXTRACTION_PROMPT
    if (systemPrompt.includes('maintaining a concept map built across a series')) return { extensions: [] } // RELINK_PROMPT
    throw new Error(`refineTopicGraph.reset.test: unexpected prompt: ${systemPrompt.slice(0, 80)}`)
  })
}

describe('refineTopicGraph, resetting a series graph', () => {
  let topic
  let agent
  let topicId: string

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
    // see auth/access.ts's default ownConversation write grant, the same setup
    // refineTopicGraph.cap.test.ts uses.
    agent = new Agent({ agentType: 'conceptCartographer', conversation: conversation._id })
    await agent.save()
    topicId = topic._id.toString()

    // The one real transcript message every backfill in this suite reads. A single line is
    // enough: refineTopicGraph's backfill loop only needs a non-empty text to attempt
    // extraction, unlike generateConceptGraph's own MIN_SOURCE_CHARS floor.
    await Message.create({
      conversation: conversation._id,
      channels: ['transcript'],
      pseudonym: 'Speaker',
      pseudonymId: agent._id,
      body: 'A line about trust registries and verifiers, standing in for a real transcript.'
    })
  })

  it("keeps the current version's concepts in an ordinary re-run, but drops them on reset", async () => {
    // Version 1: backfill reads the one message; extraction is mocked to "Alpha"/"Beta".
    mockModelResponses(extractionOf(['Alpha', 'Beta']))
    const first = await conceptGraphService.refineTopicGraph(topicId, agent)
    expect(first!.version.payload.concepts.map((c) => c.label).sort()).toEqual(['Alpha', 'Beta'])

    // Version 2, an ordinary re-run: the same message is re-read and (mocked to) extract
    // "Gamma"/"Delta" this time, but "Alpha"/"Beta" still feeds in as `prior` — an ordinary
    // re-run never throws away what the graph already believed.
    mockModelResponses(extractionOf(['Gamma', 'Delta']))
    const second = await conceptGraphService.refineTopicGraph(topicId, agent)
    expect(second!.version.payload.concepts.map((c) => c.label).sort()).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma'])

    // Version 3, reset: the same message again extracts "Epsilon"/"Zeta", and this time
    // nothing from version 2 survives into it — reset skips `prior` entirely rather than
    // merging the graph's current state in.
    mockModelResponses(extractionOf(['Epsilon', 'Zeta']))
    const reset = await conceptGraphService.refineTopicGraph(topicId, agent, undefined, { reset: true })
    expect(reset!.version.payload.concepts.map((c) => c.label).sort()).toEqual(['Epsilon', 'Zeta'])
    expect(reset!.version.note).toMatch(/recomputed from scratch/i)
    expect(reset!.version.note).toMatch(/previous version/i)

    // Nothing about the pre-reset graph is gone: same artifact, one version further along, and
    // the version it discarded as a merge source is still there to read.
    expect(reset!.artifact._id).toEqual(first!.artifact._id)
    expect(reset!.version.versionNumber).toBe(3)
  })
})
