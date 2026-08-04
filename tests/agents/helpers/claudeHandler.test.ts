import {
  shouldUseClaudeFormat,
  buildBedrockClaudePayload,
  transformPayloadForClaude
} from '../../../src/agents/helpers/claudeHandler.js'

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
        messages: [{ role: 'user', content: 'Hello world' }]
      })
    })

    it('should use default values', () => {
      const result = buildBedrockClaudePayload({
        systemPrompt: 'You are a helpful assistant',
        userMessages: [{ role: 'User', content: 'Hello world' }]
      })

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
