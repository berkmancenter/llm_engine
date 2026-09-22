import { AIMessage } from '@langchain/core/messages'
import { attachUsageMetadata, normalizeBedrockModelName } from '../../../src/agents/helpers/bedrockUsage.js'

describe('attachUsageMetadata', () => {
  it('copies the Anthropic usage block onto the message as usage_metadata', () => {
    const message = new AIMessage('hello')
    const result = attachUsageMetadata({
      generations: [{ text: 'hello', message, generationInfo: { usage: { input_tokens: 104, output_tokens: 45 } } }]
    } as never)

    expect((result.generations[0].message as AIMessage).usage_metadata).toEqual({
      input_tokens: 104,
      output_tokens: 45,
      total_tokens: 149
    })
  })

  it('leaves an existing usage_metadata untouched', () => {
    const message = new AIMessage({
      content: 'hello',
      usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
    })
    const result = attachUsageMetadata({
      generations: [{ text: 'hello', message, generationInfo: { usage: { input_tokens: 104, output_tokens: 45 } } }]
    } as never)

    expect((result.generations[0].message as AIMessage).usage_metadata).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3
    })
  })

  it('does nothing when the response carries no usage block', () => {
    const message = new AIMessage('hello')
    const result = attachUsageMetadata({ generations: [{ text: 'hello', message, generationInfo: {} }] } as never)

    expect((result.generations[0].message as AIMessage).usage_metadata).toBeUndefined()
  })

  it('surfaces cache_read_input_tokens onto input_token_details.cache_read', () => {
    const message = new AIMessage('hello')
    const result = attachUsageMetadata({
      generations: [
        {
          text: 'hello',
          message,
          generationInfo: { usage: { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 1200 } }
        }
      ]
    } as never)

    expect((result.generations[0].message as AIMessage).usage_metadata).toEqual({
      input_tokens: 1230,
      output_tokens: 10,
      total_tokens: 1240,
      input_token_details: { cache_read: 1200 }
    })
  })

  it('surfaces cache_creation_input_tokens onto input_token_details.cache_creation', () => {
    const message = new AIMessage('hello')
    const result = attachUsageMetadata({
      generations: [
        {
          text: 'hello',
          message,
          generationInfo: { usage: { input_tokens: 1850, output_tokens: 10, cache_creation_input_tokens: 1850 } }
        }
      ]
    } as never)

    expect((result.generations[0].message as AIMessage).usage_metadata).toEqual({
      input_tokens: 3700,
      output_tokens: 10,
      total_tokens: 3710,
      input_token_details: { cache_creation: 1850 }
    })
  })

  it('omits input_token_details entirely when there is no cache activity', () => {
    const message = new AIMessage('hello')
    const result = attachUsageMetadata({
      generations: [{ text: 'hello', message, generationInfo: { usage: { input_tokens: 104, output_tokens: 45 } } }]
    } as never)

    expect((result.generations[0].message as AIMessage).usage_metadata).toEqual({
      input_tokens: 104,
      output_tokens: 45,
      total_tokens: 149
    })
  })
})

describe('normalizeBedrockModelName', () => {
  it('strips region prefix and version suffix from Bedrock Anthropic ids', () => {
    expect(normalizeBedrockModelName('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claude-haiku-4-5-20251001')
    expect(normalizeBedrockModelName('us.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6')
    expect(normalizeBedrockModelName('anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5-20250929')
  })

  it('passes non-Anthropic ids through unchanged', () => {
    expect(normalizeBedrockModelName('meta.llama3-70b-instruct-v1:0')).toBe('meta.llama3-70b-instruct-v1:0')
    expect(normalizeBedrockModelName('gpt-4o')).toBe('gpt-4o')
  })

  it('handles a multi-digit dated version and a version with no colon suffix', () => {
    expect(normalizeBedrockModelName('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe('claude-3-5-sonnet-20241022')
    expect(normalizeBedrockModelName('anthropic.claude-instant-v1')).toBe('claude-instant')
  })
})
