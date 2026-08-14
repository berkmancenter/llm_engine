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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockThreadContinuesFromAgent = jest.fn<(...args: any[]) => Promise<boolean>>()

jest.unstable_mockModule('../src/agents/helpers/intentChecks.js', () => ({
  checkBotIntent: mockCheckBotIntent,
  matchBotMention: mockMatchBotMention,
  normalizeBotMention: mockNormalizeBotMention
}))
// The agent model imports the whole agent registry, which imports this agent back, so loading
// the analyst on its own lands in a half-initialized module. Nothing here touches the model, so
// stubbing it breaks the cycle and lets the suite load.
jest.unstable_mockModule('../src/models/user.model/agent.model/index.js', () => ({
  default: {},
  setAgentTypes: jest.fn()
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/summon.js', () => ({
  default: mockHandleSummon
}))
// Mocking a module replaces every export, so each one another module in the import graph reads
// has to be declared here or the suite fails to load.
jest.unstable_mockModule('../src/agents/helpers/getModelChat.js', () => ({
  getModelChat: mockGetModelChat,
  getOpenAIChat: jest.fn(),
  getGoogleChat: jest.fn(),
  getGoogleImageModel: jest.fn(),
  getVllmChat: jest.fn(),
  getOllamaChat: jest.fn(),
  getPerspectiveChat: jest.fn(),
  getBedrockChat: jest.fn(),
  supportedModels: [],
  llmPlatforms: [],
  defaultLLMPlatform: 'bedrock',
  defaultLLMModel: 'test-model',
  classificationLLMPlatform: 'bedrock',
  classificationLLMModel: 'fast-model',
  coreLLMPlatform: 'bedrock',
  coreLLMModel: 'core-model',
  imageGenerationLLMModel: 'image-model'
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/thread.js', () => ({
  threadContinuesFromAgent: mockThreadContinuesFromAgent
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
      _id: 'agent-1',
      agentConfig: { botName: 'Vibes' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLLM: jest.fn<() => Promise<any>>().mockResolvedValue(fakeLlm),
      conversation: { _id: 'conversation-1', channels: [{ name: 'vibesAnalyst' }] }
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetModelChat.mockResolvedValue(fastLlm)
    mockThreadContinuesFromAgent.mockResolvedValue(false)
  })

  // Why there is no LLM intent check here: it judged one message with no surrounding
  // conversation, and its own prompt lists "What does this do?" as bot-directed, so two people
  // talking to each other pulled the analyst in. Naming it or replying to it is the only way in.
  it('stays silent for a question between two people that never names it', async () => {
    mockMatchBotMention.mockReturnValue(false)
    mockCheckBotIntent.mockResolvedValue(true)

    const responses = await vibesAnalyst.respond.call(buildContext(), undefined, {
      body: 'what does this do?',
      _id: 'm1'
    })

    expect(responses).toEqual([])
    expect(mockHandleSummon).not.toHaveBeenCalled()
    expect(mockCheckBotIntent).not.toHaveBeenCalled()
  })

  it('hands off to the summon handler when the message names it', async () => {
    mockMatchBotMention.mockReturnValue(true)
    const summonResult = [{ visible: true, message: 'card' }]
    mockHandleSummon.mockResolvedValue(summonResult)
    const context = buildContext()
    const message = { body: '@Vibes recap town hall', _id: 'm1' }

    const responses = await vibesAnalyst.respond.call(context, undefined, message)

    expect(responses).toBe(summonResult)
    // The main model writes the card; the faster classification model is passed alongside for
    // the summon's mechanical passes (parsing, annotation).
    expect(mockHandleSummon).toHaveBeenCalledWith(context, message, fakeLlm, fastLlm)
  })

  // A name match settles it alone, so the gate skips the thread lookup rather than running it
  // and discarding the answer. That keeps an addressed message off a database round trip.
  it('does not look up the thread when the message already names it', async () => {
    mockMatchBotMention.mockReturnValue(true)
    mockHandleSummon.mockResolvedValue([])

    await vibesAnalyst.respond.call(buildContext(), undefined, { body: '@Vibes recap town hall', _id: 'm1' })

    expect(mockThreadContinuesFromAgent).not.toHaveBeenCalled()
  })

  it('returns empty without resolving a model when there is no user message', async () => {
    const context = buildContext()

    const responses = await vibesAnalyst.respond.call(context, undefined, null)

    expect(responses).toEqual([])
    expect(context.getLLM).not.toHaveBeenCalled()
  })

  // The gate runs before any model is resolved, so a message that is not addressed to the
  // analyst costs nothing.
  it('resolves no model for a message it stays silent on', async () => {
    mockMatchBotMention.mockReturnValue(false)
    const context = buildContext()

    await vibesAnalyst.respond.call(context, undefined, { body: 'what does this do?', _id: 'm1' })

    expect(context.getLLM).not.toHaveBeenCalled()
    expect(mockGetModelChat).not.toHaveBeenCalled()
  })

  // Answering a disambiguation prompt with a bare event title is the case this covers: repeating
  // the analyst's name there would be unnatural, so the thread itself carries the address.
  it('hands off to the summon handler for a bare threaded reply continuing a thread it just spoke in', async () => {
    mockMatchBotMention.mockReturnValue(false)
    mockThreadContinuesFromAgent.mockResolvedValue(true)
    const summonResult = [{ visible: true, message: 'card' }]
    mockHandleSummon.mockResolvedValue(summonResult)
    const context = buildContext()
    const message = { body: 'Test Fancy Vibes #3', _id: 'm1', parentMessage: 'root-1' }

    const responses = await vibesAnalyst.respond.call(context, undefined, message)

    expect(responses).toBe(summonResult)
    expect(mockThreadContinuesFromAgent).toHaveBeenCalledWith(message, 'conversation-1', 'agent-1')
    expect(mockHandleSummon).toHaveBeenCalledWith(context, message, fakeLlm, fastLlm)
  })

  it('still requires a mention for a threaded reply once someone other than the analyst spoke last', async () => {
    mockMatchBotMention.mockReturnValue(false)
    mockThreadContinuesFromAgent.mockResolvedValue(false)
    const message = { body: 'unrelated aside', _id: 'm1', parentMessage: 'root-1' }

    const responses = await vibesAnalyst.respond.call(buildContext(), undefined, message)

    expect(responses).toEqual([])
    expect(mockHandleSummon).not.toHaveBeenCalled()
  })
})
