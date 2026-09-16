import { jest } from '@jest/globals'
import setupIntTest from '../../utils/setupIntTest.js'
import logger from '../../../src/config/logger.js'
import registerConversationHandlers from '../../../src/websockets/handlers/conversationHandlers.js'
import { Channel, Conversation } from '../../../src/models/index.js'
import { insertUsers, userOne } from '../../fixtures/user.fixture.js'
import { newPublicTopic, insertTopics } from '../../fixtures/topic.fixture.js'

setupIntTest()

const registerWithFakeSocket = () => {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const socket = {
    join: jest.fn(),
    use: jest.fn(),
    disconnect: jest.fn(),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler
    }
  }
  registerConversationHandlers({}, socket)
  return handlers
}

// catchAsync swallows a failed join into logger.error and never calls back, so surface it instead of timing out
const joinAndWaitForCallback = (handler, data) =>
  new Promise((resolve, reject) => {
    jest.spyOn(logger, 'error').mockImplementation((err) => {
      reject(err instanceof Error ? err : new Error(String(err)))
      return logger
    })
    handler(data, resolve)
  })

describe('conversation:join logging', () => {
  let infoSpy
  let conversation
  let channel
  let user

  beforeEach(async () => {
    await insertUsers([userOne])
    const topic = newPublicTopic()
    await insertTopics([topic])
    user = { _id: userOne._id, email: userOne.email }
    conversation = await Conversation.create({
      name: 'Join timing room',
      owner: userOne._id,
      topic: topic._id,
      enableDMs: [],
      enableAgents: false
    })
    channel = await Channel.create({ name: 'general', conversation: conversation._id })
    conversation.channels = [channel._id]
    await conversation.save()
    infoSpy = jest.spyOn(logger, 'info').mockReturnValue(logger)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const joinLines = () => infoSpy.mock.calls.map((call) => String(call[0])).filter((m) => m.startsWith('Socket join:'))

  it('logs one info line naming the user, the room, and the elapsed time', async () => {
    const handlers = registerWithFakeSocket()

    await joinAndWaitForCallback(handlers['conversation:join'], { conversationId: conversation._id, user })

    const lines = joinLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`user ${userOne._id}`)
    expect(lines[0]).toContain(`room ${conversation._id}`)
    expect(lines[0]).toMatch(/ in \d+ms$/)
  })

  it('logs one info line for a channel join', async () => {
    const handlers = registerWithFakeSocket()

    await joinAndWaitForCallback(handlers['channel:join'], {
      conversationId: conversation._id,
      user,
      channel: { name: channel.name, passcode: channel.passcode }
    })

    const lines = joinLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`room ${conversation._id}_general`)
    expect(lines[0]).toMatch(/ in \d+ms$/)
  })
})
