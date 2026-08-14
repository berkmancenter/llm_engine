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

  it('extracts a list of specific named events to compare, rather than a topic or a count', async () => {
    const reference = await extractEventReference('@Vibes compare the Spring Town Hall to the AI Ethics kickoff', llm)

    expect(reference.trend).toBe(true)
    expect(reference.eventNames?.length).toBe(2)
    const joined = (reference.eventNames ?? []).join(' ').toLowerCase()
    expect(joined).toContain('town hall')
    expect(joined).toContain('ethics')
    expect(reference.eventQuery.trim()).toBe('')
  })

  it('leaves eventNames empty for an ordinary topic or recent-N trend', async () => {
    const reference = await extractEventReference('@Vibes how was engagement across the last 3 events?', llm)

    expect(reference.eventNames ?? []).toEqual([])
  })

  it('classifies a specific numeric question as a question intent with quantitative scope', async () => {
    const reference = await extractEventReference('@Vibes how many people came to the Spring Town Hall?', llm)

    expect(reference.intent).toBe('question')
    expect(reference.scope).toBe('quantitative')
    expect(reference.eventQuery.toLowerCase()).toContain('town hall')
  })

  it('classifies a content question as a question intent with interpretive scope', async () => {
    const reference = await extractEventReference(
      '@Vibes what did people think of the keynote at the AI Ethics kickoff?',
      llm
    )

    expect(reference.intent).toBe('question')
    expect(reference.scope).toBe('interpretive')
  })

  it('classifies a question with both a numeric and a content ask as mixed scope', async () => {
    const reference = await extractEventReference(
      '@Vibes how many people showed up to the town hall, and what did people think of it?',
      llm
    )

    expect(reference.intent).toBe('question')
    expect(reference.scope).toBe('mixed')
  })

  it('does not flag a specific question as a trend', async () => {
    const reference = await extractEventReference('@Vibes how many people came to the Spring Town Hall?', llm)

    expect(reference.trend).toBe(false)
  })

  it('classifies a general recap ask as a recap intent even when phrased as a question, not a question intent', async () => {
    const reference = await extractEventReference('@Vibes how did the Spring Town Hall go?', llm)

    expect(reference.intent).toBe('recap')
  })

  it('sets scope to null for every intent other than question', async () => {
    const reference = await extractEventReference('@Vibes are you there?', llm)

    expect(reference.scope ?? null).toBeNull()
  })
})
