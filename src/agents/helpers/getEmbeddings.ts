import { OpenAIEmbeddings } from '@langchain/openai'
import config from '../../config/config.js'
import { EmbeddingsPlatforms, EmbeddingsPlatformDetails, EmbeddingsModelDetails } from '../../types/index.types.js'
import logger from '../../config/logger.js'

export function getOpenAIEmbeddings(model) {
  logger.debug(`getOpenAIEmbeddings: ${model}`)
  return new OpenAIEmbeddings({
    model,
    configuration: {
      apiKey: config.embeddings.openAI.key,
      baseURL: config.embeddings.openAI.baseUrl,
      project: config.llms.openAI.project
    }
  })
}

export function getInfinityEmbeddings(model) {
  logger.debug(`getInfinityEmbeddings: ${model}`)
  return new OpenAIEmbeddings({
    model,
    configuration: {
      apiKey: config.infinity.key,
      baseURL: config.infinity.baseUrl,
      project: config.llms.openAI.project
    }
  })
}

export function getEmbeddings(platform: EmbeddingsPlatforms, model) {
  if (platform === 'openai') {
    return getOpenAIEmbeddings(model)
  }
  if (platform === 'infinity') {
    return getInfinityEmbeddings(model)
  }

  throw new Error(`Unknown embeddings platform: ${platform}`)
}

export const embeddingsPlatforms: EmbeddingsPlatformDetails[] = [
  { name: 'openai', description: 'OpenAI' },
  {
    name: 'infinity',
    description: 'Infinity OpenAI-compatible server',
    options: {
      useKeepAlive: true,
      baseUrl: config.infinity.baseUrl
    }
  }
]

export const supportedModels: EmbeddingsModelDetails[] = [
  {
    name: 'text-embedding-3-small',
    label: 'OpenAI Embeddings 3 Small',
    platform: 'openai',
    model: 'text-embedding-3-small',
    description: 'Fast, lightweight embeddings model'
  },
  {
    name: 'text-embedding-3-large',
    label: 'OpenAI Embeddings 3 Large',
    platform: 'openai',
    model: 'text-embedding-3-large',
    description: 'Fast, cost-effective embeddings for everyday uses'
  },
  {
    name: 'BAAI/bge-small-en-v1.5',
    label: 'BAAI BGE English 1.5',
    platform: 'infinity',
    model: 'BAAI/bge-small-en-v1.5',
    description: 'Fast open source embeddings model'
  }
]
