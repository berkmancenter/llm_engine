import { extractEventReference } from '../../../src/agents/vibesAnalyst/eventResolution.js'
import { getModelChat, supportedModels } from '../../../src/agents/helpers/getModelChat.js'
import { LlmPlatforms } from '../../../src/types/index.types.js'

jest.setTimeout(45000) // LLM calls can be slow

describe('extractEventReference', () => {
  let llm

  beforeAll(async () => {
    const llmPlatform = process.env.TEST_LLM_PLATFORM || supportedModels[0].llmPlatform
    const llmModel = process.env.TEST_LLM_MODEL || supportedModels[0].llmModel
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel)
  })

  it('extracts a specific event title and does not flag latest', async () => {
    const reference = await extractEventReference('@Vibes can you recap the Spring Town Hall for me?', llm)

    expect(reference.latestInTopic).toBe(false)
    expect(reference.eventQuery.toLowerCase()).toContain('town hall')
  })

  it('flags a request for the most recent event in a topic', async () => {
    const reference = await extractEventReference('@Vibes how did the latest AI Ethics session go?', llm)

    expect(reference.latestInTopic).toBe(true)
    expect(reference.eventQuery.toLowerCase()).toContain('ethics')
  })

  it('flags a request for the single most recent event with no topic named', async () => {
    const reference = await extractEventReference('@Vibes tell me about the last event', llm)

    expect(reference.latestOverall).toBe(true)
  })

  it('does not flag a single-event recap as a trend', async () => {
    const reference = await extractEventReference('@Vibes can you recap the Spring Town Hall for me?', llm)

    expect(reference.trend).toBe(false)
  })

  it('flags a cross-event question as a trend and reads the count', async () => {
    const reference = await extractEventReference('@Vibes how was engagement across the last 3 events?', llm)

    expect(reference.trend).toBe(true)
    expect(reference.eventCount).toBe(3)
  })

  it('flags a trend without a count when none is stated', async () => {
    const reference = await extractEventReference('@Vibes has participation been trending up in the AI Ethics series?', llm)

    expect(reference.trend).toBe(true)
    expect(reference.eventCount).toBeNull()
    expect(reference.eventQuery.toLowerCase()).toContain('ethics')
  })

  it('classifies a recap request as a recap intent', async () => {
    const reference = await extractEventReference('@Vibes can you recap the Spring Town Hall for me?', llm)

    expect(reference.intent).toBe('recap')
  })

  it('classifies a greeting as a greeting intent and names no event', async () => {
    const reference = await extractEventReference('@Vibes are you there?', llm)

    expect(reference.intent).toBe('greeting')
    expect(reference.eventQuery.trim()).toBe('')
  })

  it('classifies a capability question as a help intent', async () => {
    const reference = await extractEventReference('@Vibes what can you do?', llm)

    expect(reference.intent).toBe('help')
  })

  it('classifies an unrelated question as an off-topic intent', async () => {
    const reference = await extractEventReference("@Vibes what's the weather in Boston today?", llm)

    expect(reference.intent).toBe('offTopic')
  })
})
