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

// Marker prompt-builders insert at the boundary between stable (cacheable) and volatile
// content in a composed system-prompt string. transformPayloadForClaude splits on this
// marker (removing it) and emits a 2-block `system` array with cache_control on the
// stable block — see docs/investigations/prompt-caching-bedrock.md for why the split
// happens here rather than earlier in the LangChain message pipeline. A system prompt
// without the marker is sent as a single string, unchanged from prior behavior.
export const CACHE_BREAKPOINT_MARKER = '\n\n<!-- prompt-cache-breakpoint -->\n\n'

interface ClaudeSystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

/**
 * Builds the `system` field for the Bedrock Claude payload.
 *  - An array is assumed to already be a correctly-shaped content-block array (e.g. a
 *    future caller with finer-grained control) and is passed through unchanged — this
 *    is the case blindly `String()`-coercing used to mangle into "[object Object]".
 *  - A plain string containing CACHE_BREAKPOINT_MARKER is split into a stable block
 *    (cached) and a volatile block (not cached); the marker itself is removed.
 *  - A plain string without the marker is passed through unchanged, exactly as before.
 */
function buildSystemField(rawSystem: unknown): string | ClaudeSystemBlock[] {
  if (Array.isArray(rawSystem)) {
    return rawSystem as ClaudeSystemBlock[]
  }
  const systemString = String(rawSystem)
  const markerIndex = systemString.indexOf(CACHE_BREAKPOINT_MARKER)
  if (markerIndex === -1) {
    return systemString
  }
  const stable = systemString.slice(0, markerIndex)
  const volatile = systemString.slice(markerIndex + CACHE_BREAKPOINT_MARKER.length)
  const blocks: ClaudeSystemBlock[] = [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } }]
  if (volatile) {
    blocks.push({ type: 'text', text: volatile })
  }
  return blocks
}

// Helper to build Bedrock Claude payload
export function buildBedrockClaudePayload({
  systemPrompt,
  userMessages,
  maxTokens = 1024,
  temperature,
  tools
}: {
  systemPrompt: string | ClaudeSystemBlock[]
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

  const systemPrompt = buildSystemField((bodyContent as Record<string, unknown>).system)

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
  const rawTemperature =
    isObj && typeof (bodyContent as Record<string, unknown>).temperature === 'number'
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
