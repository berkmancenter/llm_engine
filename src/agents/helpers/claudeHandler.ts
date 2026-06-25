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
  temperature = 0,
  tools
}: {
  systemPrompt: string
  userMessages: Record<string, unknown>[]
  maxTokens?: number
  temperature?: number
  tools?: unknown[]
}) {
  const payload: Record<string, unknown> = {
    system: systemPrompt,
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature,
    messages: userMessages
  }

  if (tools && tools.length > 0) {
    payload.tools = tools
  }

  return payload
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

  // Extract maxTokens - check both snake_case (Bedrock API format) and camelCase (LangChain format)
  let maxTokens = 1024 // Default
  if (isObj) {
    const body = bodyContent as Record<string, unknown>
    if (typeof body.max_tokens === 'number') {
      maxTokens = body.max_tokens
    } else if (typeof body.maxTokens === 'number') {
      maxTokens = body.maxTokens
    }
  }
  const temperature =
    isObj && typeof (bodyContent as Record<string, unknown>).temperature === 'number'
      ? ((bodyContent as Record<string, unknown>).temperature as number)
      : 0

  // Extract tools if present
  const tools =
    isObj && Array.isArray((bodyContent as Record<string, unknown>).tools)
      ? ((bodyContent as Record<string, unknown>).tools as unknown[])
      : undefined

  // Deduplicate tool_use blocks in messages to work around LangGraph bug
  // where tool_use blocks can be duplicated in message history
  const deduplicatedMessages = messagesArr.map((msg) => {
    if (Array.isArray(msg.content)) {
      const toolUseIds = new Set<string>()
      const deduplicatedContent = msg.content.filter((block) => {
        if (block.type === 'tool_use') {
          if (toolUseIds.has(block.id)) {
            return false
          }
          toolUseIds.add(block.id)
        }
        return true
      })
      return { ...msg, content: deduplicatedContent }
    }
    return msg
  })

  return buildBedrockClaudePayload({
    systemPrompt,
    userMessages: deduplicatedMessages,
    maxTokens,
    temperature,
    tools
  })
}

// Reject ids with characters that could alter the URL path (e.g. "/", "?", "#"); the colon is allowed.
const BEDROCK_MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

/**
 * Builds the Bedrock V2 invoke URL for a model: {baseUrl}/model/{modelId}/invoke.
 *
 * The model id goes straight into the URL path and can come from user-set config, so this
 * validates it against the known Bedrock character set first and rejects anything else. It
 * keeps the colon in dated ids (for example ...-v1:0) raw to match HUIT's documented URLs.
 *
 * @throws if the model id contains characters that are not valid in a Bedrock model id.
 */
export function buildBedrockInvokeUrl(baseUrl: string, modelId: string): string {
  if (!BEDROCK_MODEL_ID_PATTERN.test(modelId)) {
    throw new Error(`Invalid Bedrock model id: "${modelId}"`)
  }
  // Drop any trailing slash so a base url like ".../v2/" does not produce a double slash.
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  return `${normalizedBaseUrl}/model/${modelId}/invoke`
}

// Create a custom fetch function for Bedrock Claude or legacy LLM
export function createClaudeFetchFn(defaultLLMModel: string, defaultLLMPlatform: string) {
  return async function fetchFn(url: string, init: Parameters<typeof fetch>[1]) {
    const fetchImpl = async () => {
      try {
        let bodyContent: unknown = {}
        if (init?.body) {
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

        // V2 sends the native Bedrock body directly, with no V1 { body, modelId, ... } envelope.
        const bodyString = JSON.stringify(bodyContent)
        const modifiedInit = {
          ...(init || {}),
          body: bodyString,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.llms.bedrock.key
          }
        }
        // V2 routes by model id in the path; buildBedrockInvokeUrl validates the id first.
        const invokeUrl = buildBedrockInvokeUrl(config.llms.bedrock.baseUrl, defaultLLMModel)
        const response = await fetch(invokeUrl, modifiedInit)
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
