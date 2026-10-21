/* eslint-disable @typescript-eslint/no-explicit-any */
import setupIntTest from '../utils/setupIntTest.js'
import config from '../../src/config/config.js'
import { Conversation, Message } from '../../src/models/index.js'
import conversationAnalyticsService, {
  computeParticipation,
  loadMessagesForOnDemandMetrics
} from '../../src/services/conversationAnalytics.service.js'
import { seedHideScenario, conversationOne } from '../fixtures/messageHide.fixture.js'

/**
 * The analytics numbers feed a broadcast LLM summary, so they use the model audience: an admin-hidden
 * message (flagged, hidden author, reply under a hidden one) is counted by none of them.
 */
setupIntTest()

let s: Awaited<ReturnType<typeof seedHideScenario>>

const hideSingle = () => Message.updateOne({ _id: s.authorMsg._id }, { hiddenByAdmin: true })
const hideAuthor = () => Conversation.updateOne({ _id: conversationOne._id }, { $addToSet: { hiddenAuthors: s.author._id } })

beforeEach(async () => {
  s = await seedHideScenario()
  // the metrics read human messages by fromAgent: false, which the fixture leaves unset
  await Message.updateMany({ conversation: conversationOne._id }, { fromAgent: false })
})

describe('analytics counts with nothing hidden', () => {
  it('counts every human message and poster', async () => {
    expect(await computeParticipation(conversationOne._id)).toMatchObject({ posterCount: 2, messageCount: 3 })
  })
})

describe.each([
  ['a message hidden on its own', hideSingle],
  ['a hidden author', hideAuthor]
])('analytics with %s', (_name, hide) => {
  beforeEach(async () => {
    await hide()
  })

  it('computeParticipation leaves out the hidden message and the reply under it', async () => {
    expect(await computeParticipation(conversationOne._id)).toMatchObject({ posterCount: 1, messageCount: 1 })
  })

  it('loadMessagesForOnDemandMetrics leaves them out', async () => {
    const { messages } = await loadMessagesForOnDemandMetrics(conversationOne._id)
    expect(messages.map((m) => String((m as unknown as { _id: unknown })._id))).toEqual([s.otherMsg._id.toString()])
  })

  it('computeConversationMetrics counts neither their messages nor their bot summons', async () => {
    const botName = config.conversationBotName
    await Message.updateMany({ conversation: conversationOne._id }, { body: `${botName} hello` })
    const conversation = await Conversation.findById(conversationOne._id)

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.participation).toMatchObject({ posterCount: 1, messageCount: 1 })
    expect(metrics.botInvocations.count).toBe(1)
    expect(metrics.interactionStructure.threadCount).toBe(0)
  })
})
