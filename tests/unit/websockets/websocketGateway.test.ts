import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import websocketGateway from '../../../src/websockets/websocketGateway.js'

/* Joining a topic room takes no authorization, so these mirror the redaction findByIdFull
   applies to non-owners. */
describe('websocketGateway conversation broadcasts', () => {
  const secrets = {
    _id: 'conv-1',
    topic: { _id: 'topic-1' },
    name: 'Community room',
    channels: [{ name: 'main', passcode: 'super-secret-passcode' }],
    agents: [{ name: 'assistant', agentConfig: { botName: 'CustomBot', apiKey: 'sk-live-abc123' } }],
    adapters: [{ type: 'zoom', config: { meetingUrl: 'https://zoom.us/j/1', token: 'zoom-token' } }]
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let broadcastSpy: any

  beforeEach(() => {
    broadcastSpy = jest.spyOn(websocketGateway, 'broadcast').mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const payloadOf = () => broadcastSpy.mock.calls[0][2]

  describe.each([
    ['conversation:new', (c) => websocketGateway.broadcastNewConversation(c)],
    ['conversation:update', (c) => websocketGateway.broadcastConversationUpdate(c)]
  ])('%s', (eventName, broadcastConversation) => {
    test('should strip channel passcodes, agent config, and adapter config', async () => {
      await broadcastConversation({ ...secrets })

      expect(broadcastSpy).toHaveBeenCalledWith('topic-1', eventName, expect.anything())
      const payload = payloadOf()
      expect(payload.channels[0]).not.toHaveProperty('passcode')
      expect(payload.agents[0].agentConfig).not.toHaveProperty('apiKey')
      expect(payload.adapters[0]).not.toHaveProperty('config')
    })

    test('should keep the fields a client needs to render the conversation', async () => {
      await broadcastConversation({ ...secrets })

      const payload = payloadOf()
      expect(payload.name).toEqual('Community room')
      expect(payload.channels[0].name).toEqual('main')
      expect(payload.agents[0].agentConfig).toEqual({ botName: 'CustomBot' })
    })

    test('should redact a mongoose document the same way', async () => {
      await broadcastConversation({ ...secrets, toJSON: () => ({ ...secrets }) })

      const payload = payloadOf()
      expect(payload.channels[0]).not.toHaveProperty('passcode')
      expect(payload.agents[0].agentConfig).not.toHaveProperty('apiKey')
      expect(payload.adapters[0]).not.toHaveProperty('config')
    })

    // updateConversation populates only the topic, so these three paths arrive as ObjectIds.
    test('should leave unpopulated ObjectId references intact', async () => {
      const channelId = new mongoose.Types.ObjectId()
      const agentId = new mongoose.Types.ObjectId()
      const adapterId = new mongoose.Types.ObjectId()

      await broadcastConversation({ ...secrets, channels: [channelId], agents: [agentId], adapters: [adapterId] })

      const payload = payloadOf()
      expect(JSON.parse(JSON.stringify(payload.channels))).toEqual([channelId.toString()])
      expect(JSON.parse(JSON.stringify(payload.agents))).toEqual([agentId.toString()])
      expect(JSON.parse(JSON.stringify(payload.adapters))).toEqual([adapterId.toString()])
    })

    test('should not broadcast a conversation that has no topic', async () => {
      await broadcastConversation({ ...secrets, topic: null })

      expect(broadcastSpy).not.toHaveBeenCalled()
    })
  })
})
