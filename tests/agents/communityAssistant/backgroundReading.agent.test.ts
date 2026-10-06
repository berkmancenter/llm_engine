/* eslint-disable no-console */
import path from 'path'
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createUser, createPublicTopic, createConversation, createMessage } from '../../utils/agentTestHelpers.js'
import { Agent, Channel } from '../../../src/models/index.js'
import backgroundCollection from '../../../src/agents/helpers/backgroundCollection.js'
import rag from '../../../src/agents/helpers/rag.js'
import { ConversationHistory } from '../../../src/types/index.types.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('communityAssistant')

const BOT_NAME = 'Berkie'
const testTimeout = 120000

// Same fixture PDFs as eventAssistant's own background-reading test
// (tests/agents/eventAssistant/backgroundReading.agent.test.ts) — reused here to prove
// communityAssistant's search_resources tool retrieves from the same background-<conversationId>
// Chroma collection the generic resourceService/backgroundCollection pipeline already populates
// for any conversation type.
const BOYLE_LINE_DIR = path.join(process.cwd(), 'tests', 'test_rag_documents', 'boyle_line')

const boyleResources = [
  {
    source: 'speaker' as const,
    category: 'required' as const,
    title: 'The public domain: Enclosing the commons of the mind',
    authors: ['James Boyle'],
    year: '2008',
    citation: 'Boyle, J. (2008). The public domain: Enclosing the commons of the mind. Yale University Press.',
    fileName: 'the_public_domain.pdf',
    participantVisible: true
  },
  {
    source: 'speaker' as const,
    category: 'required' as const,
    title: 'Foucault in Cyberspace',
    authors: ['James Boyle'],
    year: '1997',
    citation:
      'Boyle, J. (1997) Foucault in Cyberspace: Surveillance, Sovereignty, and Hardwired Censors. University of Cincinnati Law Review 66 (1), 177-205.',
    fileName: 'foucault_in_cyberspace.pdf',
    participantVisible: true
  }
]

/* Fabricated — not a real paper. Boyle's book is real, well-documented content the model may
   already know from training data (confirmed live: a zero-tools agent answered it correctly
   from memory alone), so a content-based assertion there can't distinguish "retrieved from the
   uploaded PDF" from "already knew it." This resource's findings are invented specifically so a
   correct, specific answer is only possible if the content was actually retrieved and surfaced —
   there's no plausible way to hallucinate the exact invented term and figure together. */
const syntheticResource = {
  source: 'speaker' as const,
  category: 'required' as const,
  title: 'Entropic Trust Decay in Volunteer-Run Online Communities',
  authors: ['Mira Okonkwo-Reyes'],
  year: '2024',
  citation:
    'Okonkwo-Reyes, M. (2024). Entropic Trust Decay in Volunteer-Run Online Communities. ' +
    'Journal of Fictional Platform Studies, 12(3), 44-61.'
}
const SYNTHETIC_CONTENT =
  'Okonkwo-Reyes (2024) finds that volunteer moderator attention in decentralized online ' +
  "forums decays at approximately 17.3% per quarter, a pattern she terms 'entropic trust decay.' " +
  "The primary driver identified is what she calls 'invisible labor fatigue syndrome' — the " +
  'cumulative, unacknowledged cognitive cost of repeated low-stakes moderation decisions.'

function buildHistory(messages): ConversationHistory {
  return {
    start: new Date(Date.now() - 60 * 60 * 1000),
    end: new Date(),
    messages
  }
}

describe('communityAssistant background reading (boyle_line collection)', () => {
  let agent
  let conversation
  let topic
  let user1

  beforeEach(async () => {
    user1 = await createUser('Curious Badger')
    topic = await createPublicTopic()

    conversation = await createConversation(
      { name: 'Community Assistant Background Reading Test', resources: [...boyleResources, syntheticResource] },
      user1,
      topic
    )
    const testAgent = new Agent({
      agentType: 'communityAssistant',
      conversation,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel,
      agentConfig: { botName: BOT_NAME }
    })
    const channels = await Channel.create([{ name: 'chat' }])
    conversation.channels.push(...channels)
    await testAgent.save()
    conversation.agents.push(testAgent)
    await conversation.save()
    await testAgent.start()
    agent = testAgent

    // Load the fixture PDFs into this conversation's own background collection — mirrors what
    // resourceService.savePdf does for a real upload, without needing the actual HTTP upload.
    const collectionName = `background-${conversation._id}`
    for (const resource of boyleResources) {
      const filePath = path.join(BOYLE_LINE_DIR, resource.fileName)
      await backgroundCollection.loadPdfIntoCollection(collectionName, filePath, resource.citation, resource.title)
    }
    // No PDF behind this one — seed its fabricated content directly, same collection/shape a
    // real upload would produce (metadata.citation is what formatResourceChunk reads).
    await rag.addTextsToVectorStore(collectionName, [SYNTHETIC_CONTENT], {
      metadatas: [{ citation: syntheticResource.citation }]
    })
  })

  async function ask(body: string) {
    console.log(`Q: ${body}`)
    const msg = await createMessage(body, user1, conversation, ['chat'])
    const responses = await defaultAgentTypes.communityAssistant.respond.call(agent, buildHistory([]), msg)
    console.log(`A: ${responses[0]?.message}`)
    return responses
  }

  it(
    'surfaces background-reading content the model could not already know from training data',
    async () => {
      const responses = await ask(
        `@${BOT_NAME} what rate does moderator attention decay at in ` +
          'volunteer-run communities, and what does the researcher call this pattern?'
      )

      expect(responses).toHaveLength(1)
      const reply = responses[0].message.toLowerCase()
      expect(reply).toMatch(/17\.3%/)
      expect(reply).toMatch(/entropic trust decay/)
    },
    testTimeout
  )

  it(
    'does not fabricate background-reading content for an off-topic question',
    async () => {
      const responses = await ask(`@${BOT_NAME} what is a good recipe for pasta?`)

      expect(responses).toHaveLength(1)
      const reply = responses[0].message.toLowerCase()
      expect(reply).not.toMatch(/public domain|foucault|boyle|entropic trust decay|17\.3%/)
    },
    testTimeout
  )

  it(
    'does not query the background collection when resource_search is not in the tools list',
    async () => {
      const disabledConv = await createConversation(
        { name: 'Background Reading Disabled Test', resources: [...boyleResources, syntheticResource] },
        user1,
        topic
      )
      const disabledAgent = new Agent({
        agentType: 'communityAssistant',
        conversation: disabledConv,
        llmPlatform: testConfig.llmPlatform,
        llmModel: testConfig.llmModel,
        agentConfig: { botName: BOT_NAME, tools: [] }
      })
      const channels = await Channel.create([{ name: 'chat' }])
      disabledConv.channels.push(...channels)
      await disabledAgent.save()
      disabledConv.agents.push(disabledAgent)
      await disabledConv.save()
      await disabledAgent.start()

      // Index the same content into this conversation's own collection — the agent should never
      // query it, since search_resources isn't in its configured tools. Boyle's book is real,
      // publicly-discussed content, so asserting on the reply's wording isn't reliable here (a
      // web-search-enabled agent could legitimately find the same facts online, as it did when
      // this test first ran with tools: ['web_search']) — assert on the retrieval mechanism
      // directly instead.
      const collectionName = `background-${disabledConv._id}`
      for (const resource of boyleResources) {
        const filePath = path.join(BOYLE_LINE_DIR, resource.fileName)
        await backgroundCollection.loadPdfIntoCollection(collectionName, filePath, resource.citation, resource.title)
      }
      await rag.addTextsToVectorStore(collectionName, [SYNTHETIC_CONTENT], {
        metadatas: [{ citation: syntheticResource.citation }]
      })

      const ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion')
      console.log(`Q: @${BOT_NAME} what does Boyle say about the public domain and the commons of the mind?`)
      const msg = await createMessage(
        `@${BOT_NAME} what does Boyle say about the public domain and the commons of the mind?`,
        user1,
        disabledConv,
        ['chat']
      )
      const responses = await defaultAgentTypes.communityAssistant.respond.call(disabledAgent, buildHistory([]), msg)
      console.log(`A: ${responses[0]?.message}`)

      expect(responses).toHaveLength(1)
      expect(ragSpy).not.toHaveBeenCalledWith(collectionName, expect.anything(), expect.anything())
      ragSpy.mockRestore()
    },
    testTimeout
  )
})
