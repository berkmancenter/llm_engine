import config from '../../src/config/config.js'
import rag from '../../src/agents/helpers/rag.js'
import setupIntTest from './setupIntTest.js'
import { initializeEvaluators } from './evaluators.js'
import defaultAgentTypes from '../../src/agents/index.js'

const setupAgentTest = (agentType?) => {
  setupIntTest()

  let chromaCollectionPrefix
  beforeAll(async () => {
    chromaCollectionPrefix = config.chroma.embeddingsCollectionPrefix
    config.chroma.embeddingsCollectionPrefix = 'llm-engine-test'
    await initializeEvaluators()
  })

  beforeEach(async () => {
    // this will delete all collections with the test embeddings prefix
    await rag.deleteAllCollections()
  })

  afterAll(async () => {
    config.chroma.embeddingsCollectionPrefix = chromaCollectionPrefix
  })
  const testConfig = {
    llmPlatform: process.env.TEST_LLM_PLATFORM || (agentType ? defaultAgentTypes[agentType].defaultLLMPlatform : undefined),
    llmModel: process.env.TEST_LLM_MODEL || (agentType ? defaultAgentTypes[agentType].defaultLLMModel : undefined),
    embeddingsModel: config.embeddings.openAI.realtimeModel
  }

  return testConfig
}

export default setupAgentTest
