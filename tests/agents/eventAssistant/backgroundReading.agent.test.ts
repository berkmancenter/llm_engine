/* eslint-disable no-console */
import path from 'path'
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createPublicTopic,
  createUser,
  createDirectMessage,
  createEventAssistantConversationWithResources,
  loadTheLineTranscript
} from '../../utils/agentTestHelpers.js'
import backgroundCollection from '../../../src/agents/helpers/backgroundCollection.js'
import { QuestionClassification } from '../../../src/agents/eventAssistant/eventQuestionHandler.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('eventAssistant')

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

const testTimeout = 120000

describe('eventAssistant background reading (boyle_line collection)', () => {
  let agent
  let conversation
  let topic
  let user1

  const startTime = new Date(Date.now() - 15 * 60 * 1000)

  beforeEach(async () => {
    user1 = await createUser('Curious Badger')
    topic = await createPublicTopic()

    conversation = await createEventAssistantConversationWithResources(
      {
        name: 'The Line: AI and the Future of Personhood',
        description:
          'Join Professor James Boyle, William Neal Reynolds Distinguished Professor of Law, for a celebration of his forthcoming book, The Line: AI and the Future of Personhood. The new title explores how technological developments in artificial intelligence challenge our concept of personhood, and of "the line" we believe separates our species from the rest of the world but that also separates "persons" with legal rights from objects.',
        presenters: [
          {
            name: 'James Boyle',
            bio: 'James Boyle is a professor at Duke Law School and author of The Line, The Public Domain, and Foucault in Cyberspace.'
          }
        ],
        moderators: [
          { name: 'Joseph Blocher', bio: 'Lanty L. Smith 1967 Distinguished Professor of Law at Duke Law School' }
        ]
      },
      user1,
      topic,
      startTime,
      boyleResources,
      testConfig.llmPlatform,
      testConfig.llmModel
    )

    const [testAgent] = conversation.agents
    agent = testAgent

    await loadTheLineTranscript(conversation, true)

    // Load PDFs into the background collection for this conversation
    const collectionName = `background-${conversation._id}`
    for (const resource of boyleResources) {
      const filePath = path.join(BOYLE_LINE_DIR, resource.fileName)
      await backgroundCollection.loadPdfIntoCollection(collectionName, filePath, resource.citation!, resource.title)
    }
  })

  it(
    'answers a question about the background reading that goes beyond the transcript',
    async () => {
      const msg = await createDirectMessage(
        'What does Boyle say about the public domain and the commons of the mind?',
        user1,
        conversation
      )
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 12 * 60 * 1000),
        count: 100,
        directMessages: true
      }

      const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [] }, msg)

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      console.log(`A: ${responses[0].message.text}`)
      expect([QuestionClassification.ON_TOPIC_ANSWER, QuestionClassification.ON_TOPIC_ASK_SPEAKER]).toContain(
        responses[0].classification
      )
      // Should have background reading in context
      expect(responses[0].context).toMatch(/Background Reading/)
      // Should reference The Public Domain article in response
      expect(responses[0].message.text).toMatch(/The Public Domain/i)
    },
    testTimeout
  )

  it(
    'still classifies off-topic questions as off-topic even with background reading loaded',
    async () => {
      const msg = await createDirectMessage('What is a good recipe for pasta?', user1, conversation)
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 300 * 1000),
        count: 100,
        directMessages: true
      }

      const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [] }, msg)

      expect(responses).toHaveLength(1)
      expect(responses[0].classification).toBe(QuestionClassification.OFF_TOPIC)
    },
    testTimeout
  )
})
