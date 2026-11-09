import { getBedrockChat } from '../../../../src/agents/helpers/getModelChat.js'

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
