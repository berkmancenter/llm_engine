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
  {
    name: 'gpt-4o-mini',
    label: 'OpenAI GPT-4o Mini',
    llmPlatform: 'openai',
    llmModel: 'gpt-4o-mini',
    description: 'Fast, lightweight model ideal for everyday conversations and straightforward tasks'
  },
  {
    name: 'gpt-4.1-2025-04-14',
    label: 'OpenAI GPT-4.1',
    llmPlatform: 'openai',
    llmModel: 'gpt-4.1-2025-04-14',
    description: 'A general-purpose model designed to handle a wide range of questions and tasks.'
  },
  {
    name: 'gpt-5',
    label: 'OpenAI GPT-5',
    llmPlatform: 'openai',
    llmModel: 'gpt-5',
    description:
      'Powerful general-purpose model built to handle complex reasoning, detailed analysis, and a wide range of creative and technical tasks.',
    defaultModelOptions: { reasoningEffort: 'minimal' }
  },
  {
    name: 'haiku-3.5',
    label: 'AWS Bedrock Claude 3.5 Haiku',
    llmPlatform: 'bedrock',
    llmModel: 'anthropic.claude-3-5-haiku-20241022-v1:0',
    description: 'Fast, cost-effective model optimized for high-volume conversations and quick response times'
  },
  {
    name: 'sonnet-3.5',
    label: 'AWS Bedrock Claude 3.5 Sonnet',
    llmPlatform: 'bedrock',
    llmModel: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    description:
      'Balanced model offering strong intelligence and speed for everyday conversational tasks and complex reasoning'
  },
  {
    name: 'gemini-3-pro-preview',
    label: 'Google Gemini 3 Pro Preview',
    llmPlatform: 'google',
    llmModel: 'gemini-3-pro-preview',
    description: 'Advanced multimodal model designed to support deep, engaging conversations across a wide range of topics',
    defaultModelOptions: { thinkingConfig: { thinkingLevel: 'LOW' } }
  }
]

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
