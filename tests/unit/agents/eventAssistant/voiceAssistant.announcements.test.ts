import { jest } from '@jest/globals'

/* The "no announcement match" path still falls through to answerQuestion (the real LLM call),
   so it's mocked here — this suite is specifically about proving the announcement branch
   bypasses it entirely. Live-LLM coverage of the normal Q&A path itself lives in
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
const { default: announcementSchema } = await import('../../../../src/models/schemas/announcement.schema.js')

function fakeAnnouncement(name: string, body: string) {
  return { name, body, segments: () => announcementSchema.methods.segments.call({ body }) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildContext({ voiceOutput = false, channels = [] as any[], announcements = [] as any[] } = {}) {
  return {
    agentConfig: { botName: 'Berkie', voiceOutput },
    conversation: { _id: 'conv-1', channels, announcements }
  }
}

const transcriptChannel = { name: 'transcript' }
const chatChannel = { name: 'chat' }

function msg(body: string) {
  return { body, bodyType: 'text', channels: ['transcript'], pseudonym: 'Casey' }
}

describe('voiceAssistant.respond — announcements', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('reads a matched announcement via streamed chunks when voiceOutput is on, without calling the LLM', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
    const kudos = fakeAnnouncement('kudos', 'Jane did great.\n\nBob did great too.')
    const context = buildContext({ voiceOutput: true, channels: [transcriptChannel], announcements: [kudos] })

    const responses = await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie read the kudos'))

    expect(responses).toEqual([])
    expect(mockAnswerQuestion).not.toHaveBeenCalled()
    expect(broadcastSpy).toHaveBeenCalledTimes(3) // 2 segments + done marker
    expect(broadcastSpy).toHaveBeenNthCalledWith(1, 'conv-1', ['transcript'], {
      requestId: 'conv-1',
      text: 'Jane did great.',
      done: false
    })
    expect(broadcastSpy).toHaveBeenNthCalledWith(2, 'conv-1', ['transcript'], {
      requestId: 'conv-1',
      text: 'Bob did great too.',
      done: false
    })
    expect(broadcastSpy).toHaveBeenNthCalledWith(3, 'conv-1', ['transcript'], {
      requestId: 'conv-1',
      text: '',
      done: true
    })
  })

  it('returns no responses and skips entirely when voiceOutput is on but there is no transcript channel', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
    const kudos = fakeAnnouncement('kudos', 'Jane did great.')
    const context = buildContext({ voiceOutput: true, channels: [], announcements: [kudos] })

    const responses = await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie read the kudos'))

    expect(responses).toEqual([])
    expect(mockAnswerQuestion).not.toHaveBeenCalled()
    expect(broadcastSpy).not.toHaveBeenCalled()
  })

  it('posts the raw, unsegmented announcement body to chat when voiceOutput is off, without calling the LLM', async () => {
    const kudos = fakeAnnouncement('kudos', 'Jane did great.\n\nBob did great too.')
    const context = buildContext({ voiceOutput: false, channels: [chatChannel], announcements: [kudos] })

    const responses = await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie read the kudos'))

    expect(mockAnswerQuestion).not.toHaveBeenCalled()
    expect(responses).toHaveLength(1)
    expect(responses[0].visible).toBe(true)
    expect(responses[0].messageType).toBe('json')
    expect(responses[0].channels).toEqual([chatChannel])
    expect(responses[0].message).toEqual({
      text: 'Jane did great.\n\nBob did great too.',
      source: 'voice',
      sourceMessage: 'Read the kudos',
      sourcePseudonym: 'Casey'
    })
  })

  it('falls through to the normal LLM answer path when no announcement name matches', async () => {
    mockAnswerQuestion.mockResolvedValue([
      { visible: true, message: { text: 'Lunch is at noon.' }, messageType: 'json', channels: [] }
    ])
    const kudos = fakeAnnouncement('kudos', 'Jane did great.')
    const context = buildContext({ voiceOutput: false, channels: [chatChannel], announcements: [kudos] })

    const responses = await voiceAssistant.respond.call(context, { messages: [] }, msg('hey Berkie what time is lunch'))

    expect(mockAnswerQuestion).toHaveBeenCalledTimes(1)
    expect(responses[0].message.text).toBe('Lunch is at noon.')
  })
})
