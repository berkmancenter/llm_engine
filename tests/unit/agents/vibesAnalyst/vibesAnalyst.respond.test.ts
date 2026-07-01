import { jest } from '@jest/globals'

/* Covers the summon entry points on the agent itself: evaluate's mention handling and
   respond's gate. The intent check and the summon handler are mocked so the gate is
   deterministic (the real handler is exercised in summon.test.ts, the real intent check
   in intentChecks tests). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCheckBotIntent = jest.fn<(...args: any[]) => Promise<boolean>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMatchBotMention = jest.fn<(...args: any[]) => boolean>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockNormalizeBotMention = jest.fn<(...args: any[]) => string>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockHandleSummon = jest.fn<(...args: any[]) => Promise<any>>()
// The fast secondary model is resolved through getModelChat; mock it so the model the summon
// handler receives is deterministic and we can prove the parse runs on it, not the main model.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetModelChat = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/intentChecks.js', () => ({
  checkBotIntent: mockCheckBotIntent,
  matchBotMention: mockMatchBotMention,
  normalizeBotMention: mockNormalizeBotMention
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/summon.js', () => ({
  default: mockHandleSummon
}))
jest.unstable_mockModule('../src/agents/helpers/getModelChat.js', () => ({
  getModelChat: mockGetModelChat,
  defaultLLMPlatform: 'bedrock',
  defaultLLMModel: 'test-model',
  classificationLLMPlatform: 'bedrock',
  classificationLLMModel: 'fast-model'
}))

const { default: vibesAnalyst } = await import('../../../../src/agents/vibesAnalyst/index.js')
const { AgentMessageActions } = await import('../../../../src/types/index.types.js')

describe('vibesAnalyst evaluate', () => {
  const context = { agentConfig: { botName: 'Vibes' } }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('normalizes the mention and contributes when the message names the bot', async () => {
    mockMatchBotMention.mockReturnValue(true)
    mockNormalizeBotMention.mockReturnValue('@Vibes recap the town hall')

    const result = await vibesAnalyst.evaluate.call(context, { body: '@vibez recap the town hall', _id: 'm1' })

    expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
    expect(result.userContributionVisible).toBe(true)
    expect(result.userMessage.body).toBe('@Vibes recap the town hall')
  })

  it('contributes the message untouched when it does not name the bot, leaving the decision to respond', async () => {
    mockMatchBotMention.mockReturnValue(false)
    const message = { body: 'just chatting', _id: 'm2' }

    const result = await vibesAnalyst.evaluate.call(context, message)

    expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
    expect(result.userMessage).toBe(message)
    expect(mockNormalizeBotMention).not.toHaveBeenCalled()
  })
})

describe('vibesAnalyst respond', () => {
  const fakeLlm = { fakeLlm: true }
  const fastLlm = { fastLlm: true }

  function buildContext() {
    return {
      agentConfig: { botName: 'Vibes' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLLM: jest.fn<() => Promise<any>>().mockResolvedValue(fakeLlm),
      conversation: { channels: [{ name: 'vibesAnalyst' }] }
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetModelChat.mockResolvedValue(fastLlm)
  })

  it('stays silent when the message is not addressed to it', async () => {
    mockCheckBotIntent.mockResolvedValue(false)

    const responses = await vibesAnalyst.respond.call(buildContext(), undefined, { body: 'hello', _id: 'm1' })

    expect(responses).toEqual([])
    expect(mockHandleSummon).not.toHaveBeenCalled()
  })

  it('hands off to the summon handler when addressed', async () => {
    mockCheckBotIntent.mockResolvedValue(true)
    const summonResult = [{ visible: true, message: 'card' }]
    mockHandleSummon.mockResolvedValue(summonResult)
    const context = buildContext()
    const message = { body: '@Vibes recap town hall', _id: 'm1' }

    const responses = await vibesAnalyst.respond.call(context, undefined, message)

    expect(responses).toBe(summonResult)
    // The main model handles intent and card writing; the faster classification model is passed
    // alongside for the summon's mechanical passes (parsing, annotation).
    expect(mockHandleSummon).toHaveBeenCalledWith(context, message, fakeLlm, fastLlm)
  })

  it('returns empty without checking intent when there is no user message', async () => {
    const responses = await vibesAnalyst.respond.call(buildContext(), undefined, null)

    expect(responses).toEqual([])
    expect(mockCheckBotIntent).not.toHaveBeenCalled()
  })
})
