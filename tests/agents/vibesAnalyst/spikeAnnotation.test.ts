import annotateSpikes, { quoteAppearsIn } from '../../../src/agents/vibesAnalyst/spikeAnnotation.js'
import { getModelChat, supportedModels } from '../../../src/agents/helpers/getModelChat.js'
import { ChatSpike, LlmPlatforms } from '../../../src/types/index.types.js'

jest.setTimeout(45000) // LLM calls can be slow

const EVENT_START = new Date('2026-06-10T10:00:00.000Z')
const at = (minutes: number) => new Date(EVENT_START.getTime() + minutes * 60 * 1000)

/* A burst of participant chat messages on one clear topic, with a bot line mixed in so
   the test can confirm the quote comes from a participant and never the bot. */
const windowMessages = [
  {
    body: 'Wait, the new policy bans remote work entirely?',
    pseudonym: 'ana',
    fromAgent: false,
    channels: ['chat'],
    createdAt: at(21)
  },
  {
    body: 'Yeah, everyone has to be back in the office by September.',
    pseudonym: 'bo',
    fromAgent: false,
    channels: ['chat'],
    createdAt: at(22)
  },
  {
    body: 'That is going to push a lot of people to quit.',
    pseudonym: 'cy',
    fromAgent: false,
    channels: ['chat'],
    createdAt: at(23)
  },
  {
    body: 'BeepBot here, I can summarize the policy if that helps.',
    pseudonym: 'beep',
    fromAgent: true,
    channels: ['chat'],
    createdAt: at(23)
  },
  {
    body: 'No way I can do a two hour commute again.',
    pseudonym: 'di',
    fromAgent: false,
    channels: ['chat'],
    createdAt: at(24)
  }
]

const messages = [
  { body: 'morning everyone', pseudonym: 'ana', fromAgent: false, channels: ['chat'], createdAt: at(2) },
  ...windowMessages,
  { body: 'thanks all, see you next time', pseudonym: 'bo', fromAgent: false, channels: ['chat'], createdAt: at(45) }
]

const spike: ChatSpike = {
  label: '20-30',
  startMinute: 20,
  endMinute: 30,
  messageCount: 4,
  baselineAverage: 0.5,
  ratio: 8,
  source: 'chat'
}

describe('annotateSpikes', () => {
  let llm

  beforeAll(async () => {
    const llmPlatform = process.env.TEST_LLM_PLATFORM || supportedModels[0].llmPlatform
    const llmModel = process.env.TEST_LLM_MODEL || supportedModels[0].llmModel
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel)
  })

  it('labels a spike with a topic and a participant quote that was really said', async () => {
    const annotated = await annotateSpikes(messages, EVENT_START, [spike], llm)

    expect(annotated).toHaveLength(1)
    const [result] = annotated
    expect(result.startMinute).toBe(20)
    expect(result.annotation).toBeDefined()
    expect(result.annotation!.topic.length).toBeGreaterThan(0)

    // The quote must be verbatim text from a participant message in the window.
    const participantWindow = windowMessages.filter((message) => !message.fromAgent)
    expect(quoteAppearsIn(result.annotation!.quote, participantWindow)).toBe(true)
    expect(result.annotation!.quote.toLowerCase()).not.toContain('beepbot')
  })

  it('leaves a spike unannotated when only a bot spoke during it, without calling the model', async () => {
    const botSpike: ChatSpike = {
      label: '40-50',
      startMinute: 40,
      endMinute: 50,
      messageCount: 3,
      baselineAverage: 1,
      ratio: 3,
      source: 'chat'
    }
    const botOnly = [
      { body: 'automated reminder', pseudonym: 'beep', fromAgent: true, channels: ['chat'], createdAt: at(41) }
    ]

    const annotated = await annotateSpikes(botOnly, EVENT_START, [botSpike], llm)

    expect(annotated[0].annotation).toBeUndefined()
  })

  it('leaves a private-source spike unannotated, never reading its messages or calling the model', async () => {
    const privateSpike: ChatSpike = {
      label: '20-30',
      startMinute: 20,
      endMinute: 30,
      messageCount: 4,
      baselineAverage: 0.5,
      ratio: 8,
      source: 'private'
    }

    // Even with quotable chat text in the window, a private spike is surfaced by count
    // alone, so it comes back with no annotation.
    const annotated = await annotateSpikes(messages, EVENT_START, [privateSpike], llm)

    expect(annotated[0].annotation).toBeUndefined()
  })
})
