/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals'

/* jest.unstable_mockModule resolves relative paths from tests/setup.ts, hence '../src/...' below. */

/**
 * The master process cannot emit to sockets; it sends `{ conversation, event, message, channels,
 * extraRooms }` to a worker, whose `process.on('message')` handler resolves the rooms and emits.
 * This loads src/websockets/index.ts as a worker (not the primary) and drives that handler.
 */
const emitMultiple = jest.fn()
const io = {
  addConnectionHandlers: jest.fn(),
  emitMultiple,
  io: { engine: { clientsCount: 0 } }
}

jest.unstable_mockModule('node:cluster', () => ({ default: { isPrimary: false, on: jest.fn(), fork: jest.fn() } }))
jest.unstable_mockModule('../src/websockets/socketIO.js', () => ({
  default: { init: jest.fn(), getConnection: () => io }
}))

type Handler = (message: any) => void
let handler: Handler
let onSpy: jest.SpiedFunction<typeof process.on>

beforeAll(async () => {
  onSpy = jest.spyOn(process, 'on')
  await import('../../../src/websockets/index.js')
  const call = onSpy.mock.calls.find((c) => c[0] === 'message')
  handler = call![1] as Handler
})
afterAll(() => {
  onSpy.mockRestore()
})
beforeEach(() => {
  emitMultiple.mockClear()
})

describe('worker IPC handler', () => {
  it('registered a message handler and the connection handlers', () => {
    expect(handler).toBeInstanceOf(Function)
    expect(io.addConnectionHandlers).toHaveBeenCalledTimes(1)
  })

  it('forwards extraRooms next to the channel rooms in a single emit', () => {
    handler({ conversation: 'c1', event: 'message:new', message: { a: 1 }, channels: ['chat'], extraRooms: ['user1'] })
    expect(emitMultiple).toHaveBeenCalledWith(['c1_chat', 'user1'], 'message:new', { a: 1 })
  })

  it('emits to the admin room alone when channels is empty', () => {
    handler({ conversation: 'c1', event: 'message:hidden', message: { m: 1 }, channels: [], extraRooms: ['admin:c1'] })
    expect(emitMultiple).toHaveBeenCalledWith(['admin:c1'], 'message:hidden', { m: 1 })
  })

  it('adds the bare conversation room to channel rooms when asked via extraRooms', () => {
    handler({ conversation: 'c1', event: 'message:hidden', message: {}, channels: ['chat'], extraRooms: ['c1'] })
    expect(emitMultiple).toHaveBeenCalledWith(['c1_chat', 'c1'], 'message:hidden', {})
  })

  it('without extraRooms behaves as before: bare room, or channel rooms', () => {
    handler({ conversation: 'c1', event: 'poll:new', message: {} })
    expect(emitMultiple).toHaveBeenLastCalledWith('c1', 'poll:new', {})
    handler({ conversation: 'c1', event: 'message:new', message: {}, channels: ['a', 'b'] })
    expect(emitMultiple).toHaveBeenLastCalledWith(['c1_a', 'c1_b'], 'message:new', {})
  })

  it('ignores a message without a conversation', () => {
    handler({ event: 'x', message: {} })
    expect(emitMultiple).not.toHaveBeenCalled()
  })
})
