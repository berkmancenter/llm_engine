import { BedrockChat } from '@langchain/community/chat_models/bedrock'
import { AIMessage } from '@langchain/core/messages'
import { getBedrockChat, BedrockChatWithUsage } from '../../../src/agents/helpers/getModelChat.js'

/* bedrockUsage.test.ts proves attachUsageMetadata/normalizeBedrockModelName are
   correct in isolation. This file proves they are actually wired in: that
   getBedrockChat returns a BedrockChatWithUsage, and that its overridden
   _generate/getLsParams call through to those helpers on top of whatever the
   real BedrockChat implementation returns. Spies on BedrockChat.prototype so no
   network call happens — construction alone never talks to Bedrock. */

describe('getBedrockChat wiring', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('returns a BedrockChatWithUsage instance (not the bare BedrockChat)', async () => {
    const chat = await getBedrockChat('us.anthropic.claude-haiku-4-5-20251001-v1:0', {})

    expect(chat).toBeInstanceOf(BedrockChatWithUsage)
    expect(chat).toBeInstanceOf(BedrockChat)
  })

  it('_generate attaches usage_metadata from the underlying BedrockChat response', async () => {
    const message = new AIMessage('hello')
    jest.spyOn(BedrockChat.prototype, '_generate').mockResolvedValue({
      generations: [{ text: 'hello', message, generationInfo: { usage: { input_tokens: 104, output_tokens: 45 } } }]
    } as never)

    const chat = await getBedrockChat('us.anthropic.claude-haiku-4-5-20251001-v1:0', {})
    const result = await chat._generate([], {} as never, undefined as never)

    expect((result.generations[0].message as AIMessage).usage_metadata).toEqual({
      input_tokens: 104,
      output_tokens: 45,
      total_tokens: 149
    })
  })

  it('getLsParams normalizes ls_model_name from the underlying BedrockChat params', async () => {
    jest.spyOn(BedrockChat.prototype, 'getLsParams').mockReturnValue({
      ls_provider: 'bedrock',
      ls_model_name: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      ls_model_type: 'chat'
    } as never)

    const chat = await getBedrockChat('us.anthropic.claude-haiku-4-5-20251001-v1:0', {})
    const params = chat.getLsParams({} as never)

    expect(params.ls_model_name).toBe('claude-haiku-4-5-20251001')
    expect(params.ls_provider).toBe('bedrock')
  })
})
