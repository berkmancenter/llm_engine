import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import { Conversation, Message } from '../../../src/models/index.js'
import answerWithOnDemandMetrics from '../../../src/agents/vibesAnalyst/onDemand.js'
import conversationAnalyticsService from '../../../src/services/conversationAnalytics.service.js'
import { getModelChat, supportedModels } from '../../../src/agents/helpers/getModelChat.js'
import { LlmPlatforms } from '../../../src/types/index.types.js'

setupIntTest()

jest.setTimeout(120000) // an agent loop plus a fact-checking pass, both real LLM calls

const ownerId = new mongoose.Types.ObjectId()
const eventStart = new Date('2026-07-01T12:00:00.000Z')

/* Twelve posters, deliberately lopsided so a question has one exact right answer that no
   precomputed metric reports: four people sent 5 messages each, eight sent 1, and one of those
   eight came back at minute 50 with a straggler. So exactly 4 people posted more than three
   times, and 28 of the 29 messages landed in the first half hour. */
const busyPosters = ['p1', 'p2', 'p3', 'p4']
const quietPosters = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8']

/* Participation counts per person, so each pseudonym needs its own stable owner id or the
   personas collapse into one poster. */
const ownerByPseudonym = new Map<string, mongoose.Types.ObjectId>()
function ownerFor(pseudonym: string): mongoose.Types.ObjectId {
  if (!ownerByPseudonym.has(pseudonym)) ownerByPseudonym.set(pseudonym, new mongoose.Types.ObjectId())
  return ownerByPseudonym.get(pseudonym)!
}

async function seedLopsidedEvent() {
  const conversation = await Conversation.create({
    name: 'Spring Town Hall',
    slug: `hall-${new mongoose.Types.ObjectId().toString()}`,
    owner: ownerId,
    topic: new mongoose.Types.ObjectId(),
    startTime: eventStart,
    endTime: new Date(eventStart.getTime() + 60 * 60 * 1000),
    transcript: { status: 'stopped' }
  })

  const messages: Record<string, unknown>[] = []
  const push = (sender: string, minute: number) =>
    messages.push({
      body: 'a message in the chat',
      conversation: conversation._id,
      owner: ownerFor(sender),
      pseudonymId: ownerId,
      pseudonym: sender,
      fromAgent: false,
      channels: ['main'],
      createdAt: new Date(eventStart.getTime() + minute * 60 * 1000)
    })

  busyPosters.forEach((sender, index) => {
    for (let i = 0; i < 5; i += 1) push(sender, index + i * 2)
  })
  quietPosters.forEach((sender, index) => push(sender, index + 2))
  push('q8', 50) // the straggler, well outside the first half hour

  await Message.create(messages)
  return conversation
}

describe('answerWithOnDemandMetrics', () => {
  let llm

  beforeAll(async () => {
    const llmPlatform = process.env.TEST_LLM_PLATFORM || supportedModels[0].llmPlatform
    const llmModel = process.env.TEST_LLM_MODEL || supportedModels[0].llmModel
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel)
  })

  it('computes how many people cleared a message threshold, a number no precomputed metric holds', async () => {
    const conversation = await seedLopsidedEvent()
    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    const answer = await answerWithOnDemandMetrics(
      'how many people posted more than three times?',
      conversation,
      metrics,
      llm
    )

    // Four posters sent five messages each; the other eight sent one. Nothing in the metrics
    // blob reports a count at that threshold, so this only passes if a tool actually ran and
    // its number survived the fact-checking pass.
    expect(answer).not.toBeNull()
    expect(answer).toMatch(/\b(4|four)\b/i)
  })

  it('scopes a count to the window the question asked about', async () => {
    const conversation = await seedLopsidedEvent()
    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    const answer = await answerWithOnDemandMetrics(
      'how many messages were sent in the first 30 minutes?',
      conversation,
      metrics,
      llm
    )

    // 28 of the 29 messages landed before minute 30, so an answer of 29 means the model read
    // the event total off the metrics instead of computing the window.
    expect(answer).not.toBeNull()
    expect(answer).toMatch(/\b(28|twenty-eight)\b/i)
  })

  it('refuses a question about what was said rather than guessing at the content', async () => {
    const conversation = await seedLopsidedEvent()
    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    const answer = await answerWithOnDemandMetrics(
      'what were people actually arguing about in the chat?',
      conversation,
      metrics,
      llm
    )

    // No tool returns message text, so the honest outcome is no answer at all.
    expect(answer).toBeNull()
  })
})
