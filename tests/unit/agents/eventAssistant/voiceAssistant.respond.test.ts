import { jest } from '@jest/globals'

/* respond() falls through to answerQuestion (the real LLM call) once a question is extracted,
   so it's mocked here. Live-LLM coverage of the normal Q&A path itself lives in
   tests/agents/eventAssistant/voiceAssistant.agent.test.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAnswerQuestion = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/eventAssistant/eventQuestionHandler.js', () => ({
  eventAssistantLLMTemplates: {},
  eventAssistantLlmTemplateVars: {},
  answerQuestion: mockAnswerQuestion
}))

const { default: voiceAssistant } = await import('../../../../src/agents/eventAssistant/voiceAssistant.js')
const { default: websocketGateway } = await import('../../../../src/websockets/websocketGateway.js')

const chatChannel = { name: 'chat' }
const transcriptChannel = { name: 'transcript' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildContext({ voiceOutput = false, channels = [chatChannel] as any[] } = {}) {
  return {
    _id: 'agent-1',
    agentConfig: { botName: 'Berkie', voiceOutput },
    conversation: { _id: 'conv-1', channels, announcements: [] }
  }
}

function msg(body: string) {
  return { body, bodyType: 'text', channels: ['transcript'], pseudonym: 'Casey' }
}

describe('voiceAssistant.respond — agent:responding broadcast', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('broadcasts agent:responding once a real question is extracted, before producing the response', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastAgentResponding').mockResolvedValue()
    mockAnswerQuestion.mockResolvedValue([])
    const context = buildContext()

    await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie what time is lunch'))

    expect(broadcastSpy).toHaveBeenCalledWith('conv-1', 'agent-1')
  })

  it('does not broadcast when the message has no voice trigger at all', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastAgentResponding').mockResolvedValue()
    const context = buildContext()

    const responses = await voiceAssistant.respond.call(
      context,
      { messages: [] },
      msg('just chatting, not addressing the bot')
    )

    expect(responses).toEqual([])
    expect(mockAnswerQuestion).not.toHaveBeenCalled()
    expect(broadcastSpy).not.toHaveBeenCalled()
  })
})

describe('voiceAssistant.respond — voice output also posts to chat', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('posts the answer to chat in addition to streaming it, once answerQuestion resolves', async () => {
    jest.spyOn(websocketGateway, 'broadcastAgentResponding').mockResolvedValue()
    const chunkSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
    mockAnswerQuestion.mockResolvedValue([
      { visible: true, message: { text: 'Lunch is at noon.' }, messageType: 'json', channels: [] }
    ])
    const context = buildContext({ voiceOutput: true, channels: [transcriptChannel, chatChannel] })

    const responses = await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie what time is lunch'))

    // Still streamed on the transcript channel for TTS...
    expect(chunkSpy).toHaveBeenCalled()
    // ...but now also posted to chat, same as the non-voice path.
    expect(responses).toHaveLength(1)
    expect(responses[0].channels).toEqual([chatChannel])
    expect(responses[0].message.text).toBe('Lunch is at noon.')
    expect(responses[0].message.source).toBe('voice')
  })

  it('strips Markdown from the text sent to the transcript channel, but leaves the chat message intact', async () => {
    jest.spyOn(websocketGateway, 'broadcastAgentResponding').mockResolvedValue()
    const chunkSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
    mockAnswerQuestion.mockResolvedValue([
      { visible: true, message: { text: '**Lunch** is at *noon*.' }, messageType: 'json', channels: [] }
    ])
    const context = buildContext({ voiceOutput: true, channels: [transcriptChannel, chatChannel] })

    const responses = await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie what time is lunch'))

    const fallbackChunkCall = chunkSpy.mock.calls.find((call) => call[2].text)
    expect(fallbackChunkCall?.[2].text).toBe('Lunch is at noon.')
    // Chat clients render Markdown normally, so the posted message keeps it as-is.
    expect(responses[0].message.text).toBe('**Lunch** is at *noon*.')
  })

  it('does not post to chat when there is no chat channel, but still streams', async () => {
    jest.spyOn(websocketGateway, 'broadcastAgentResponding').mockResolvedValue()
    const chunkSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
    mockAnswerQuestion.mockResolvedValue([
      { visible: true, message: { text: 'Lunch is at noon.' }, messageType: 'json', channels: [] }
    ])
    const context = buildContext({ voiceOutput: true, channels: [transcriptChannel] })

    const responses = await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie what time is lunch'))

    expect(chunkSpy).toHaveBeenCalled()
    expect(responses).toEqual([])
  })
})
