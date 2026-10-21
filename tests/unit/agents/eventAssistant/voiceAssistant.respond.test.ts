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

  it('broadcasts agent:responding once a real question is extracted and there is somewhere to stream to', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastAgentResponding').mockResolvedValue()
    mockAnswerQuestion.mockResolvedValue([])
    const context = buildContext({ voiceOutput: true, channels: [transcriptChannel, chatChannel] })

    await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie what time is lunch'))

    expect(broadcastSpy).toHaveBeenCalledWith('conv-1', 'agent-1')
  })

  it('does not broadcast when the message has no voice trigger at all', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastAgentResponding').mockResolvedValue()
    const context = buildContext({ voiceOutput: true, channels: [transcriptChannel, chatChannel] })

    const responses = await voiceAssistant.respond.call(
      context,
      { messages: [] },
      msg('just chatting, not addressing the bot')
    )

    expect(responses).toEqual([])
    expect(mockAnswerQuestion).not.toHaveBeenCalled()
    expect(broadcastSpy).not.toHaveBeenCalled()
  })

  // Broadcasting unconditionally left a bot-media client stuck showing a "thinking" pose and
  // chime for an answer that was never going to stream it any chunks to clear it with — see
  // bot-media-server/engineSocket.ts's THINKING_TIMEOUT_MS and the PR review that flagged this.
  it('does not broadcast when voiceOutput is off, even though the answer still goes to chat', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastAgentResponding').mockResolvedValue()
    mockAnswerQuestion.mockResolvedValue([
      { visible: true, message: { text: 'Lunch is at noon.' }, messageType: 'json', channels: [] }
    ])
    const context = buildContext({ voiceOutput: false, channels: [chatChannel] })

    const responses = await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie what time is lunch'))

    expect(broadcastSpy).not.toHaveBeenCalled()
    expect(responses).toHaveLength(1)
  })

  it('does not broadcast when voiceOutput is on but there is no transcript channel to stream onto', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastAgentResponding').mockResolvedValue()
    mockAnswerQuestion.mockResolvedValue([])
    const context = buildContext({ voiceOutput: true, channels: [chatChannel] })

    const responses = await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie what time is lunch'))

    expect(broadcastSpy).not.toHaveBeenCalled()
    expect(responses).toEqual([])
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

  it('strips tilde and hash as well as asterisks, since Kokoro speaks those literally too', async () => {
    jest.spyOn(websocketGateway, 'broadcastAgentResponding').mockResolvedValue()
    const chunkSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
    mockAnswerQuestion.mockResolvedValue([
      { visible: true, message: { text: '# Agenda\n~~old item~~ new item' }, messageType: 'json', channels: [] }
    ])
    const context = buildContext({ voiceOutput: true, channels: [transcriptChannel, chatChannel] })

    await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie what is the agenda'))

    const fallbackChunkCall = chunkSpy.mock.calls.find((call) => call[2].text)
    expect(fallbackChunkCall?.[2].text).not.toMatch(/[*~#]/)
  })

  it('cleans a Markdown span split across two streamed chunks, with no cross-chunk buffering', async () => {
    jest.spyOn(websocketGateway, 'broadcastAgentResponding').mockResolvedValue()
    const chunkSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAnswerQuestion.mockImplementation(async (_userMessage: any, _history: any, options: any) => {
      // A bold span split mid-word across two separately-streamed chunks — the kind of split
      // that can happen when a sentence boundary falls mid-emphasis (see the PR review
      // discussion). removeMarkdown alone can't strip either half on its own since neither
      // contains a full delimiter pair, so this only works because the stray-symbol strip is
      // unconditional, not reliant on finding a matching pair.
      options.onChunk('This is **bo')
      options.onChunk('ld** text.')
      return [{ visible: true, message: { text: 'This is **bold** text.' }, messageType: 'json', channels: [] }]
    })
    const context = buildContext({ voiceOutput: true, channels: [transcriptChannel, chatChannel] })

    const responses = await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie tell me something'))

    const streamedTexts = chunkSpy.mock.calls.map((call) => call[2].text)
    expect(streamedTexts.some((text) => text.includes('*'))).toBe(false)
    expect(streamedTexts.join('')).toContain('This is bold text.')
    // Chat still keeps the original formatting.
    expect(responses[0].message.text).toBe('This is **bold** text.')
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
