import { jest } from '@jest/globals'
import http from 'http'
import type { AddressInfo } from 'net'
import { Server as SocketIOServer, Socket as ServerSocket } from 'socket.io'
import { createEngineSocket, EngineSocketHooks, AudioChunk } from '../engineSocket.js'
import { ENVELOPE_WINDOW_MS } from '../audioEnvelope.js'
import buildTestWav from './wavTestHelper.js'
import type { AuthManager } from '../auth.js'

// Stands in for llm_engine: a real socket.io server createEngineSocket connects out to, so
// the whole protocol round trip (conversation:join, message:chunk, message:new) is exercised
// against real sockets — no real llm_engine, and no browser-side app.ts wiring involved (see
// app.test.ts for that layer; this file is the engine-side connection in isolation).
function startFakeLlmEngine() {
  return new Promise<{ url: string; io: SocketIOServer; httpServer: http.Server }>((resolve) => {
    const httpServer = http.createServer()
    const io = new SocketIOServer(httpServer, { cors: { origin: '*' } })
    httpServer.listen(0, () => {
      const { port } = httpServer.address() as AddressInfo
      resolve({ url: `ws://localhost:${port}`, io, httpServer })
    })
  })
}

function waitForServerEvent<T = unknown>(socket: ServerSocket, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs)
    socket.once(event, (payload: T) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function makeAuth(getAccessToken: () => string = () => 'token-1') {
  const refreshAccessToken = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const auth: AuthManager = {
    async login() {
      // no-op — this file never exercises a real login
    },
    getAccessToken,
    refreshAccessToken,
    stop() {
      // no-op
    }
  }
  return { auth, refreshAccessToken }
}

function makeHooks(): EngineSocketHooks & {
  onStateChange: jest.Mock<(state: 'idle' | 'hand-raised' | 'speaking') => void>
  onChime: jest.Mock<() => void>
  onAudioChunk: jest.Mock<(chunk: AudioChunk) => void>
} {
  return {
    onStateChange: jest.fn<(state: 'idle' | 'hand-raised' | 'speaking') => void>(),
    onChime: jest.fn<() => void>(),
    onAudioChunk: jest.fn<(chunk: AudioChunk) => void>()
  }
}

const fakeTts = async (text: string) => Buffer.from(text)

describe('engineSocket', () => {
  let fakeLlmEngine: Awaited<ReturnType<typeof startFakeLlmEngine>>
  let engineServerSocketPromise: Promise<ServerSocket>
  let ackJoin = true
  // Tracked so afterEach can always disconnect it, even when a test's own assertions throw
  // partway through — otherwise a stray open connection blocks httpServer.close() below and
  // the whole suite hangs until Jest's hook timeout, rather than failing fast.
  let activeSocket: ReturnType<typeof createEngineSocket>['socket'] | undefined

  // Re-arms the connection listener so the next incoming connection (the initial one, or a
  // later reconnection) resolves engineServerSocketPromise — auto-acking conversation:join
  // unless a test has turned that off.
  function armNextConnection() {
    let resolveConnected: (socket: ServerSocket) => void
    engineServerSocketPromise = new Promise((resolve) => {
      resolveConnected = resolve
    })
    fakeLlmEngine.io.once('connection', (socket) => {
      socket.on('conversation:join', (_payload, ack) => {
        if (ackJoin) ack?.({ ok: true })
      })
      resolveConnected(socket)
    })
  }

  function makeEngineSocket(config: Parameters<typeof createEngineSocket>[0], hooks: EngineSocketHooks) {
    const engineSocket = createEngineSocket(config, hooks)
    activeSocket = engineSocket.socket
    return engineSocket
  }

  beforeEach(async () => {
    fakeLlmEngine = await startFakeLlmEngine()
    ackJoin = true
    activeSocket = undefined
    armNextConnection()
  })

  afterEach(async () => {
    activeSocket?.disconnect()
    activeSocket = undefined
    await new Promise<void>((resolve) => fakeLlmEngine.httpServer.close(() => resolve()))
  })

  test('joins with the auth token and no channels when no transcript passcode is configured', async () => {
    const hooks = makeHooks()
    const { auth } = makeAuth(() => 'token-abc')
    makeEngineSocket(
      { llmEngineWsUrl: fakeLlmEngine.url, conversationId: 'conv-1', botName: 'Bot', auth, tts: fakeTts },
      hooks
    )

    const engineSocket = await engineServerSocketPromise
    const payload = await waitForServerEvent<{ conversationId: string; token: string; channels: unknown[] }>(
      engineSocket,
      'conversation:join'
    )
    expect(payload).toEqual({ conversationId: 'conv-1', token: 'token-abc', channels: [] })
  })

  test('includes the transcript channel with its passcode when configured', async () => {
    const hooks = makeHooks()
    const { auth } = makeAuth()
    makeEngineSocket(
      {
        llmEngineWsUrl: fakeLlmEngine.url,
        conversationId: 'conv-1',
        botName: 'Bot',
        transcriptPasscode: 'secret-pass',
        auth,
        tts: fakeTts
      },
      hooks
    )

    const engineSocket = await engineServerSocketPromise
    const payload = await waitForServerEvent<{ channels: { name: string; passcode?: string }[] }>(
      engineSocket,
      'conversation:join'
    )
    expect(payload.channels).toEqual([{ name: 'transcript', passcode: 'secret-pass' }])
  })

  test('a message chunk announces hand-raised + chime, and a call-upon flushes it as speaking audio', async () => {
    const hooks = makeHooks()
    const { auth } = makeAuth()
    makeEngineSocket(
      { llmEngineWsUrl: fakeLlmEngine.url, conversationId: 'conv-1', botName: 'TestBot', auth, tts: fakeTts },
      hooks
    )

    const engineSocket = await engineServerSocketPromise
    await waitForServerEvent(engineSocket, 'conversation:join')

    engineSocket.emit('message:chunk', { requestId: 'r1', text: 'Hello there', done: false })
    await wait(50)
    expect(hooks.onChime).toHaveBeenCalledTimes(1)
    expect(hooks.onStateChange).toHaveBeenCalledWith('hand-raised')

    engineSocket.emit('message:chunk', { requestId: 'r1', text: '', done: true })
    await wait(20)

    engineSocket.emit('message:new', { channels: ['transcript'], body: 'go ahead TestBot' })
    await wait(20)

    expect(hooks.onStateChange).toHaveBeenCalledWith('speaking')
    // fakeTts's output isn't a real WAV, so envelope computation fails and falls back to []
    // (see the dedicated envelope-computation test below, and audioEnvelope.test.ts, for the
    // real-WAV path).
    expect(hooks.onAudioChunk).toHaveBeenCalledWith({
      audio: Buffer.from('Hello there'),
      envelope: [],
      envelopeWindowMs: ENVELOPE_WINDOW_MS
    })
  })

  test('a chunk with real WAV audio gets a non-empty amplitude envelope', async () => {
    const hooks = makeHooks()
    const { auth } = makeAuth()
    const wavTts = async () => buildTestWav([0, 16384, 32767, 16384, 0, -16384, -32768, -16384])
    makeEngineSocket(
      { llmEngineWsUrl: fakeLlmEngine.url, conversationId: 'conv-1', botName: 'TestBot', auth, tts: wavTts },
      hooks
    )

    const engineSocket = await engineServerSocketPromise
    await waitForServerEvent(engineSocket, 'conversation:join')

    engineSocket.emit('message:chunk', { requestId: 'r1', text: 'Hello there', done: false })
    await wait(50)
    engineSocket.emit('message:chunk', { requestId: 'r1', text: '', done: true })
    engineSocket.emit('message:new', { channels: ['transcript'], body: 'go ahead TestBot' })
    await wait(20)

    expect(hooks.onAudioChunk).toHaveBeenCalledTimes(1)
    const [chunk] = hooks.onAudioChunk.mock.calls[0]
    expect(chunk.envelope.length).toBeGreaterThan(0)
    expect(chunk.envelope[0]).toBeGreaterThan(0)
    expect(chunk.envelopeWindowMs).toBe(ENVELOPE_WINDOW_MS)
  })

  test('message:new on a channel other than transcript is ignored', async () => {
    const hooks = makeHooks()
    const { auth } = makeAuth()
    const { queue } = makeEngineSocket(
      { llmEngineWsUrl: fakeLlmEngine.url, conversationId: 'conv-1', botName: 'TestBot', auth, tts: fakeTts },
      hooks
    )

    const engineSocket = await engineServerSocketPromise
    await waitForServerEvent(engineSocket, 'conversation:join')

    engineSocket.emit('message:chunk', { requestId: 'r1', text: 'Hello there', done: false })
    await wait(50)

    engineSocket.emit('message:new', { channels: ['moderator'], body: 'go ahead TestBot' })
    await wait(50)

    expect(hooks.onAudioChunk).not.toHaveBeenCalled()
    expect(queue.hasPending()).toBe(true)
  })

  test('message:new with nothing pending is a no-op', async () => {
    const hooks = makeHooks()
    const { auth } = makeAuth()
    makeEngineSocket(
      { llmEngineWsUrl: fakeLlmEngine.url, conversationId: 'conv-1', botName: 'TestBot', auth, tts: fakeTts },
      hooks
    )

    const engineSocket = await engineServerSocketPromise
    await waitForServerEvent(engineSocket, 'conversation:join')

    expect(() => engineSocket.emit('message:new', { channels: ['transcript'], body: 'go ahead TestBot' })).not.toThrow()
    await wait(50)

    expect(hooks.onAudioChunk).not.toHaveBeenCalled()
    expect(hooks.onStateChange).not.toHaveBeenCalledWith('speaking')
  })

  test('message:new without a matching call-upon phrase does not flush', async () => {
    const hooks = makeHooks()
    const { auth } = makeAuth()
    const { queue } = makeEngineSocket(
      { llmEngineWsUrl: fakeLlmEngine.url, conversationId: 'conv-1', botName: 'TestBot', auth, tts: fakeTts },
      hooks
    )

    const engineSocket = await engineServerSocketPromise
    await waitForServerEvent(engineSocket, 'conversation:join')

    engineSocket.emit('message:chunk', { requestId: 'r1', text: 'Hello there', done: false })
    await wait(50)

    engineSocket.emit('message:new', { channels: ['transcript'], body: 'just chatting, nothing directed at the bot' })
    await wait(50)

    expect(hooks.onAudioChunk).not.toHaveBeenCalled()
    expect(queue.hasPending()).toBe(true)
  })

  test('a TTS failure for one chunk is logged and does not crash the connection', async () => {
    const hooks = makeHooks()
    const { auth } = makeAuth()
    const onLog = jest.fn<(message: string) => void>()
    const failingTts = async (): Promise<Buffer> => {
      throw new Error('tts boom')
    }
    makeEngineSocket(
      { llmEngineWsUrl: fakeLlmEngine.url, conversationId: 'conv-1', botName: 'TestBot', auth, tts: failingTts, onLog },
      hooks
    )

    const engineSocket = await engineServerSocketPromise
    await waitForServerEvent(engineSocket, 'conversation:join')

    engineSocket.emit('message:chunk', { requestId: 'r1', text: 'Hello there', done: false })
    await wait(50)

    expect(hooks.onChime).toHaveBeenCalledTimes(1) // the hold is announced before conversion even fails
    expect(hooks.onAudioChunk).not.toHaveBeenCalled()
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('TTS error'))
  })

  test('the server disconnecting resets the queue and goes idle', async () => {
    const hooks = makeHooks()
    const { auth } = makeAuth()
    const { queue } = makeEngineSocket(
      { llmEngineWsUrl: fakeLlmEngine.url, conversationId: 'conv-1', botName: 'TestBot', auth, tts: fakeTts },
      hooks
    )

    const engineSocket = await engineServerSocketPromise
    await waitForServerEvent(engineSocket, 'conversation:join')

    engineSocket.emit('message:chunk', { requestId: 'r1', text: 'Hello there', done: false })
    await wait(50)
    expect(hooks.onStateChange).toHaveBeenCalledWith('hand-raised')

    hooks.onStateChange.mockClear()
    engineSocket.disconnect()
    await wait(50)

    expect(hooks.onStateChange).toHaveBeenCalledWith('idle')
    expect(queue.hasPending()).toBe(false)
  })

  test('a reconnection refreshes the access token, then rejoins', async () => {
    const hooks = makeHooks()
    const { auth, refreshAccessToken } = makeAuth()
    const { socket } = makeEngineSocket(
      { llmEngineWsUrl: fakeLlmEngine.url, conversationId: 'conv-1', botName: 'TestBot', auth, tts: fakeTts },
      hooks
    )

    const engineSocket = await engineServerSocketPromise
    await waitForServerEvent(engineSocket, 'conversation:join')

    // 'reconnect' is fired by the Manager (socket.io), not the namespaced Socket — see the
    // comment in engineSocket.ts. Triggering it directly on the real object the code listens
    // on exercises the exact same wiring a genuine reconnection does, deterministically and
    // without waiting out socket.io's real (2s+) reconnection backoff.
    let rejoined = false
    engineSocket.once('conversation:join', (_payload, ack) => {
      rejoined = true
      ack?.({ ok: true })
    })
    // Manager#emit is typed to only accept its own reserved-event names, which excludes
    // 'reconnect' from the public signature — it's normally raised via the internal
    // emitReserved() helper. The underlying Emitter is untyped at runtime, so this still
    // triggers the real listener.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(socket.io as any).emit('reconnect', 1)
    await wait(20)

    expect(refreshAccessToken).toHaveBeenCalled()
    expect(rejoined).toBe(true)
  })
})
