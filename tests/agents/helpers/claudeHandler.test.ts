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

    it('should return false for GPT models', () => {
      expect(shouldUseClaudeFormat('gpt-4', 'bedrock')).toBe(true) // platform takes precedence
      expect(shouldUseClaudeFormat('gpt-4o-mini', 'openai')).toBe(false)
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
  })

  describe('transformPayloadForClaude', () => {
    it('should transform standard payload to Claude format', () => {
      const inputPayload = {
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hello world' }],
        maxTokens: 2048,
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

      const result = transformPayloadForClaude(inputPayload, 'gpt-4o-mini', 'openai')

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
  })
})
