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
})
