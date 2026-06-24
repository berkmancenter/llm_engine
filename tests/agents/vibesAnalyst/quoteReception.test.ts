import annotateReceptions from '../../../src/agents/vibesAnalyst/quoteReception.js'
import { quoteAppearsIn } from '../../../src/agents/vibesAnalyst/spikeAnnotation.js'
import { getModelChat, supportedModels } from '../../../src/agents/helpers/getModelChat.js'
import { LlmPlatforms } from '../../../src/types/index.types.js'

jest.setTimeout(45000) // LLM calls can be slow

const EVENT_START = new Date('2026-06-10T10:00:00.000Z')
const at = (minutes: number) => new Date(EVENT_START.getTime() + minutes * 60 * 1000)

/* One speaker line on the transcript, then a clearly oppositional burst of chat right
   after it: a spark and a pushback reaction the labeler should be able to read. */
const sparkLine = {
  body: 'we should ban gas stoves entirely',
  pseudonym: 'Speaker',
  fromAgent: false,
  createdAt: at(5),
  channels: ['transcript']
}
const reactionChat = [
  { body: 'no way, gas is better for cooking', pseudonym: 'ana', fromAgent: false, createdAt: at(5.5), channels: ['chat'] },
  { body: 'my landlord would never replace it', pseudonym: 'bo', fromAgent: false, createdAt: at(6), channels: ['chat'] },
  {
    body: 'that feels like government overreach honestly',
    pseudonym: 'cy',
    fromAgent: false,
    createdAt: at(6.5),
    channels: ['chat']
  },
  {
    body: 'induction is just not the same for a wok',
    pseudonym: 'di',
    fromAgent: false,
    createdAt: at(7),
    channels: ['chat']
  }
]

describe('annotateReceptions', () => {
  let llm

  beforeAll(async () => {
    const llmPlatform = process.env.TEST_LLM_PLATFORM || supportedModels[0].llmPlatform
    const llmModel = process.env.TEST_LLM_MODEL || supportedModels[0].llmModel
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel)
  })

  it('labels a speaker moment with verbatim spark and reaction quotes and a sentiment', async () => {
    const receptions = await annotateReceptions([sparkLine, ...reactionChat], 10, llm)

    expect(receptions).toHaveLength(1)
    const [reception] = receptions

    // Both quotes must be verbatim text from their source, the spark from the transcript
    // line and the reaction from the chat that followed.
    expect(quoteAppearsIn(reception.sparkQuote, [sparkLine])).toBe(true)
    expect(quoteAppearsIn(reception.reactionQuote, reactionChat)).toBe(true)
    expect(reception.reactionVolume).toBe(reactionChat.length)
    expect(['agreement', 'pushback', 'mixed']).toContain(reception.sentiment)
  })

  it('returns nothing when no speaker line drew a reaction, without calling the model', async () => {
    const quietLine = {
      body: 'a quiet aside',
      pseudonym: 'Speaker',
      fromAgent: false,
      createdAt: at(30),
      channels: ['transcript']
    }
    const loneReply = { body: 'ok', pseudonym: 'ana', fromAgent: false, createdAt: at(30.5), channels: ['chat'] }
    // Throws if the model is ever invoked; selection should short-circuit before that.
    const poisonLlm = {
      invoke: () => {
        throw new Error('model should not be called when nothing cleared the floor')
      }
    }

    const receptions = await annotateReceptions([quietLine, loneReply], 10, poisonLlm)

    expect(receptions).toEqual([])
  })
})
