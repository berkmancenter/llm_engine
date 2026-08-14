import { answerFollowUp } from '../../../src/agents/vibesAnalyst/followUp.js'
import { getModelChat, supportedModels } from '../../../src/agents/helpers/getModelChat.js'
import { LlmPlatforms } from '../../../src/types/index.types.js'

jest.setTimeout(45000) // LLM calls can be slow

/* Mirrors the real card a host asked a follow-up question about: a room where a meaningful
   share of people messaged the bot one-to-one rather than posting in the public chat. */
function cardWithPrivateSplit() {
  return [
    {
      posterCount: 20,
      messageCount: 200,
      channelSplit: { public: 150, private: 50 },
      privateMessageCount: 50,
      distinctPrivateSenders: 6,
      distinctPublicSenders: 18,
      participantCount: 80,
      lurkerCount: 60
    }
  ]
}

describe('answerFollowUp', () => {
  let llm

  beforeAll(async () => {
    const llmPlatform = process.env.TEST_LLM_PLATFORM || supportedModels[0].llmPlatform
    const llmModel = process.env.TEST_LLM_MODEL || supportedModels[0].llmModel
    // Matches the cap the Vibes Analyst agent runs its main-model passes with. Without it the
    // model defaults to 1024 tokens, which cuts the longest answers off mid-response.
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel, { maxTokens: 10000 })
  })

  it('answers when the events happened instead of refusing, since the rows carry each date', async () => {
    const trendRows = [
      { name: 'Test Fancy Vibes #3', endTime: new Date('2026-07-01T12:00:00.000Z'), posterCount: 12 },
      { name: 'Test Fancy Vibes #2', endTime: new Date('2026-07-01T12:00:00.000Z'), posterCount: 8 },
      { name: 'Test Fancy Vibes #1', endTime: new Date('2026-07-01T12:00:00.000Z'), posterCount: 5 }
    ]

    const answer = await answerFollowUp('what were the dates of these events?', trendRows, llm)

    // The date is in the rows, so this must not fall through to the "outside what I read" deflection.
    expect(answer.answerable).toBe(true)
    expect(answer.text).toMatch(/jul(y)?\s*1|7\/1|07\/01/i)
  })

  it('always explains "private" as messages to the bot, never a bare word a reader could mistake for a private group channel', async () => {
    const answer = await answerFollowUp(
      "what's the split between public and private messages, and what does private even mean here?",
      cardWithPrivateSplit(),
      llm
    )

    expect(answer.answerable).toBe(true)
    expect(answer.text).toBeTruthy()
    // "private" on its own is exactly the ambiguous word a host misread as a private group
    // channel between attendees; every mention must be paired with what it actually means.
    if (/privat/i.test(answer.text as string)) {
      expect(answer.text).toMatch(/bot/i)
    }
  })
})
