import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import { BedrockChat } from '@langchain/community/chat_models/bedrock'
import { google } from 'googleapis'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import config from '../../config/config.js'
import { createClaudeFetchFn } from './claudeHandler.js'
import { LlmPlatforms, LlmPlatformDetails, LlmModelDetails } from '../../types/index.types.js'

const PERSPECTIVE_API_URL = 'https://commentanalyzer.googleapis.com/$discovery/rest?version=v1alpha1'

export const supportedModels: LlmModelDetails[] = [
  // first one in list is default
  {
    name: 'opus-4.6',
    label: 'AWS Bedrock Claude Opus 4.6',
    llmPlatform: 'bedrock',
    llmModel: 'us.anthropic.claude-opus-4-6-v1',
    description: 'Premium model combining maximum intelligence with practical performance'
    // "effort" level is currently in beta only
  },
  {
    name: 'sonnet-4.6',
    label: 'AWS Bedrock Claude Sonnet 4.6',
    llmPlatform: 'bedrock',
    llmModel: 'us.anthropic.claude-sonnet-4-6',
    description: "Anthropic's fastest model with near-frontier intelligence"
  },
  {
    name: 'gpt-5.2',
    label: 'OpenAI GPT-5.2',
    llmPlatform: 'openai',
    llmModel: 'gpt-5.2-2025-12-11',
    description:
      'Powerful general-purpose model built to handle complex reasoning, detailed analysis, and a wide range of creative and technical tasks.'
    // defaults to "none"
    // defaultModelOptions: { reasoningEffort: 'high' }
  },
  {
    name: 'gemini-3-pro-preview',
    label: 'Google Gemini 3 Pro Preview',
    llmPlatform: 'google',
    llmModel: 'gemini-3-pro-preview',
    description: 'Advanced multimodal model designed to support deep, engaging conversations across a wide range of topics'
    // defaults to "HIGH"
    // defaultModelOptions: { thinkingConfig: { thinkingLevel: 'HIGH' } }
  }
]

export const defaultLLMPlatform = supportedModels[0].llmPlatform
export const defaultLLMModel = supportedModels[0].llmModel

// Image generation models (not included in supportedModels as they are not text models)
export const imageGenerationLLMModel = 'gemini-3-pro-image-preview'

// Model family aliases - maps friendly names (e.g., "opus", "sonnet") to the latest supported version
// This allows calling getModelChat with family names instead of exact model IDs
const modelFamilies: Record<string, string> = {
  opus: 'us.anthropic.claude-opus-4-6-v1',
  sonnet: 'us.anthropic.claude-sonnet-4-6',
  gpt: 'gpt-5.2-2025-12-11',
  gemini: 'gemini-3-pro-preview'
}

/**
 * Resolves a model identifier to its full model ID.
 * If the input is a family name (e.g., "opus", "sonnet"), returns the latest supported version.
 * Otherwise returns the input unchanged (assumes it's an exact model ID).
 */
function resolveModelId(modelIdentifier: string): string {
  return modelFamilies[modelIdentifier.toLowerCase()] || modelIdentifier
}

export async function getOpenAIChat(model, modelOptions) {
  const aiConfig = {
    ...modelOptions,
    model,
    configuration: {
      apiKey: config.llms.openAI.key,
      baseURL: config.llms.openAI.baseUrl,
      project: config.llms.openAI.project
    }
  }

  return new ChatOpenAI(aiConfig)
}

export async function getGoogleChat(model, modelOptions) {
  const aiConfig = {
    ...modelOptions,
    model,
    baseUrl: config.llms.google.baseUrl,
    configuration: {
      apiKey: config.llms.google.key
    }
  }
  return new ChatGoogleGenerativeAI(aiConfig)
}

export function getGoogleImageModel(model) {
  const client = new GoogleGenerativeAI(config.llms.google.key)
  return client.getGenerativeModel(
    {
      model
    },
    { baseUrl: config.llms.google.baseUrl }
  )
}

// vLLM uses OpenAI compatible request formats
export async function getVllmChat(model, modelOptions, platformOptions) {
  const aiConfig = {
    ...modelOptions,
    model,
    configuration: {
      apiKey: config.vllm.key,
      baseURL: platformOptions.baseUrl || config.vllm.baseUrl
    }
  }

  return new ChatOpenAI(aiConfig)
}

export async function getOllamaChat(model, modelOptionss) {
  const aiConfig = {
    ...modelOptionss,
    model,
    baseUrl: config.llms.ollama.baseUrl
  }

  return new ChatOllama(aiConfig)
}

export async function getPerspectiveChat() {
  return google.discoverAPI(PERSPECTIVE_API_URL)
}

export async function getBedrockChat(model, modelOptionss) {
  const aiConfig = {
    ...modelOptionss,
    fetchFn: createClaudeFetchFn(model, 'bedrock'),
    model,
    baseUrl: config.llms.bedrock.baseUrl,
    region: config.llms.bedrock.region,
    credentials: {
      accessKeyId: config.llms.bedrock.key,
      secretAccessKey: config.llms.bedrock.secret
    }
  }

  return new BedrockChat(aiConfig)
}

export async function getModelChat(platform: LlmPlatforms, model, modelOptions = {}, platformOptions = {}) {
  // Resolve model family names (e.g., "opus", "sonnet") to actual model IDs
  const resolvedModel = resolveModelId(model)

  const supportedModel = supportedModels.find((m) => m.llmModel === resolvedModel)
  const options = { ...(supportedModel?.defaultModelOptions || {}), ...modelOptions }
  if (platform === 'openai') {
    return getOpenAIChat(resolvedModel, options)
  }
  if (platform === 'ollama') {
    return getOllamaChat(resolvedModel, options)
  }
  if (platform === 'perspective') {
    return getPerspectiveChat()
  }
  if (platform === 'bedrock') {
    return getBedrockChat(resolvedModel, options)
  }
  if (platform === 'google') {
    return getGoogleChat(resolvedModel, options)
  }

  if (platform === 'vllm') {
    return getVllmChat(resolvedModel, options, platformOptions)
  }

  throw new Error(`Unknown LLM platform: ${platform}`)
}

export const llmPlatforms: LlmPlatformDetails[] = [
  { name: 'bedrock', description: 'Amazon Bedrock' },
  { name: 'openai', description: 'OpenAI' },
  { name: 'ollama', description: 'Ollama Open Source Models' },
  { name: 'perspective', description: 'Google Perspective API' },
  { name: 'google', description: 'Google Generative AI' },
  {
    name: 'vllm',
    description: 'vLLM OpenAI-compatible server',
    options: {
      useKeepAlive: true,
      baseUrl: config.vllm.baseUrl
    }
  }
]
