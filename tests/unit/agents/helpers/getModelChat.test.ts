import { getBedrockChat, resolveBedrockModel } from '../../../../src/agents/helpers/getModelChat.js'

describe('getBedrockChat', () => {
  it('turns a model family name into the full Bedrock model ID', async () => {
    const chat = await getBedrockChat('sonnet', {})

    expect(chat.model).toBe('us.anthropic.claude-sonnet-4-6')
  })

  it('keeps a full model ID as given', async () => {
    const chat = await getBedrockChat('us.anthropic.claude-opus-5', {})

    expect(chat.model).toBe('us.anthropic.claude-opus-5')
  })
})

describe('resolveBedrockModel', () => {
  it.each(['sonnet', 'us.anthropic.claude-sonnet-4-6'])('resolves %s to the full Bedrock model ID', (model) => {
    expect(resolveBedrockModel(model)).toBe('us.anthropic.claude-sonnet-4-6')
  })

  it('keeps a Bedrock model ID the supported list does not know', () => {
    expect(resolveBedrockModel('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    )
  })

  it.each(['gpt', 'GPT', 'gemini', 'gpt-5.2-2025-12-11', 'gemini-3-pro-preview'])(
    'refuses %s, which the supported list runs somewhere other than Bedrock',
    (model) => {
      expect(() => resolveBedrockModel(model)).toThrow(model)
    }
  )
})
