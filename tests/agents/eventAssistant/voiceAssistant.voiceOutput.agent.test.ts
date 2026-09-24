import { jest } from '@jest/globals'
import path from 'path'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'

// A minimal no-op tool — forces the tools path in answerQuestion so onChunk is
// wired through streamAgentAndReportChunks. No external API required.
const fakeTool = tool(async () => 'The event discusses part-time work and flexible employment.', {
  name: 'event_lookup',
  description: 'Look up information about the current event',
  schema: z.object({ query: z.string().describe('What to look up') })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetTools = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([fakeTool])

const registryModulePath = path.resolve(process.cwd(), 'src/agents/tools/registry.ts')
jest.unstable_mockModule(registryModulePath, () => ({
  getTools: mockGetTools,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildToolsGuidance: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(''),
  registerTool: jest.fn(),
  registerToolPrompt: jest.fn(),
  listRegisteredTools: jest.fn().mockReturnValue([])
}))

// All imports that transitively load the registry must be dynamic so they pick up the mock
const { default: setupAgentTest } = await import('../../utils/setupAgentTest.js')
const { createPublicTopic, createUser, loadPartTimeWorkTranscript, createMessage, createConversation } = await import(
  '../../utils/agentTestHelpers.js'
)
const { Agent, Channel } = await import('../../../src/models/index.js')
const { default: defaultAgentTypes } = await import('../../../src/agents/index.js')
const { default: websocketGateway } = await import('../../../src/websockets/websocketGateway.js')

jest.setTimeout(180000)

const testConfig = setupAgentTest('voiceAssistant')
const testTimeout = 120000

async function createVoiceAssistantConversation(conversationObj, owner, topic, startTime, llmPlatform?, llmModel?) {
  const conversation = await createConversation(conversationObj, owner, topic, startTime)
  const agent = new Agent({ agentType: 'voiceAssistant', conversation, llmPlatform, llmModel })
  const channels = await Channel.create([{ name: 'transcript' }, { name: 'chat' }])
  conversation.channels.push(...channels)
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  await agent.start()
  return conversation
}

describe('voice assistant voice output mode', () => {
  let agent
  let conversation
  let topic
  let user1

  const startTime = new Date(Date.now() - 15 * 60 * 1000)

  beforeEach(async () => {
    mockGetTools.mockClear()
    user1 = await createUser('Boring Badger')
    topic = await createPublicTopic()
    conversation = await createVoiceAssistantConversation(
      {
        name: 'Why your company should consider part-time work',
        description: `"No one wants to work anymore." Entrepreneur Jessica Drain believes otherwise.`,
        presenters: [{ name: 'Jessica Drain', bio: 'A career marketer and graphic designer.' }],
        moderators: [{ name: 'Joe Moderator', bio: 'An experienced event moderator.' }]
      },
      user1,
      topic,
      startTime,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    agent.agentConfig.voiceOutput = true
    // Force the tools path so onChunk is wired through streamAgentAndReportChunks
    agent.agentConfig.tools = ['event_lookup']
    await loadPartTimeWorkTranscript(conversation, true)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it(
    'streams chunks via broadcastMessageChunk and sends a done marker',
    async () => {
      const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
      const msg = await createMessage(`hey ${agent.agentConfig.botName} what is this talk about?`, user1, conversation, [
        'transcript'
      ])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }

      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)

      // In voice output mode the agent returns [] — no message is saved or broadcast to chat
      expect(responses).toHaveLength(0)

      const { calls } = broadcastSpy.mock
      expect(calls.length).toBeGreaterThan(1)

      // All chunk calls should target the transcript channel
      calls.forEach((call) => expect(call[1]).toEqual(['transcript']))

      // Last call should be the done marker
      const lastCall = calls[calls.length - 1]
      expect(lastCall[2]).toMatchObject({ text: '', done: true })

      // All other calls should be non-done chunks
      calls.slice(0, -1).forEach((call) => expect(call[2].done).toBe(false))
    },
    testTimeout
  )

  it(
    'still broadcasts the answer as a single chunk when no tools are configured (no onChunk streaming)',
    async () => {
      const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
      // The no-tools branch in answerQuestion never calls onChunk — it resolves the full
      // answer in one shot. Without the respond()-level fallback, this used to mean the
      // answer was silently dropped: never streamed, never persisted, client only ever saw
      // an empty done:true marker.
      agent.agentConfig.tools = []
      const msg = await createMessage(`hey ${agent.agentConfig.botName} what is this talk about?`, user1, conversation, [
        'transcript'
      ])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }

      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)

      expect(responses).toHaveLength(0)
      expect(mockGetTools).not.toHaveBeenCalled()

      const { calls } = broadcastSpy.mock
      // At least one fallback chunk with real text, plus the trailing done marker.
      expect(calls.length).toBeGreaterThanOrEqual(2)

      const lastCall = calls[calls.length - 1]
      expect(lastCall[2]).toMatchObject({ text: '', done: true })

      const fallbackChunks = calls.slice(0, -1)
      expect(fallbackChunks.length).toBeGreaterThan(0)
      fallbackChunks.forEach((call) => {
        expect(call[2].done).toBe(false)
        expect(typeof call[2].text).toBe('string')
        expect(call[2].text.length).toBeGreaterThan(0)
      })
    },
    testTimeout
  )

  it('still sends the done marker if answerQuestion throws', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
    // Fail before any chunk could possibly stream (tools are resolved before the LLM is
    // ever called) — the strictest version of "answerQuestion threw partway through".
    mockGetTools.mockRejectedValueOnce(new Error('simulated tool-lookup failure'))

    const msg = await createMessage(`hey ${agent.agentConfig.botName} what is this talk about?`, user1, conversation, [
      'transcript'
    ])
    agent.conversationHistorySettings = {
      endTime: new Date(startTime.getTime() + 313 * 1000),
      count: 10,
      channels: ['transcript']
    }

    await expect(defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)).rejects.toThrow(
      'simulated tool-lookup failure'
    )

    // The done marker must still have gone out despite the throw, so a client that received
    // earlier done:false chunks for this requestId isn't left waiting on a stream that never
    // ends.
    const { calls } = broadcastSpy.mock
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const lastCall = calls[calls.length - 1]
    expect(lastCall[2]).toMatchObject({ text: '', done: true })
  })

  it('returns [] and does not broadcast when transcript channel is missing', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
    agent.agentConfig.botName = 'Berkie'
    agent.conversation.channels = agent.conversation.channels.filter((c) => c.name !== 'transcript')

    const msg = await createMessage('hey Berkie what is this talk about?', user1, conversation, ['transcript'])
    const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)

    expect(responses).toHaveLength(0)
    expect(broadcastSpy).not.toHaveBeenCalled()
  })

  it(
    'includes a requestId in every chunk and marks the final chunk done',
    async () => {
      const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockResolvedValue()
      const msg = await createMessage(`hey ${agent.agentConfig.botName} what is part-time work?`, user1, conversation, [
        'transcript'
      ])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }

      await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)

      const { calls } = broadcastSpy.mock
      expect(calls.length).toBeGreaterThan(0)

      const { requestId } = calls[0][2]
      expect(typeof requestId).toBe('string')
      calls.forEach((call) => expect(call[2].requestId).toBe(requestId))

      const lastCall = calls[calls.length - 1]
      expect(lastCall[2]).toMatchObject({ done: true, text: '' })
    },
    testTimeout
  )
})
