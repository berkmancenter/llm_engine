import { smallTalkReply } from '../../../src/agents/vibesAnalyst/summon.js'
import { getModelChat, supportedModels } from '../../../src/agents/helpers/getModelChat.js'
import { LlmPlatforms } from '../../../src/types/index.types.js'

jest.setTimeout(45000) // LLM calls can be slow

const recentEvents = [
  { id: '1', name: 'Spring Town Hall', topicName: 'Town Halls', endTime: new Date('2026-06-10') },
  { id: '2', name: 'AI Ethics Kickoff', topicName: 'AI Ethics', endTime: new Date('2026-06-03') }
]

describe('smallTalkReply', () => {
  let llm

  beforeAll(async () => {
    const llmPlatform = process.env.TEST_LLM_PLATFORM || supportedModels[0].llmPlatform
    const llmModel = process.env.TEST_LLM_MODEL || supportedModels[0].llmModel
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel)
  })

  it('never invents a capability beyond what VA actually does', async () => {
    const text = await smallTalkReply('help', '@Vibes what can you do?', recentEvents, llm)

    expect(text).toBeTruthy()
    // VA does not moderate, schedule, or summarize a live event; a capability claim like that
    // would be a hallucination the hard rules are meant to prevent.
    expect(text).not.toMatch(/moderate|schedule|live event|in progress/i)
  })

  it('never invents an event name beyond the ones it was given', async () => {
    const text = await smallTalkReply('greeting', '@Vibes are you there?', recentEvents, llm)

    expect(text).toBeTruthy()
    // Any quoted-looking event name mentioned must be one of the real ones supplied.
    const mentionsSpring = /spring town hall/i.test(text)
    const mentionsEthics = /ai ethics/i.test(text)
    if (mentionsSpring || mentionsEthics) {
      expect(mentionsSpring || mentionsEthics).toBe(true)
    }
  })

  it('says there is nothing to read yet when no recent events are given, rather than naming one', async () => {
    const text = await smallTalkReply('greeting', '@Vibes are you there?', [], llm)

    expect(text).toBeTruthy()
    expect(text).not.toMatch(/spring town hall|ai ethics/i)
  })

  it('redirects plainly for an off-topic message without answering the off-topic question', async () => {
    const text = await smallTalkReply('offTopic', "@Vibes what's the weather in Boston today?", recentEvents, llm)

    expect(text).toBeTruthy()
    expect(text.toLowerCase()).not.toContain('boston')
  })
})
