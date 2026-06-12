import setupIntTest from '../utils/setupIntTest.js'
import Conversation from '../../src/models/conversation.model.js'
import Agent, { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import agentService from '../../src/services/agent.service/index.js'
import breakoutService, {
  breakoutChatChannelName,
  breakoutTranscriptChannelName
} from '../../src/services/breakout.service.js'
import { insertUsers, registeredUser } from '../fixtures/user.fixture.js'
import { publicTopic, conversationAgentsEnabled } from '../fixtures/conversation.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import defaultAgentTypes from '../../src/agents/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'
import schedule from '../../src/jobs/schedule.js'
import defineJob from '../../src/jobs/define.js'

const mockRespond = jest.fn()
const mockEvaluate = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()

const testAgentTypes = {
  perMessage: {
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Test Per Message',
    description: 'Responds to every message on chat channel',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { channels: ['chat'] } },
    priority: 10,
    llmTemplateVars: {},
    defaultLLMTemplates: { template: 'Default' },
    defaultLLMPlatform,
    defaultLLMModel,
    agentConfig: { botName: 'TestBot' }
  },
  perMessageWithDMs: {
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Test Per Message With DMs',
    description: 'Responds to chat and DMs',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { channels: ['chat'], directMessages: true } },
    priority: 10,
    llmTemplateVars: {},
    defaultLLMTemplates: { template: 'Default' },
    defaultLLMPlatform,
    defaultLLMModel
  },
  periodicTranscript: {
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Test Periodic Transcript',
    description: 'Runs periodically on transcript',
    maxTokens: 2000,
    defaultTriggers: {
      perMessage: { channels: ['chat'] },
      periodic: { timerPeriod: 60, conversationHistorySettings: { channels: ['transcript'], timeWindow: 60 } }
    },
    priority: 10,
    llmTemplateVars: {},
    defaultLLMTemplates: { template: 'Default' },
    defaultLLMPlatform,
    defaultLLMModel
  },
  noChannels: {
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Test No Channels',
    description: 'No explicit channel config',
    maxTokens: 2000,
    defaultTriggers: { perMessage: {} },
    priority: 10,
    llmTemplateVars: {},
    defaultLLMTemplates: { template: 'Default' },
    defaultLLMPlatform,
    defaultLLMModel
  },
  mainAgent: {
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Main Agent',
    description: 'Main session agent',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { channels: ['chat'] } },
    priority: 10,
    llmTemplateVars: {},
    defaultLLMTemplates: { template: 'Default' },
    defaultLLMPlatform,
    defaultLLMModel
  }
}

setupIntTest()

describe('breakout service', () => {
  let conversation

  beforeAll(() => {
    setAgentTypes(testAgentTypes)
  })

  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])
    jest.spyOn(schedule, 'periodicAgent').mockResolvedValue(undefined)
    jest.spyOn(schedule, 'cancelPeriodicAgent').mockResolvedValue(undefined)
    jest.spyOn(schedule, 'agentResponse').mockResolvedValue(undefined)
    jest.spyOn(defineJob, 'periodicAgent').mockResolvedValue(undefined)
    jest.spyOn(defineJob, 'agentResponse').mockResolvedValue(undefined)

    conversation = new Conversation({
      ...conversationAgentsEnabled,
      enableBreakouts: true,
      properties: { breakoutAgentTypes: ['perMessage'] }
    })
    await conversation.save()
    await conversation.populate('channels')
  })

  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('openBreakoutRoom', () => {
    const parentChatChannels = ['chat']
    const parentTranscriptChannels = ['transcript']

    test('creates transcript and chat channels with breakout marker', async () => {
      const { roundId, transcriptChannel, chatChannel } = await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        name: 'Room 1',
        parentChatChannels,
        parentTranscriptChannels
      })

      expect(transcriptChannel).toBe(breakoutTranscriptChannelName(roundId, 'room-1'))
      expect(chatChannel).toBe(breakoutChatChannelName(roundId, 'room-1'))

      await conversation.populate('channels')
      const transcriptChan = conversation.channels.find((c) => c.name === transcriptChannel)
      const chatChan = conversation.channels.find((c) => c.name === chatChannel)

      expect(transcriptChan?.breakout).toMatchObject({ roomId: 'room-1', roundId, name: 'Room 1', active: true })
      expect(chatChan?.breakout).toMatchObject({ roomId: 'room-1', roundId, name: 'Room 1', active: true })
    })

    test('second room in same call joins existing round', async () => {
      const { roundId: roundId1 } = await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels,
        parentTranscriptChannels
      })
      await conversation.populate('channels')
      const { roundId: roundId2 } = await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-2',
        parentChatChannels,
        parentTranscriptChannels
      })

      expect(roundId2).toBe(roundId1)
    })

    test('spawns agent inherited from parent agent', async () => {
      const parentAgent = await agentService.createAgent('perMessage', conversation, {
        agentConfig: { botName: 'CustomBot' },
        llmModel: 'custom-model',
        conversationHistorySettings: { channels: ['chat', 'transcript'] }
      })
      parentAgent.active = true
      await parentAgent.save()
      conversation.agents.push(parentAgent)
      await conversation.save()
      await conversation.populate('agents')

      const { chatChannel, transcriptChannel, roundId } = await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels,
        parentTranscriptChannels
      })

      await conversation.populate('agents')
      const roomAgent = conversation.agents.find(
        (a) => a.agentType === 'perMessage' && a._id.toString() !== parentAgent._id.toString()
      )

      expect(roomAgent).toBeDefined()
      expect(roomAgent.agentConfig.botName).toBe('CustomBot')
      expect(roomAgent.llmModel).toBe('custom-model')
      expect(roomAgent.triggers.perMessage.channels).toEqual([chatChannel])
      expect(roomAgent.conversationHistorySettings.channels).toEqual(
        expect.arrayContaining(['chat', 'transcript', chatChannel, transcriptChannel])
      )
      expect(roomAgent.conversationHistorySettings.channels).toHaveLength(4)
      // roundId is accessible via channel name
      expect(chatChannel).toContain(roundId)
    })

    test('maps chat channel in perMessage trigger to breakout chat channel', async () => {
      const parentAgent = await agentService.createAgent('perMessage', conversation)
      parentAgent.active = true
      await parentAgent.save()
      conversation.agents.push(parentAgent)
      await conversation.save()
      await conversation.populate('agents')

      const { chatChannel } = await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels,
        parentTranscriptChannels
      })

      await conversation.populate('agents')
      const roomAgent = conversation.agents.find(
        (a) => a.agentType === 'perMessage' && a._id.toString() !== parentAgent._id.toString()
      )

      expect(roomAgent.triggers.perMessage.channels).toEqual([chatChannel])
      expect(roomAgent.triggers.perMessage.channels).not.toContain('chat')
    })

    test('preserves non-chat/transcript channels in perMessage trigger', async () => {
      conversation.properties = { breakoutAgentTypes: ['perMessageWithDMs'] }
      await conversation.save()

      const parentAgent = await agentService.createAgent('perMessageWithDMs', conversation, {
        triggers: { perMessage: { channels: ['chat', 'some-other-channel'], directMessages: true } }
      })
      parentAgent.active = true
      await parentAgent.save()
      conversation.agents.push(parentAgent)
      await conversation.save()
      await conversation.populate('agents')

      const { chatChannel } = await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels,
        parentTranscriptChannels
      })

      await conversation.populate('agents')
      const roomAgent = conversation.agents.find(
        (a) => a.agentType === 'perMessageWithDMs' && a._id.toString() !== parentAgent._id.toString()
      )

      expect(roomAgent.triggers.perMessage.channels).toContain(chatChannel)
      expect(roomAgent.triggers.perMessage.channels).toContain('some-other-channel')
      expect(roomAgent.triggers.perMessage.directMessages).toBe(true)
    })

    test('maps transcript channel in periodic trigger conversationHistorySettings', async () => {
      conversation.properties = { breakoutAgentTypes: ['periodicTranscript'] }
      await conversation.save()

      // Create parent without overriding triggers so it gets full defaultTriggers (perMessage + periodic)
      const parentAgent = await agentService.createAgent('periodicTranscript', conversation)
      parentAgent.active = true
      await parentAgent.save()
      conversation.agents.push(parentAgent)
      await conversation.save()
      await conversation.populate('agents')

      // Confirm parent has periodic triggers from defaults
      expect(parentAgent.triggers?.periodic).toBeDefined()

      const { transcriptChannel } = await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels,
        parentTranscriptChannels
      })

      await conversation.populate('agents')
      const roomAgent = conversation.agents.find(
        (a) => a.agentType === 'periodicTranscript' && a._id.toString() !== parentAgent._id.toString()
      )

      expect(roomAgent.triggers.periodic).toBeDefined()
      expect(roomAgent.triggers.periodic.conversationHistorySettings.channels).toContain(transcriptChannel)
      expect(roomAgent.triggers.periodic.conversationHistorySettings.channels).not.toContain('transcript')
      expect(roomAgent.triggers.periodic.conversationHistorySettings.timeWindow).toBe(60)
    })

    test('preserves empty channels in perMessage trigger (triggers on all channels)', async () => {
      conversation.properties = { breakoutAgentTypes: ['noChannels'] }
      await conversation.save()

      const parentAgent = await agentService.createAgent('noChannels', conversation)
      parentAgent.active = true
      await parentAgent.save()
      conversation.agents.push(parentAgent)
      await conversation.save()
      await conversation.populate('agents')

      await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels,
        parentTranscriptChannels
      })

      await conversation.populate('agents')
      const roomAgent = conversation.agents.find(
        (a) => a.agentType === 'noChannels' && a._id.toString() !== parentAgent._id.toString()
      )

      // No channels means triggers on all — channels should be absent or empty
      expect(roomAgent.triggers?.perMessage?.channels ?? []).toEqual([])
    })

    test('spawns agent from type defaults when no parent agent exists', async () => {
      const { chatChannel } = await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels,
        parentTranscriptChannels
      })

      await conversation.populate('agents')
      const roomAgent = conversation.agents.find((a) => a.agentType === 'perMessage')

      expect(roomAgent).toBeDefined()
      expect(roomAgent.triggers.perMessage.channels).toEqual([chatChannel])
    })

    test('does not append breakout channels to history when parent has no explicit channel list', async () => {
      conversation.properties = { breakoutAgentTypes: ['noChannels'] }
      await conversation.save()

      const parentAgent = await agentService.createAgent('noChannels', conversation)
      parentAgent.active = true
      await parentAgent.save()
      conversation.agents.push(parentAgent)
      await conversation.save()
      await conversation.populate('agents')

      await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels,
        parentTranscriptChannels
      })

      await conversation.populate('agents')
      const roomAgent = conversation.agents.find(
        (a) => a.agentType === 'noChannels' && a._id.toString() !== parentAgent._id.toString()
      )

      expect(roomAgent.conversationHistorySettings?.channels).toBeUndefined()
    })

    test('spawns no agents when breakoutAgentTypes is empty', async () => {
      conversation.properties = { breakoutAgentTypes: [] }
      await conversation.save()

      const { agents } = await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels,
        parentTranscriptChannels
      })

      expect(agents).toHaveLength(0)
    })
  })

  describe('closeBreakoutRoom', () => {
    test('marks room channels as inactive', async () => {
      const { roundId } = await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels: ['chat'],
        parentTranscriptChannels: ['transcript']
      })
      await conversation.populate('channels')

      await breakoutService.closeBreakoutRoom(conversation, { roomId: 'room-1' })
      await conversation.populate('channels')

      const breakoutChannels = conversation.channels.filter((c) => c.breakout?.roundId === roundId)
      expect(breakoutChannels.length).toBeGreaterThan(0)
      expect(breakoutChannels.every((c) => c.breakout.active === false)).toBe(true)
    })

    test('stops room agents', async () => {
      const parentAgent = await agentService.createAgent('perMessage', conversation)
      parentAgent.active = true
      await parentAgent.save()
      conversation.agents.push(parentAgent)
      await conversation.save()
      await conversation.populate('agents')

      await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels: ['chat'],
        parentTranscriptChannels: ['transcript']
      })
      await conversation.populate('agents')

      await breakoutService.closeBreakoutRoom(conversation, { roomId: 'room-1' })
      await conversation.populate('agents')

      const roomAgent = conversation.agents.find(
        (a) => a.agentType === 'perMessage' && a._id.toString() !== parentAgent._id.toString()
      )
      expect(roomAgent.active).toBe(false)
    })

    test('does not stop parent (main session) agents', async () => {
      const parentAgent = await agentService.createAgent('perMessage', conversation)
      parentAgent.active = true
      await parentAgent.save()
      conversation.agents.push(parentAgent)
      await conversation.save()
      await conversation.populate('agents')

      await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels: ['chat'],
        parentTranscriptChannels: ['transcript']
      })
      await conversation.populate('agents')

      await breakoutService.closeBreakoutRoom(conversation, { roomId: 'room-1' })

      const reloaded = await Agent.findById(parentAgent._id)
      expect(reloaded!.active).toBe(true)
    })
  })

  describe('reconvene', () => {
    test('sets includeBreakouts on main session agents', async () => {
      const mainAgent = await agentService.createAgent('mainAgent', conversation)
      mainAgent.active = true
      await mainAgent.save()
      conversation.agents.push(mainAgent)
      await conversation.save()
      await conversation.populate('agents')

      await breakoutService.reconvene(conversation)

      const reloaded = await Agent.findById(mainAgent._id)
      expect(reloaded!.conversationHistorySettings?.includeBreakouts).toBe(true)
    })

    test('does not set includeBreakouts on room agents', async () => {
      const parentAgent = await agentService.createAgent('perMessage', conversation)
      parentAgent.active = true
      await parentAgent.save()
      conversation.agents.push(parentAgent)
      await conversation.save()
      await conversation.populate('agents')

      const { chatChannel } = await breakoutService.openBreakoutRoom(conversation, {
        roomId: 'room-1',
        parentChatChannels: ['chat'],
        parentTranscriptChannels: ['transcript']
      })
      await conversation.populate('agents')

      await breakoutService.reconvene(conversation)

      await conversation.populate('agents')
      const roomAgent = conversation.agents.find(
        (a) => a.agentType === 'perMessage' && a.triggers?.perMessage?.channels?.includes(chatChannel)
      )
      expect(roomAgent.conversationHistorySettings?.includeBreakouts).toBeFalsy()
    })

    test('preserves existing conversationHistorySettings on reconvene', async () => {
      const mainAgent = await agentService.createAgent('mainAgent', conversation, {
        conversationHistorySettings: { channels: ['chat'], timeWindow: 120 }
      })
      mainAgent.active = true
      await mainAgent.save()
      conversation.agents.push(mainAgent)
      await conversation.save()
      await conversation.populate('agents')

      await breakoutService.reconvene(conversation)

      const reloaded = await Agent.findById(mainAgent._id)
      expect(reloaded!.conversationHistorySettings?.channels).toEqual(['chat'])
      expect(reloaded!.conversationHistorySettings?.timeWindow).toBe(120)
      expect(reloaded!.conversationHistorySettings?.includeBreakouts).toBe(true)
    })
  })
})
