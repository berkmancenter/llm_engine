import faker from 'faker'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { Message, Conversation, Channel } from '../../src/models/index.js'
import { registeredUser, insertUsers } from '../fixtures/user.fixture.js'
import { publicTopic, conversationAgentsEnabled } from '../fixtures/conversation.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import Adapter, { setAdapterTypes } from '../../src/models/adapter.model.js'
import defaultAdapterTypes from '../../src/adapters/index.js'
import { Direction } from '../../src/types/index.types.js'

const mockSend = jest.fn()
const mockReceive = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockGetChannels = jest.fn()
const mockparticipantJoined = jest.fn()
const mockGetUniqueKeys = jest.fn()

const testAdapterTypes = {
  slack: {
    sendMessage: mockSend,
    receiveMessage: mockReceive,
    start: mockStart,
    stop: mockStop,
    getChannels: mockGetChannels,
    participantJoined: mockparticipantJoined,
    getUniqueKeys: mockGetUniqueKeys
  },
  zoom: {
    sendMessage: mockSend,
    receiveMessage: mockReceive,
    start: mockStart,
    stop: mockStop,
    getChannels: mockGetChannels,
    participantJoined: mockparticipantJoined,
    getUniqueKeys: mockGetUniqueKeys
  }
}

setupIntTest()

let conversation
describe('adapter tests', () => {
  beforeAll(async () => {
    setAdapterTypes(testAdapterTypes)
  })
  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])

    conversation = new Conversation(conversationAgentsEnabled)
    await conversation.save()
  })
  afterAll(() => {
    setAdapterTypes(defaultAdapterTypes)
  })
  afterEach(async () => {
    jest.clearAllMocks()
  })

  test('should not allow creating an adapter with an invalid type', async () => {
    const adapter = new Adapter({
      type: 'fake',
      conversation
    })
    await expect(adapter.save()).rejects.toThrow()
  })

  test('should start an adapter', async () => {
    const adapter = new Adapter({
      type: 'zoom',
      conversation
    })
    await adapter.save()
    await adapter.start()
    expect(mockStart).toHaveBeenCalled()
  })

  test('should call receiveMessage on adapter type if incoming channel', async () => {
    const adapter = new Adapter({
      type: 'slack',
      conversation
    })
    await Channel.create({ name: 'achannel' })
    await adapter.save()
    await adapter.start()
    const externalMsg = { text: 'Something', user: 'foo' }
    mockGetChannels.mockResolvedValue([{ name: 'achannel', direction: Direction.INCOMING }])
    const mockedMsgs = [{ message: 'Something' }]
    mockReceive.mockResolvedValue(mockedMsgs)
    const msgs = await adapter.receiveMessage(externalMsg)
    expect(mockReceive).toHaveBeenCalledWith(externalMsg)
    expect(msgs).toBe(mockedMsgs)
  })

  test('should call receiveMessage on adapter type if both channel', async () => {
    const adapter = new Adapter({
      type: 'slack',
      conversation
    })
    await Channel.create({ name: 'achannel' })
    await adapter.save()
    await adapter.start()
    const externalMsg = { text: 'Something', user: 'foo' }
    mockGetChannels.mockResolvedValue([{ name: 'achannel', direction: Direction.BOTH }])
    await adapter.receiveMessage(externalMsg)
    expect(mockReceive).toHaveBeenCalledWith(externalMsg)
  })

  test('should not call receiveMessage on inactive adapter type', async () => {
    const adapter = new Adapter({
      type: 'slack',
      conversation
    })
    await adapter.save()
    const externalMsg = { text: 'Something', user: 'foo' }
    await adapter.receiveMessage(externalMsg)
    expect(mockReceive).not.toHaveBeenCalled()
  })

  test('should not call receiveMessage on adapter type if no channels', async () => {
    const adapter = new Adapter({
      type: 'slack',
      conversation
    })
    await adapter.save()
    await adapter.start()
    const externalMsg = { text: 'Something', user: 'foo' }
    mockGetChannels.mockResolvedValue([])
    await adapter.receiveMessage(externalMsg)
    expect(mockReceive).not.toHaveBeenCalled()
  })

  test('should call sendMessage on adapter type with outgoing channel', async () => {
    const msg1 = new Message({
      _id: new mongoose.Types.ObjectId(),
      body: faker.lorem.words(10),
      conversation: conversationAgentsEnabled._id,
      owner: registeredUser._id,
      pseudonymId: registeredUser.pseudonyms[0]._id,
      pseudonym: registeredUser.pseudonyms[0].pseudonym,
      channels: ['achannel']
    })
    const adapter = new Adapter({
      type: 'slack',
      conversation
    })
    adapter.chatChannels = [{ name: 'achannel', direction: Direction.OUTGOING, config: { foo: 'bar' } }]
    await adapter.save()
    await adapter.start()
    await adapter.sendMessage(msg1)
    expect(mockSend).toHaveBeenCalledWith(msg1, { foo: 'bar' })
  })

  test('should not call sendMessage on adapter type if inactive', async () => {
    const msg1 = new Message({
      _id: new mongoose.Types.ObjectId(),
      body: faker.lorem.words(10),
      conversation: conversationAgentsEnabled._id,
      owner: registeredUser._id,
      pseudonymId: registeredUser.pseudonyms[0]._id,
      pseudonym: registeredUser.pseudonyms[0].pseudonym
    })
    const adapter = new Adapter({
      type: 'slack',
      conversation
    })
    adapter.chatChannels = [{ name: 'achannel', direction: Direction.OUTGOING }]
    await adapter.save()
    await adapter.sendMessage(msg1)
    expect(mockSend).not.toHaveBeenCalled()
  })

  test('should call participantJoined on adapter type', async () => {
    const adapter = new Adapter({
      type: 'slack',
      conversation
    })
    await adapter.save()
    await adapter.start()
    conversation.enableDMs = ['agents']
    await conversation.save()
    const participant = { id: 'participant1', name: 'Participant 1' }
    const mockUser = { username: 'Participant 1' }
    mockparticipantJoined.mockResolvedValue(mockUser)
    const adapterUser = await adapter.participantJoined(participant)
    expect(mockparticipantJoined).toHaveBeenCalledWith(participant)
    expect(adapterUser).toBe(mockUser)
  })

  test('should not call participantJoined on adapter type if inactive', async () => {
    const adapter = new Adapter({
      type: 'slack',
      conversation
    })
    await adapter.save()
    const mockKeys = ['type', 'config.channel', 'config.workspace']
    mockGetUniqueKeys.mockReturnValue(mockKeys)
    const keys = Adapter.getUniqueKeys('slack')
    expect(keys).toBe(mockKeys)
  })

  test('should not call participantJoined on adapter type if DMs disabled', async () => {
    const adapter = new Adapter({
      type: 'slack',
      conversation
    })
    await adapter.save()
    await adapter.start()
    const participant = { id: 'participant1', name: 'Participant 1' }
    const mockUser = { username: 'Participant 1' }
    mockparticipantJoined.mockResolvedValue(mockUser)
    await adapter.participantJoined(participant)
    expect(mockparticipantJoined).not.toHaveBeenCalled()
  })

  test('should call getUniqueKeys on adapter type', async () => {
    const adapter = new Adapter({
      type: 'slack',
      conversation
    })
    await adapter.save()
    await adapter.start()
    const participant = { id: 'participant1', name: 'Participant 1' }
    const mockUser = { username: 'Participant 1' }
    mockparticipantJoined.mockResolvedValue(mockUser)
    await adapter.participantJoined(participant)
    expect(mockparticipantJoined).not.toHaveBeenCalled()
  })
})
