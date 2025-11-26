import { IncludeEnum } from 'chromadb'
import mongoose from 'mongoose'
import { Conversation, Message } from '../../../src/models'
import Agent, { setAgentTypes } from '../../../src/models/user.model/agent.model'
import { publicTopic, conversationAgentsEnabled } from '../../fixtures/conversation.fixture'
import { insertTopics } from '../../fixtures/topic.fixture'
import { insertUsers, registeredUser } from '../../fixtures/user.fixture'
import defaultAgentTypes from '../../../src/agents/index.js'
import JobHandlers from '../../../src/jobs/handlers/index.js'
import { loadTranscript } from '../../utils/transcriptUtils'
import Job from '../../../src/models/job.model'
import setupAgentTest from '../../utils/setupAgentTest.js'
import rag, { TRANSCRIPT_COLLECTION_PREFIX } from '../../../src/agents/helpers/rag'
import { loadTestTranscript } from '../../utils/agentTestHelpers'

jest.setTimeout(120000)
const mockEvaluate = jest.fn()
const mockRespond = jest.fn()
const mockInitialize = jest.fn()
const mockTokenLimit = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockIntroduce = jest.fn()

const testAgentTypes = {
  perMessageWithMin: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
    isWithinTokenLimit: mockTokenLimit,
    start: mockStart,
    stop: mockStop,
    introduce: mockIntroduce,
    name: 'Test Per Message Min',
    description: 'An agent that responds per message after a certain number reached',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { minNewMessages: 2 } },
    timerPeriod: undefined,
    priority: 100,
    llmTemplateVars: { template: [] },
    defaultLLMTemplates: {
      template: 'Default template'
    },
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini',
    defaultLLMModelOptions: { prop: 'value' },
    defaultConversationHistorySettings: { timeWindow: 45 }
  }
}
let originalDeleteCollection
setupAgentTest()
describe('transcript handler tests', () => {
  let conversation
  beforeAll(async () => {
    setAgentTypes(testAgentTypes)
    originalDeleteCollection = rag.deleteCollection.bind(rag)
  })
  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])

    conversation = new Conversation(conversationAgentsEnabled)
    await conversation.save()
  })
  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
  })
  afterEach(async () => {
    jest.clearAllMocks()
    rag.deleteCollection = originalDeleteCollection
  })
  const transcript1 = `00:23 | Jessica: true or false no one wants to work
00:28 | Jessica: anymore this is a common refrain I've
00:31 | Jessica: heard from business owners over the past
00:34 | Jessica: 5 to 10 years especially over the last
00:37 | Jessica: five you may have even said it
00:41 | Jessica: yourself owners and managers are always
00:44 | Jessica: looking for help especially in today's
00:47 | Jessica: market and many struggle to find and
00:50 | Jessica: retain good
00:52 | Jessica: help and it is
00:54 | Jessica: true employees have the absolute pick of`

  const transcript2 = `00:58 | Jessica: the litter when it comes to their chosen
01:00 | Jessica: jobs and careers so they won't apply for
01:03 | Jessica: let alone stay at a job that doesn't fit
01:06 | Jessica: their values desired lifestyle or their
01:10 | Jessica: life
01:11 | Jessica: circumstances not only that in the
01:13 | Jessica: United States we are generally sicker
01:16 | Jessica: and die earlier than our other wealthy
01:18 | Jessica: Nation counterparts and I believe our
01:21 | Jessica: traditional work structures are
01:23 | Jessica: contributing to that so it's up to us
01:26 | Jessica: the employers to change we have to
01:29 | Jessica: change how we hire and how we manage to
01:32 | Jessica: keep our businesses running efficiently
01:34 | Jessica: and profitably we need to offer
01:36 | Jessica: part-time positions that are paid
01:38 | Jessica: full-time and offer greater flexibility`

  const transcript3 = `01:41 | Jessica: and
01:42 | Jessica: autonomy for businesses struggling to
01:45 | Jessica: find good workers to find employees
01:48 | Jessica: offering part-time positions will help
01:50 | Jessica: you appeal to people who maybe only have
01:53 | Jessica: a select hours to give to a
01:56 | Jessica: career I realize that certain businesses
01:59 | Jessica: and Industry and job types may not be
02:03 | Jessica: able to accommodate this or it will be
02:04 | Jessica: harder for them too but at the very
02:07 | Jessica: least if you take anything away from my
02:09 | Jessica: talk today I challenge you to question`
  test('should batch load transcripts', async () => {
    const startDate = new Date(Date.now() - 125 * 1000)

    const transcripts = [
      { text: transcript1, lastProcessedAt: new Date(startDate.getTime() - 15 * 1000) },
      { text: transcript2, lastProcessedAt: new Date(startDate.getTime() + 55 * 1000) },
      { text: transcript3, lastProcessedAt: new Date(startDate.getTime() + 100 * 1000) }
    ]
    const expectedTranscripts: string[] = []
    for (const transcript of transcripts) {
      await loadTranscript(transcript.text, conversation, ['transcript'], '|', startDate)
      // Fake job last run before first message
      await Job.findOneAndUpdate(
        { name: 'batchTranscript', conversationId: conversation._id },
        {
          $set: {
            lastProcessedAt: transcript.lastProcessedAt
          }
        },
        { upsert: true }
      )
      await JobHandlers.batchTranscript({ attrs: { data: { conversationId: conversation._id } } })
      expectedTranscripts.push(
        transcript.text.replace(/^(\d{2}):(\d{2}) \| [^:]+: /gm, (_, mm, ss) => {
          const totalSeconds = parseInt(mm, 10) * 60 + parseInt(ss, 10)
          const timestamp = new Date(startDate.getTime() + totalSeconds * 1000)
          const formatted = timestamp.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit'
          })
          return `[${formatted}] `
        })
      )
    }
    const coll = await rag.getCollection(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`)
    const fullCollection = await coll.get({ include: [IncludeEnum.Documents, IncludeEnum.Metadatas] })
    expect(fullCollection.documents).toHaveLength(3)
    for (let i = 0; i < 3; i++) {
      expect(fullCollection.documents[i]).toEqual(expectedTranscripts[i])
    }
  })
  describe('cleanUpTranscripts', () => {
    test('should delete old transcript messages and vector store collections', async () => {
      // Create old transcript messages (4 months ago)
      const fourMonthsAgo = new Date()
      fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4)
      conversation.startTime = fourMonthsAgo

      // Create an agent with transcript RAG enabled
      const agent = new Agent({
        agentType: 'perMessageWithMin',
        conversation,
        useTranscriptRAGCollection: true
      })
      await agent.save()

      // Add agent to conversation
      conversation.agents.push(agent)
      await conversation.save()

      await loadTestTranscript(conversation, `${transcript1}\n${transcript2}\n${transcript3}`, true)

      // Verify messages exist before cleanup
      const messagesBeforeCleanup = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(messagesBeforeCleanup).not.toHaveLength(0)

      // Verify vector store collection exists
      const collectionName = `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`
      const collBefore = await rag.getCollection(collectionName)
      expect(collBefore).toBeDefined()

      // Run cleanup
      await JobHandlers.cleanUpTranscripts()

      // Verify messages are deleted
      const messagesAfterCleanup = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(messagesAfterCleanup).toHaveLength(0)

      // Verify vector store collection is deleted
      await expect(rag.getCollection(collectionName)).rejects.toThrow()
    })
    test('should not delete recent transcript messages', async () => {
      // Create an agent with transcript RAG enabled
      const agent = new Agent({
        agentType: 'perMessageWithMin',
        conversation,
        useTranscriptRAGCollection: true
      })
      await agent.save()

      // Add agent to conversation
      conversation.agents.push(agent)
      await conversation.save()

      await loadTestTranscript(conversation, `${transcript1}\n${transcript2}\n${transcript3}`, true)

      // Verify messages exist before cleanup
      const messagesBeforeCleanup = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(messagesBeforeCleanup).not.toHaveLength(0)
      const messageCount = messagesBeforeCleanup.length

      // Verify vector store collection exists
      const collectionName = `${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`
      const collBefore = await rag.getCollection(collectionName)
      expect(collBefore).toBeDefined()

      // Run cleanup
      await JobHandlers.cleanUpTranscripts()

      // Verify messages are deleted
      const messagesAfterCleanup = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(messagesAfterCleanup).toHaveLength(messageCount)

      // Verify vector store collection is not deleted
      const collAfter = await rag.getCollection(collectionName)
      expect(collAfter).toBeDefined()
    })
    test('should handle conversations without RAG-enabled agents', async () => {
      const fourMonthsAgo = new Date()
      fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4)
      conversation.startTime = fourMonthsAgo
      // Create agent without transcript RAG
      const agent = new Agent({
        agentType: 'perMessageWithMin',
        conversation,
        useTranscriptRAGCollection: false
      })
      await agent.save()

      conversation.agents.push(agent)
      await conversation.save()

      await loadTestTranscript(conversation, `${transcript1}\n${transcript2}\n${transcript3}`, false)
      // Verify messages exist before cleanup
      const messagesBeforeCleanup = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(messagesBeforeCleanup).not.toHaveLength(0)
      // Run cleanup
      await JobHandlers.cleanUpTranscripts()

      // Verify messages are still deleted even without RAG
      const messagesAfterCleanup = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(messagesAfterCleanup).toHaveLength(0)
    })
    test('should handle empty result gracefully', async () => {
      // Run cleanup when there are no old transcripts
      await expect(JobHandlers.cleanUpTranscripts()).resolves.not.toThrow()
    })
    test('should continue processing other conversations if one fails', async () => {
      const fourMonthsAgo = new Date()
      fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4)

      // Create two conversations
      const conv1 = new Conversation({ ...conversationAgentsEnabled, _id: new mongoose.Types.ObjectId() })
      conv1.startTime = fourMonthsAgo

      const agent = new Agent({
        agentType: 'perMessageWithMin',
        conversation,
        useTranscriptRAGCollection: true
      })
      await agent.save()

      // Add agent to conversation
      conv1.agents.push(agent)

      await conv1.save()
      const conv2 = new Conversation({ ...conversationAgentsEnabled, _id: new mongoose.Types.ObjectId() })
      conv2.startTime = fourMonthsAgo
      await conv2.save()

      await loadTestTranscript(conv1, `${transcript1}\n${transcript2}\n${transcript3}`, true)
      await loadTestTranscript(conv2, `${transcript1}\n${transcript2}\n${transcript3}`, false)

      // Mock rag.deleteCollection to fail for conv1 but succeed for conv2
      rag.deleteCollection = jest.fn().mockImplementation(async (collectionName) => {
        if (collectionName === `${TRANSCRIPT_COLLECTION_PREFIX}-${conv1._id}`) {
          throw new Error('Simulated vector store error')
        }
        return originalDeleteCollection(collectionName)
      })

      // Run cleanup - should not throw
      await expect(JobHandlers.cleanUpTranscripts()).resolves.not.toThrow()

      // Both conversations should have messages deleted from Mongo
      const conv1Messages = await Message.find({ conversation: conv1._id, channels: { $in: ['transcript'] } })
      const conv2Messages = await Message.find({ conversation: conv2._id, channels: { $in: ['transcript'] } })

      expect(conv1Messages).toHaveLength(0)
      expect(conv2Messages).toHaveLength(0)
    })
  })
})
