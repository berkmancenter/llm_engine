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
  temperature,
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
    messages: userMessages
  }

  if (temperature !== undefined) {
    payload.temperature = temperature
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
  // Only forward temperature if non-zero — LangChain defaults temperature to 0,
  // so a zero value is indistinguishable from "not set". Newer Claude models reject
  // the parameter entirely, so we omit it unless the caller explicitly set a value.
  const rawTemperature = isObj && typeof (bodyContent as Record<string, unknown>).temperature === 'number'
    ? ((bodyContent as Record<string, unknown>).temperature as number)
    : undefined
  const temperature = rawTemperature !== undefined && rawTemperature !== 0 ? rawTemperature : undefined

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
