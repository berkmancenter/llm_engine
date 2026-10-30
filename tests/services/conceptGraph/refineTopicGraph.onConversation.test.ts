import path from 'path'
import { jest } from '@jest/globals'

/*
 * Exercises refineTopicGraph's `onConversation` option, which a locked job uses to renew its
 * lock while a long series backfill walks the conversations. Mocked at the llmChain boundary,
 * the same way and for the same reasons as refineTopicGraph.reset.test.ts.
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

describe('refineTopicGraph onConversation', () => {
  let agent
  let topicId: string

  beforeEach(async () => {
    mockGetChatPromptResponse.mockReset()
    agent = undefined
    mockGetChatPromptResponse.mockImplementation(async (_llm: unknown, systemPrompt: string) => {
      if (systemPrompt.includes('tidying the concept list')) return { groups: [] }
      if (systemPrompt.includes('Chatham House Rule')) return { flagged: [] }
      if (systemPrompt.includes('building a concept map of what the discussion turned on')) {
        return {
          concepts: [{ label: 'Alpha' }, { label: 'Beta' }],
          contributions: [{ kind: 'relates to', concepts: ['Alpha', 'Beta'] }],
          originPrompts: []
        }
      }
      if (systemPrompt.includes('maintaining a concept map built across a series')) return { extensions: [] }
      throw new Error(`unexpected prompt: ${systemPrompt.slice(0, 80)}`)
    })
    await insertUsers([userOne])
    const topic = newPublicTopic()
    topic.owner = userOne._id
    await insertTopics([topic])
    topicId = topic._id.toString()
    for (const name of ['one', 'two', 'three']) {
      const conversation = await Conversation.create({
        name: `Session ${name}`,
        slug: `session-${name}`,
        owner: userOne._id,
        topic: topic._id
      })
      agent ??= await new Agent({ agentType: 'conceptCartographer', conversation: conversation._id }).save()
      await Message.create({
        conversation: conversation._id,
        channels: ['transcript'],
        pseudonym: 'Speaker',
        pseudonymId: agent._id,
        body: `A line about trust registries and verifiers in session ${name}.`
      })
    }
  })

  it('calls the callback once per conversation read in the backfill', async () => {
    const onConversation = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)

    const result = await conceptGraphService.refineTopicGraph(topicId, agent, undefined, { onConversation })

    expect(result).not.toBeNull()
    expect(onConversation).toHaveBeenCalledTimes(3)
  })

  it('does not fail the run when the callback throws', async () => {
    const onConversation = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('lock renewal failed'))

    const result = await conceptGraphService.refineTopicGraph(topicId, agent, undefined, { onConversation })

    expect(result).not.toBeNull()
    expect(onConversation).toHaveBeenCalledTimes(3)
  })
})
