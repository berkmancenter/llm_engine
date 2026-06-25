import {
  shouldUseClaudeFormat,
  buildBedrockClaudePayload,
  transformPayloadForClaude,
  createClaudeFetchFn,
  buildBedrockInvokeUrl
} from '../../../src/agents/helpers/claudeHandler.js'
import config from '../../../src/config/config.js'

describe('claudeHandler', () => {
  describe('shouldUseClaudeFormat', () => {
    it('should return true for Bedrock platform', () => {
      expect(shouldUseClaudeFormat('gpt-4', 'bedrock')).toBe(true)
      expect(shouldUseClaudeFormat('claude-3', 'bedrock')).toBe(true)
    })

    it('should return true for Anthropic platform', () => {
      expect(shouldUseClaudeFormat('gpt-4', 'anthropic')).toBe(true)
      expect(shouldUseClaudeFormat('claude-3', 'anthropic')).toBe(true)
    })

    it('should return true for Anthropic models when platform is not specified', () => {
      expect(shouldUseClaudeFormat('anthropic.claude-3-5-sonnet-20240620-v1:0', undefined)).toBe(true)
      expect(shouldUseClaudeFormat('claude-3', undefined)).toBe(false) // claude-3 doesn't contain 'anthropic'
    })

    it('should prioritize platform over model name', () => {
      expect(shouldUseClaudeFormat('anthropic.claude-3-5-sonnet-20240620-v1:0', 'openai')).toBe(false)
      expect(shouldUseClaudeFormat('gpt-4', 'bedrock')).toBe(true)
    })

    it('should return false for OpenAI platform', () => {
      expect(shouldUseClaudeFormat('gpt-4', 'openai')).toBe(false)
      expect(shouldUseClaudeFormat('claude-3', 'openai')).toBe(false)
    })

    it('should return false for non-Bedrock/Anthropic models on non-Bedrock/Anthropic platforms', () => {
      expect(shouldUseClaudeFormat('gpt-4', 'bedrock')).toBe(true) // platform takes precedence
      expect(shouldUseClaudeFormat('claude-3-5-sonnet', 'bedrock')).toBe(true) // bedrock platform with claude model
    })

    it('should handle undefined inputs', () => {
      expect(shouldUseClaudeFormat(undefined, undefined)).toBe(false)
      expect(shouldUseClaudeFormat('gpt-4', undefined)).toBe(false)
      expect(shouldUseClaudeFormat(undefined, 'bedrock')).toBe(true)
    })
  })

  describe('buildBedrockClaudePayload', () => {
    it('should build correct Claude payload structure', () => {
      const result = buildBedrockClaudePayload({
        systemPrompt: 'You are a helpful assistant',
        userMessages: [{ role: 'user', content: 'Hello world' }],
        maxTokens: 2048,
        temperature: 0.7
      })

      expect(result).toEqual({
        anthropic_version: 'bedrock-2023-05-31',
        system: 'You are a helpful assistant',
        max_tokens: 2048,
        temperature: 0.7,
        messages: [{ role: 'user', content: 'Hello world' }]
      })
    })

    it('should use default values', () => {
      const result = buildBedrockClaudePayload({
        systemPrompt: 'You are a helpful assistant',
        userMessages: [{ role: 'User', content: 'Hello world' }]
      })

      expect(result.max_tokens).toBe(1024)
      expect(result.temperature).toBe(0)
    })

    it('should include tools when provided', () => {
      const tools = [
        {
          name: 'get_weather',
          description: 'Get weather information',
          input_schema: {
            type: 'object',
            properties: {
              location: { type: 'string' }
            }
          }
        }
      ]

      const result = buildBedrockClaudePayload({
        systemPrompt: 'You are a helpful assistant',
        userMessages: [{ role: 'user', content: 'Hello world' }],
        tools
      })

      expect(result.tools).toEqual(tools)
    })

    it('should not include tools field when tools array is empty', () => {
      const result = buildBedrockClaudePayload({
        systemPrompt: 'You are a helpful assistant',
        userMessages: [{ role: 'user', content: 'Hello world' }],
        tools: []
      })

      expect(result.tools).toBeUndefined()
    })

    it('should not include tools field when tools is not provided', () => {
      const result = buildBedrockClaudePayload({
        systemPrompt: 'You are a helpful assistant',
        userMessages: [{ role: 'user', content: 'Hello world' }]
      })

      expect(result.tools).toBeUndefined()
    })
  })

  describe('transformPayloadForClaude', () => {
    it('should transform standard payload to Claude format', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hello world' }],
        max_tokens: 2048,
        temperature: 0.7
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      expect(result.anthropic_version).toBe('bedrock-2023-05-31')
      expect(result.max_tokens).toBe(2048)
      expect(result.temperature).toBe(0.7)
      expect(result.messages).toHaveLength(1)
      expect(result.system).toBe('You are a helpful assistant')
    })

    it('should handle string messages', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: 'Hello world',
        maxTokens: 1024,
        temperature: 0
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      expect(result.messages[0].content).toBe('Hello world')
      expect(result.messages[0].role).toBe('user')
    })

    it('should return payload as-is for non-Claude models', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [{ content: 'Hello world' }]
      }

      const result = transformPayloadForClaude(inputPayload, 'gpt-4', 'openai')

      expect(result).toBe(inputPayload)
    })

    it('should return payload as-is for non-standard format', () => {
      const inputPayload = {
        messages: [{ content: 'Hello world' }]
        // missing system field
      }

      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock')

      expect(result).toBe(inputPayload)
    })

    it('should throw error for empty user messages', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: []
      }

      expect(() => {
        transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock')
      }).toThrow('User message content is empty. Bedrock Claude requires a non-empty user message.')
    })

    it('should extract maxTokens from camelCase format', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hello world' }],
        maxTokens: 3000
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      expect(result.max_tokens).toBe(3000)
    })

    it('should extract maxTokens from snake_case format', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hello world' }],
        max_tokens: 4000
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      expect(result.max_tokens).toBe(4000)
    })

    it('should prioritize snake_case max_tokens over camelCase maxTokens', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hello world' }],
        max_tokens: 5000,
        maxTokens: 3000
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      expect(result.max_tokens).toBe(5000)
    })

    it('should use default maxTokens when not provided', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hello world' }]
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      expect(result.max_tokens).toBe(1024)
    })

    it('should include tools when provided', () => {
      const tools = [
        {
          name: 'get_weather',
          description: 'Get weather information',
          input_schema: {
            type: 'object',
            properties: {
              location: { type: 'string' }
            }
          }
        }
      ]

      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hello world' }],
        tools
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      expect(result.tools).toEqual(tools)
    })

    it('should not include tools when not provided', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hello world' }]
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      expect(result.tools).toBeUndefined()
    })

    it('should deduplicate tool_use blocks with same IDs', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me help with that' },
              { type: 'tool_use', id: 'tool_123', name: 'get_weather', input: { location: 'NYC' } },
              { type: 'tool_use', id: 'tool_123', name: 'get_weather', input: { location: 'NYC' } }, // duplicate
              { type: 'tool_use', id: 'tool_456', name: 'get_time', input: {} }
            ]
          }
        ]
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      expect(result.messages[0].content).toHaveLength(3)
      expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Let me help with that' })
      expect(result.messages[0].content[1]).toEqual({
        type: 'tool_use',
        id: 'tool_123',
        name: 'get_weather',
        input: { location: 'NYC' }
      })
      expect(result.messages[0].content[2]).toEqual({ type: 'tool_use', id: 'tool_456', name: 'get_time', input: {} })
    })

    it('should preserve non-tool_use content blocks', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'First text' },
              { type: 'image', source: { type: 'base64', data: 'abc123' } },
              { type: 'tool_use', id: 'tool_123', name: 'test', input: {} },
              { type: 'text', text: 'Second text' }
            ]
          }
        ]
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      expect(result.messages[0].content).toHaveLength(4)
      expect(result.messages[0].content[0].type).toBe('text')
      expect(result.messages[0].content[1].type).toBe('image')
      expect(result.messages[0].content[2].type).toBe('tool_use')
      expect(result.messages[0].content[3].type).toBe('text')
    })

    it('should handle messages with string content (no deduplication needed)', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Simple string message' }]
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      expect(result.messages[0].content).toBe('Simple string message')
    })

    it('should handle multiple messages with duplicates in different messages', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool_123', name: 'test1', input: {} },
              { type: 'tool_use', id: 'tool_123', name: 'test1', input: {} }
            ]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool_123', content: 'result' }]
          },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool_456', name: 'test2', input: {} },
              { type: 'tool_use', id: 'tool_456', name: 'test2', input: {} }
            ]
          }
        ]
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = transformPayloadForClaude(inputPayload, 'anthropic.claude-3-5-sonnet-20240620-v1:0', 'bedrock') as any

      // First message should have only one tool_use (duplicate removed)
      expect(result.messages[0].content).toHaveLength(1)
      expect(result.messages[0].content[0].id).toBe('tool_123')

      // Second message is unchanged
      expect(result.messages[1].content).toHaveLength(1)

      // Third message should have only one tool_use (duplicate removed)
      expect(result.messages[2].content).toHaveLength(1)
      expect(result.messages[2].content[0].id).toBe('tool_456')
    })
  })
})

describe('createClaudeFetchFn (Bedrock V2 wire format)', () => {
  // HUIT's Bedrock gateway moved from V1 (a non-standard { body, modelId, ... } envelope
  // POSTed to a bare URL) to V2 (the native Bedrock body POSTed to /model/{id}/invoke).
  // These tests pin that wire contract. The model id is colon-free on purpose, so the URL
  // assertion does not depend on how the colon in dated ids (e.g. ...-v1:0) gets escaped.
  const V2_BASE_URL = 'https://bedrock.example.com/v2'
  const API_KEY = 'test-bedrock-key'
  const MODEL_ID = 'us.anthropic.claude-sonnet-4-6'

  // Stash the real values once; each test swaps in known values and afterEach restores them.
  const originalFetch = globalThis.fetch
  const originalBaseUrl = config.llms.bedrock.baseUrl
  const originalKey = config.llms.bedrock.key

  let capturedUrl: string | undefined
  let capturedInit: { body: string; headers: Record<string, string> } | undefined

  beforeEach(() => {
    config.llms.bedrock.baseUrl = V2_BASE_URL
    config.llms.bedrock.key = API_KEY
    capturedUrl = undefined
    capturedInit = undefined

    globalThis.fetch = ((url: string, init: { body: string; headers: Record<string, string> }) => {
      capturedUrl = url
      capturedInit = init
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        text: async () => '{}'
      })
    }) as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    config.llms.bedrock.baseUrl = originalBaseUrl
    config.llms.bedrock.key = originalKey
  })

  const callFetchFn = () => {
    const fetchFn = createClaudeFetchFn(MODEL_ID, 'bedrock')
    return fetchFn('https://ignored-by-v2.example', {
      body: JSON.stringify({
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hello world' }],
        max_tokens: 100
      })
    })
  }

  it('POSTs to the V2 /model/{modelId}/invoke endpoint', async () => {
    await callFetchFn()
    expect(capturedUrl).toBe(`${V2_BASE_URL}/model/${MODEL_ID}/invoke`)
  })

  it('sends the native Claude body without the V1 envelope', async () => {
    await callFetchFn()
    const sentBody = JSON.parse(capturedInit!.body)

    // Native Bedrock fields sit at the top level of the request.
    expect(sentBody.anthropic_version).toBe('bedrock-2023-05-31')
    expect(sentBody.max_tokens).toBe(100)
    expect(Array.isArray(sentBody.messages)).toBe(true)

    // The V1 wrapper keys are gone.
    expect(sentBody).not.toHaveProperty('body')
    expect(sentBody).not.toHaveProperty('modelId')
    expect(sentBody).not.toHaveProperty('accept')
    expect(sentBody).not.toHaveProperty('contentType')
  })

  it('keeps the x-api-key auth header from config', async () => {
    await callFetchFn()
    expect(capturedInit!.headers['x-api-key']).toBe(API_KEY)
  })

  it('refuses an unsafe model id before calling fetch', async () => {
    const fetchFn = createClaudeFetchFn('evil/../path', 'bedrock')
    await expect(
      fetchFn('https://ignored-by-v2.example', {
        body: JSON.stringify({
          system: 'You are a helpful assistant',
          messages: [{ role: 'user', content: 'Hello world' }],
          max_tokens: 100
        })
      })
    ).rejects.toThrow()
    expect(capturedUrl).toBeUndefined()
  })
})

describe('buildBedrockInvokeUrl', () => {
  const BASE = 'https://bedrock.example.com/v2'

  it('builds the /model/{modelId}/invoke path', () => {
    expect(buildBedrockInvokeUrl(BASE, 'us.anthropic.claude-sonnet-4-6')).toBe(
      `${BASE}/model/us.anthropic.claude-sonnet-4-6/invoke`
    )
  })

  it('keeps the raw colon in dated model ids', () => {
    expect(buildBedrockInvokeUrl(BASE, 'us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      `${BASE}/model/us.anthropic.claude-haiku-4-5-20251001-v1:0/invoke`
    )
  })

  it('strips a trailing slash from the base url so the path has no double slash', () => {
    expect(buildBedrockInvokeUrl(`${BASE}/`, 'us.anthropic.claude-sonnet-4-6')).toBe(
      `${BASE}/model/us.anthropic.claude-sonnet-4-6/invoke`
    )
  })

  it('rejects model ids that contain URL-structural characters', () => {
    expect(() => buildBedrockInvokeUrl(BASE, 'foo/bar')).toThrow()
    expect(() => buildBedrockInvokeUrl(BASE, 'foo?x=1')).toThrow()
    expect(() => buildBedrockInvokeUrl(BASE, 'foo#frag')).toThrow()
    expect(() => buildBedrockInvokeUrl(BASE, 'foo%2e')).toThrow()
    expect(() => buildBedrockInvokeUrl(BASE, 'has space')).toThrow()
    expect(() => buildBedrockInvokeUrl(BASE, '')).toThrow()
  })
})
