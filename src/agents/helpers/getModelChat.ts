import { ChatOpenAI } from '@langchain/openai'
import { ChatOllama } from '@langchain/ollama'
import { BedrockChat } from '@langchain/community/chat_models/bedrock'
import { google } from 'googleapis'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import config from '../../config/config.js'
import { createClaudeFetchFn } from './claudeHandler.js'
import { LlmPlatforms, LlmPlatformDetails, LlmModelDetails } from '../../types/index.types.js'

const PERSPECTIVE_API_URL = 'https://commentanalyzer.googleapis.com/$discovery/rest?version=v1alpha1'

export const supportedModels: LlmModelDetails[] = [
  // first one in list is default
  {
    name: 'haiku-4.5',
    label: 'AWS Bedrock Claude Haiku 4.5',
    llmPlatform: 'bedrock',
    llmModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    description: "Anthropic's fastest model with near-frontier intelligence"
  },
  {
    name: 'opus-4.5',
    label: 'AWS Bedrock Claude Opus 4.5',
    llmPlatform: 'bedrock',
    llmModel: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
    description: 'Premium model combining maximum intelligence with practical performance'
    // "effort" level is currently in beta only
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
  const supportedModel = supportedModels.find((m) => m.llmModel === model)
  const options = { ...(supportedModel?.defaultModelOptions || {}), ...modelOptions }
  if (platform === 'openai') {
    return getOpenAIChat(model, options)
  }
  if (platform === 'ollama') {
    return getOllamaChat(model, options)
  }
  if (platform === 'perspective') {
    return getPerspectiveChat()
  }
  if (platform === 'bedrock') {
    return getBedrockChat(model, options)
  }
  if (platform === 'google') {
    return getGoogleChat(model, options)
  }

  if (platform === 'vllm') {
    return getVllmChat(model, options, platformOptions)
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
