/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path'
import { jest } from '@jest/globals'

/*
 * Canary tests for hidden messages. Three ways a message becomes hidden are seeded with a unique canary string
 * (flagged by an admin, written by a hidden author, a reply under a hidden message) next to a visible control. Each
 * generator runs with the LLM mocked; the canary must appear in no prompt and no persisted output, the control must,
 * and the provenance record must list the control but none of the hidden messages. Mocked at the llmChain boundary,
 * same as conceptGraph/refineTopicGraph.reset.test.ts — see that file for the ESM mocking trap this avoids.
 */

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
jest.unstable_mockModule('langsmith/traceable', () => ({
  traceable: (fn) => fn,
  getCurrentRunTree: jest.fn()
}))
jest.unstable_mockModule(path.resolve(process.cwd(), 'src/websockets/websocketGateway.ts'), () => ({
  default: {
    broadcastTranscriptStatusChange: jest.fn(),
    broadcastConversationAlmostEnding: jest.fn(),
    broadcastConversationStopped: jest.fn(),
    broadcastArtifactVersion: jest.fn()
  }
}))
// the recap's card writing and fact-check are not under test: they hand back the metrics they were given
const mockCurate = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule(path.resolve(process.cwd(), 'src/agents/vibesAnalyst/curate.ts'), () => ({
  default: mockCurate
}))
jest.unstable_mockModule(path.resolve(process.cwd(), 'src/agents/vibesAnalyst/verifyCuration.ts'), () => ({
  default: async (draft) => draft
}))

const root = (p: string) => path.resolve(process.cwd(), p)
const { default: setupIntTest } = await import(root('tests/utils/setupIntTest.ts'))
const { seedHideScenario, insertMessage, conversationOne } = await import(root('tests/fixtures/messageHide.fixture.ts'))
const { Agent, ArtifactVersion, Channel, Conversation, Message } = await import(root('src/models/index.ts'))
const { default: conceptGraphService } = await import(root('src/services/conceptGraph/index.ts'))
const { doStopConversation } = await import(root('src/services/conversation.service/lifecycle.ts'))
const { default: buildVibesSummary } = await import(root('src/agents/vibesAnalyst/buildSummary.ts'))
const { default: reportService } = await import(root('src/services/report.service.ts'))
const { default: getConversationHistory } = await import(root('src/agents/helpers/getConversationHistory.ts'))
const { loadHideContext } = await import(root('src/utils/messageVisibility.ts'))
const { VIBES_RECEPTION_SYSTEM_PROMPT } = await import(root('src/agents/vibesAnalyst/prompt.ts'))

setupIntTest()
jest.setTimeout(60000)

const CANARY = 'CANARY'
const CANARY_FLAGGED = 'CANARY-FLAGGED-7F3A'
const CANARY_AUTHOR = 'CANARY-AUTHOR-7F3A'
const CANARY_REPLY = 'CANARY-REPLY-7F3A'
const CONTROL = 'CONTROL-VISIBLE-7F3A'
// long enough that the concept graph has something to map (its floor is 400 characters)
const FILLER = ' participants compared how trust registries and verifiers could work together across institutions.'.repeat(6)

let s: Awaited<ReturnType<typeof seedHideScenario>>
let flagged: any
let flaggedReply: any
let control: any

/** Everything the model was sent. */
const promptText = () =>
  JSON.stringify(mockGetChatPromptResponse.mock.calls.map(([, system, template, vars]) => [system, template, vars]))
const ids = (list: any[] = []) => list.map((id) => id.toString())

/**
 * authorMsg (by the author hidden for the whole conversation) carries CANARY_AUTHOR and its reply CANARY_REPLY;
 * `flagged` is hidden on its own and its reply `flaggedReply` is hidden by the cascade; otherMsg is the control.
 */
beforeEach(async () => {
  mockGetChatPromptResponse.mockReset()
  mockGetChatPromptResponse.mockResolvedValue('A summary')
  s = await seedHideScenario()
  await Message.updateOne({ _id: s.authorMsg._id }, { body: `${CANARY_AUTHOR} said something` })
  await Message.updateOne({ _id: s.reply._id }, { body: `${CANARY_REPLY} under the hidden author` })
  await Message.updateOne({ _id: s.otherMsg._id }, { body: `${CONTROL}${FILLER}` })
  control = await Message.findById(s.otherMsg._id)
  flagged = await insertMessage(s.other, conversationOne, {
    body: `${CANARY_FLAGGED} flagged by an admin`,
    hiddenByAdmin: true
  })
  flaggedReply = await insertMessage(s.other, conversationOne, {
    body: `${CANARY_REPLY} under the flagged one`,
    parentMessage: flagged._id
  })
  await Conversation.updateOne({ _id: conversationOne._id }, { $addToSet: { hiddenAuthors: s.author._id } })
})

const expectProvenanceOf = (provenance: any) => {
  const sources = ids(provenance.sourceMessageIds)
  expect(sources).toContain(control._id.toString())
  for (const hidden of [s.authorMsg, s.reply, flagged, flaggedReply]) expect(sources).not.toContain(hidden._id.toString())
  expect(ids(provenance.authorIds)).toContain(s.other._id.toString())
  expect(ids(provenance.authorIds)).not.toContain(s.author._id.toString())
  expect(provenance.hiddenSetHash).toEqual(expect.any(String))
  expect(provenance.generatedAt).toBeInstanceOf(Date)
}

describe('post-stop summary', () => {
  it('never sends hidden chat to the model or stores it, and records its sources', async () => {
    await Conversation.updateOne({ _id: conversationOne._id }, { transcript: { status: 'active' } })
    await Message.insertMany(
      Array.from({ length: 20 }, (_, i) => ({
        conversation: conversationOne._id,
        channels: ['transcript'],
        body: `Speaker: line ${i + 1}`,
        pseudonym: 'Speaker',
        pseudonymId: conversationOne._id,
        owner: s.admin._id
      }))
    )

    await doStopConversation(await Conversation.findById(conversationOne._id))

    expect(promptText()).toContain(CONTROL)
    expect(promptText()).not.toContain(CANARY)
    const stored = await Conversation.findById(conversationOne._id)
    expect(stored!.summary).not.toContain(CANARY)
    expectProvenanceOf(stored!.summaryProvenance)
    expect(stored!.summaryProvenance!.generator).toBe('conversationSummary')
    // private, like the hidden flag: never serialized to a client
    expect(stored!.toJSON()).not.toHaveProperty('summaryProvenance')
  })
})

describe('Vibes Analyst recap', () => {
  it('never sends hidden chat to the annotators or the card, and records sources with per-quote ids', async () => {
    const spoken = new Date(Date.now() - 60_000)
    await insertMessage(s.other, conversationOne, {
      channels: ['transcript'],
      body: 'The speaker explains the registry design',
      createdAt: spoken
    })
    // enough visible reaction to clear the reception floor
    await Promise.all([1, 2].map((n) => insertMessage(s.other, conversationOne, { body: `${CONTROL} reaction ${n}` })))
    mockCurate.mockImplementation(async (metrics) => ({ metrics }))
    mockGetChatPromptResponse.mockImplementation(async (_llm, system) =>
      system === VIBES_RECEPTION_SYSTEM_PROMPT
        ? { sparkQuote: 'The speaker explains the registry design', reactionQuote: CONTROL, sentiment: 'agreement' }
        : 'A summary'
    )

    const conversation = await Conversation.findById(conversationOne._id)
    const { renderData, provenance } = await buildVibesSummary(conversation, {}, {})

    expect(promptText()).toContain(CONTROL)
    expect(promptText()).not.toContain(CANARY)
    expect(JSON.stringify(renderData)).not.toContain(CANARY)
    expect(JSON.stringify(renderData)).toContain(CONTROL)
    expectProvenanceOf(provenance)
    const reaction = provenance.quoteSources!.find((q) => q.ref === 'reception:0:reaction')
    expect(ids(reaction!.messageIds)).toContain(control._id.toString())
    expect(ids(reaction!.messageIds)).not.toContain(s.authorMsg._id.toString())
  })
})

describe('concept graph', () => {
  let agent: any

  const extraction = (pair: [string, string]) => ({
    concepts: pair.map((label) => ({ label })),
    contributions: [{ kind: 'relates to', concepts: pair }],
    originPrompts: []
  })
  const mockModel = (pair: [string, string]) =>
    mockGetChatPromptResponse.mockImplementation(async (_llm, system) => {
      if (system.includes('tidying the concept list')) return { groups: [] }
      if (system.includes('Chatham House Rule')) return { flagged: [] }
      if (system.includes('building a concept map of what the discussion turned on')) return extraction(pair)
      if (system.includes('maintaining a concept map built across a series')) return { extensions: [] }
      throw new Error(`unexpected prompt: ${system.slice(0, 80)}`)
    })

  beforeEach(async () => {
    agent = await Agent.create({ agentType: 'conceptCartographer', conversation: conversationOne._id })
  })

  it('never sends hidden chat to the extraction or stores it, and records version-level sources', async () => {
    mockModel(['Alpha', 'Beta'])

    const result = await conceptGraphService.generateConceptGraph(conversationOne._id.toString(), agent)

    expect(promptText()).toContain(CONTROL)
    expect(promptText()).not.toContain(CANARY)
    const stored: any = await ArtifactVersion.findById(result!.version._id).lean()
    expect(JSON.stringify(stored)).not.toContain(CANARY)
    expectProvenanceOf(stored.provenance)
    expect(stored.provenance.generator).toBe('conceptGraph')
    expect(result!.version.toJSON()).not.toHaveProperty('provenance')
  })

  describe('topic graph carry-forward', () => {
    let topicId: string
    let topicAgent: any
    const incomingOf = (r: any) => ({
      results: r.results,
      texts: r.texts,
      knownIdentities: r.knownIdentities,
      conversationId: conversationOne._id.toString(),
      pollRefs: r.pollRefs,
      sourceMessages: r.sourceMessages
    })
    const labelsOf = (r: any) => r.version.payload.concepts.map((c) => c.label)

    // version 1 is built while the author is still visible, so its concept names that author's subject
    const buildFirstVersion = async () => {
      await Message.updateOne({ _id: s.authorMsg._id }, { hiddenByAdmin: false })
      await Conversation.updateOne({ _id: conversationOne._id }, { $pull: { hiddenAuthors: s.author._id } })
      mockModel(['LaterHiddenConcept', 'Beta'])
      const first = await conceptGraphService.generateConceptGraph(conversationOne._id.toString(), agent)
      topicId = (await Conversation.findById(conversationOne._id))!.topic!.toString()
      topicAgent = await Agent.create({ agentType: 'conceptCartographer', conversation: conversationOne._id })
      return conceptGraphService.refineTopicGraph(topicId, topicAgent, incomingOf(first!))
    }

    it('merges the prior version when the hidden set has not changed, and records it', async () => {
      const v1 = await buildFirstVersion()
      expect(v1!.version.provenance.carriedForwardFrom).toBeUndefined()

      mockModel(['Gamma', 'Delta'])
      const second = await conceptGraphService.generateConceptGraph(conversationOne._id.toString(), agent)
      const v2 = await conceptGraphService.refineTopicGraph(topicId, topicAgent, incomingOf(second!))

      expect(v2!.version.provenance.generator).toBe('topicConceptGraph')
      expect(v2!.version.provenance.carriedForwardFrom.toString()).toBe(v1!.version._id.toString())
      expect(v2!.version.provenance.hiddenSetHash).toBe(v1!.version.provenance.hiddenSetHash)
      expect(labelsOf(v2)).toContain('LaterHiddenConcept')
    })

    it('does not merge the prior version once something was hidden since, and rebuilds from readable messages', async () => {
      const v1 = await buildFirstVersion()
      expect(labelsOf(v1)).toContain('LaterHiddenConcept')

      await Conversation.updateOne({ _id: conversationOne._id }, { $addToSet: { hiddenAuthors: s.author._id } })
      // only what is sent from here on is under test: version 1 legitimately read the author's message
      mockGetChatPromptResponse.mockClear()
      mockModel(['Gamma', 'Delta'])
      const second = await conceptGraphService.generateConceptGraph(conversationOne._id.toString(), agent)
      const v2 = await conceptGraphService.refineTopicGraph(topicId, topicAgent, incomingOf(second!))

      expect(labelsOf(v2)).not.toContain('LaterHiddenConcept')
      expect(v2!.version.provenance.carriedForwardFrom).toBeUndefined()
      expect(v2!.version.provenance.hiddenSetHash).not.toBe(v1!.version.provenance.hiddenSetHash)
      expect(ids(v2!.version.provenance.sourceMessageIds)).not.toContain(s.authorMsg._id.toString())
      expect(promptText()).not.toContain(CANARY)
      // the earlier version is still in the history
      const stored: any = await ArtifactVersion.findById(v1!.version._id).lean()
      expect(JSON.stringify(stored.payload)).toContain('LaterHiddenConcept')
    })

    it('rebuilds when the current version records no hash and something is hidden now', async () => {
      const v1 = await buildFirstVersion()
      // a version from before provenance existed: nothing says what was hidden when it was written
      await ArtifactVersion.updateOne({ _id: v1!.version._id }, { $unset: { 'provenance.hiddenSetHash': 1 } })

      mockGetChatPromptResponse.mockClear()
      mockModel(['Gamma', 'Delta'])
      const second = await conceptGraphService.generateConceptGraph(conversationOne._id.toString(), agent)
      const v2 = await conceptGraphService.refineTopicGraph(topicId, topicAgent, incomingOf(second!))

      // the scenario still has a flagged message, so the unknown version cannot be trusted
      expect(labelsOf(v2)).not.toContain('LaterHiddenConcept')
      expect(v2!.version.provenance.carriedForwardFrom).toBeUndefined()
    })
  })
})

describe('report.service', () => {
  it('leaves hidden chat out of a report that includes the chat channel', async () => {
    const agent = await Agent.create({
      agentType: 'eventAssistant',
      conversation: conversationOne._id,
      triggers: { perMessage: {} }
    })
    await Conversation.updateOne({ _id: conversationOne._id }, { agents: [agent._id] })
    await Channel.create({ name: 'dm-canary', direct: true, participants: [agent._id, s.other._id] })
    const conversation = await Conversation.findById(conversationOne._id)

    const report = await reportService.generateReport(conversation, 'directMessageResponses', 'text', 'UTC', ['chat'])

    expect(report).toContain(CONTROL)
    expect(report).not.toContain(CANARY)
  })
})

describe('getConversationHistory', () => {
  it('drops hidden-author and reply-to-hidden messages from a loaded list once given the hide context', async () => {
    const all = await Message.find({ conversation: conversationOne._id }).sort({ createdAt: 1 })
    const ctx = await loadHideContext(conversationOne._id)

    const bodies = (history) => history.messages.map((m) => m.body).join('\n')

    // without the context only the flag and what cascades from it inside the list can be seen
    expect(bodies(getConversationHistory(all, { count: 50 }))).not.toContain(CANARY_FLAGGED)
    expect(bodies(getConversationHistory(all, { count: 50 }))).not.toContain(`${CANARY_REPLY} under the flagged one`)
    const withContext = bodies(getConversationHistory(all, { count: 50, hideContext: ctx }))
    expect(withContext).not.toContain(CANARY)
    expect(withContext).toContain(CONTROL)
  })
})
