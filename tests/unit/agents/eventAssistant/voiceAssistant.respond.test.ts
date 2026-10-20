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

function buildContext() {
  return {
    _id: 'agent-1',
    agentConfig: { botName: 'Berkie', voiceOutput: false },
    conversation: { _id: 'conv-1', channels: [chatChannel], announcements: [] }
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
