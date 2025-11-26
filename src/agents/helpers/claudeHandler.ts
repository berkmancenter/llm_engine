import logger from '../../config/logger.js'
import config from '../../config/config.js'

// Helper to determine if Bedrock Claude format should be used
export function shouldUseClaudeFormat(model: string | undefined, platform: string | undefined): boolean {
  if (platform && typeof platform === 'string') {
    if (platform.toLowerCase().includes('bedrock') || platform.toLowerCase().includes('anthropic')) {
      return true
    }
    if (platform.toLowerCase().includes('openai')) {
      return false
    }
  }
  if (model && typeof model === 'string') {
    if (model.toLowerCase().includes('anthropic')) {
      return true
    }
    if (model.toLowerCase().includes('gpt-')) {
      return false
    }
  }
  return false
}

// Helper to build Bedrock Claude payload
export function buildBedrockClaudePayload({
  systemPrompt,
  userMessages,
  maxTokens = 1024,
  temperature = 0
}: {
  systemPrompt: string
  userMessages: Record<string, unknown>[]
  maxTokens?: number
  temperature?: number
}) {
  return {
    system: systemPrompt,
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature,
    messages: userMessages
  }
}

// Transform standard LLM payload to Bedrock Claude format if needed
export function transformPayloadForClaude(bodyContent: unknown, defaultLLMModel: string, defaultLLMPlatform: string) {
  const useClaudeFormat = shouldUseClaudeFormat(defaultLLMModel, defaultLLMPlatform)

  if (!useClaudeFormat) {
    return bodyContent // Return as-is for non-Claude models
  }

  const isObj = typeof bodyContent === 'object' && bodyContent !== null
  const hasSystem = isObj && Object.prototype.hasOwnProperty.call(bodyContent, 'system')
  const hasMessagesArray = isObj && Array.isArray((bodyContent as Record<string, unknown>).messages)
  const hasMessagesString = isObj && typeof (bodyContent as Record<string, unknown>).messages === 'string'

  if (!hasSystem || (!hasMessagesArray && !hasMessagesString)) {
    return bodyContent // Return as-is if not in expected format
  }

  const systemPrompt = String((bodyContent as Record<string, unknown>).system)

  let messagesArr
  if (hasMessagesArray) {
    messagesArr = (bodyContent as Record<string, unknown>).messages as Array<object>
  } else if (hasMessagesString) {
    messagesArr = [{ content: (bodyContent as Record<string, unknown>).messages, role: 'user' }]
  }

  if (!messagesArr || messagesArr.length === 0) {
    throw new Error('User message content is empty. Bedrock Claude requires a non-empty user message.')
  }

  // For Claude models, remove any structured output instructions from the system prompt
  // This prevents tool calling attempts that might cause issues
  let cleanedSystemPrompt = systemPrompt
  if (useClaudeFormat) {
    // Remove common structured output patterns
    cleanedSystemPrompt = systemPrompt
      .replace(/You must respond with a JSON object that matches the following schema:/gi, '')
      .replace(/The response must be a valid JSON object with the following structure:/gi, '')
      .replace(/Return your response as a JSON object with the following format:/gi, '')
      .replace(/Use the following JSON schema for your response:/gi, '')
      .replace(/```json\n[\s\S]*?\n```/g, '') // Remove JSON schema blocks
      .replace(/```\n[\s\S]*?\n```/g, '') // Remove any other code blocks
      .trim()
  }

  const maxTokens =
    isObj && typeof (bodyContent as Record<string, unknown>).maxTokens === 'number'
      ? ((bodyContent as Record<string, unknown>).maxTokens as number)
      : 1024
  const temperature =
    isObj && typeof (bodyContent as Record<string, unknown>).temperature === 'number'
      ? ((bodyContent as Record<string, unknown>).temperature as number)
      : 0

  return buildBedrockClaudePayload({
    systemPrompt: cleanedSystemPrompt,
    userMessages: messagesArr,
    maxTokens,
    temperature
  })
}

// Create a custom fetch function for Bedrock Claude or legacy LLM
export function createClaudeFetchFn(defaultLLMModel: string, defaultLLMPlatform: string) {
  return async function fetchFn(url: string, init: Parameters<typeof fetch>[1]) {
    const fetchImpl = async () => {
      try {
        let bodyContent: unknown = {}
        if (init?.body) {
          logger.debug('init.body before parse:', init.body)
          if (
            typeof init.body === 'string' &&
            (init.body.trim().toLowerCase().startsWith('<!doctype') || init.body.trim().toLowerCase().startsWith('<html'))
          ) {
            logger.error('init.body appears to be HTML, not JSON:', init.body)
            throw new Error('init.body is HTML, not JSON')
          }
          try {
            bodyContent = JSON.parse(init.body as string)
          } catch (err) {
            logger.error('init.body is not valid JSON:', init.body)
            throw err
          }
        }

        // Transform payload for Claude if needed
        bodyContent = transformPayloadForClaude(bodyContent, defaultLLMModel, defaultLLMPlatform)

        const body = {
          body: bodyContent,
          modelId: defaultLLMModel,
          contentType: 'application/json',
          accept: 'application/json'
        }
        const bodyString = JSON.stringify(body)
        const modifiedInit = {
          ...(init || {}),
          body: bodyString,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.llms.bedrock.key
          }
        }
        const response = await fetch(config.llms.bedrock.baseUrl, modifiedInit)
        const contentType = response.headers.get('content-type') || ''
        if (!response.ok) {
          const responseText = await response.text()
          logger.error('Error response Text from proxy:', responseText)
          throw new Error(`Bedrock proxy error: ${response.status} ${response.statusText}\n${responseText}`)
        }
        if (contentType.includes('application/json')) {
          return response
        }
        const responseText = await response.text()
        throw new Error(`Expected JSON from Bedrock proxy, got ${contentType}: ${responseText}`)
      } catch (err) {
        logger.error('Error in fetchFn:', err)
        throw err
      }
    }
    return fetchImpl()
  }
}
