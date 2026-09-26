import http from 'http'
import type { AddressInfo } from 'net'
import { Server as SocketIOServer, Socket as ServerSocket } from 'socket.io'
import { io as connectSocketIO, Socket as ClientSocket } from 'socket.io-client'
import { startBotMediaApp, BotMediaApp } from '../app.js'
import type { AuthManager } from '../auth.js'
import type { AudioChunk } from '../engineSocket.js'

// Stands in for llm_engine: a real socket.io server the real bot-media-server app connects
// out to, so the whole round trip (message:chunk -> hand-raised/chime -> message:new
// call-upon -> speaking/audio:chunk) is exercised end to end, without a real llm_engine.
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

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs)
    socket.once(event, (payload: T) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

const fakeAuth: AuthManager = {
  async login() {
    // no-op — this test never needs a real login
  },
  getAccessToken: () => 'fake-token',
  async refreshAccessToken() {
    // no-op — no test here exercises the reconnect/refresh path
  },
  stop() {
    // no-op
  }
}

describe('bot-media-server app (integration)', () => {
  let fakeLlmEngine: Awaited<ReturnType<typeof startFakeLlmEngine>>
  let app: BotMediaApp
  let engineConnected: Promise<ServerSocket>
  let browser: ClientSocket

  beforeEach(async () => {
    fakeLlmEngine = await startFakeLlmEngine()
    let resolveEngineConnected: (socket: ServerSocket) => void
    engineConnected = new Promise((resolve) => {
      resolveEngineConnected = resolve
    })
    fakeLlmEngine.io.on('connection', (socket) => {
      socket.on('conversation:join', (_payload, ack) => ack?.({ ok: true }))
      resolveEngineConnected(socket)
    })

    app = await startBotMediaApp({
      llmEngineWsUrl: fakeLlmEngine.url,
      port: 0,
      auth: fakeAuth,
      // Fast, deterministic, and doesn't depend on macOS's `say` — the real say.ts/kokoro.ts
      // are only exercised by their own dedicated tests.
      tts: async (text) => Buffer.from(text)
    })

    const { port } = app.httpServer.address() as AddressInfo
    browser = connectSocketIO(`http://localhost:${port}`, {
      query: { conversationId: 'conv-1', botName: 'TestBot' }
    })
  })

  afterEach(async () => {
    browser.close()
    await app.stop()
    await new Promise<void>((resolve) => fakeLlmEngine.httpServer.close(() => resolve()))
  })

  test('message:chunk raises hand + chimes immediately, then call-upon flushes audio as speaking', async () => {
    const engineSideSocket = await engineConnected

    const chimePromise = waitForEvent(browser, 'audio:chime')
    const handRaisedStatePromise = waitForEvent<{ state: string }>(browser, 'state')

    engineSideSocket.emit('message:chunk', { requestId: 'r1', text: 'Hello there', done: false })

    await chimePromise
    expect((await handRaisedStatePromise).state).toBe('hand-raised')

    engineSideSocket.emit('message:chunk', { requestId: 'r1', text: '', done: true })
    // Lets the (fake, fast) TTS conversion's addAudio() land before calling upon — otherwise
    // callUpon() could flush before any chunk was added.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const speakingStatePromise = waitForEvent<{ state: string }>(browser, 'state')
    const audioChunkPromise = waitForEvent<AudioChunk>(browser, 'audio:chunk')

    engineSideSocket.emit('message:new', { channels: ['transcript'], body: 'go ahead TestBot' })

    expect((await speakingStatePromise).state).toBe('speaking')
    const chunk = await audioChunkPromise
    // The fake tts here isn't a real WAV, so envelope computation falls back to [] — see
    // engineSocket.test.ts's dedicated envelope tests for the real-WAV path.
    expect(chunk.audio).toEqual(Buffer.from('Hello there'))
    expect(chunk.envelope).toEqual([])
  })

  test('GET /health returns 200 ok', async () => {
    const { port } = app.httpServer.address() as AddressInfo
    const res = await fetch(`http://localhost:${port}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  test('a transcript message with no call-upon phrase does not flush the held response', async () => {
    const engineSideSocket = await engineConnected

    const chimePromise = waitForEvent(browser, 'audio:chime')
    engineSideSocket.emit('message:chunk', { requestId: 'r1', text: 'Hello there', done: false })
    await chimePromise

    let sawUnexpectedEvent = false
    browser.once('audio:chunk', () => {
      sawUnexpectedEvent = true
    })

    engineSideSocket.emit('message:new', { channels: ['transcript'], body: 'unrelated remark, nothing to see here' })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(sawUnexpectedEvent).toBe(false)
  })

  test('audio:finished with nothing else queued goes idle', async () => {
    const engineSideSocket = await engineConnected

    const chimePromise = waitForEvent(browser, 'audio:chime')
    engineSideSocket.emit('message:chunk', { requestId: 'r1', text: 'Hello there', done: false })
    await chimePromise
    engineSideSocket.emit('message:chunk', { requestId: 'r1', text: '', done: true })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const speakingStatePromise = waitForEvent<{ state: string }>(browser, 'state')
    engineSideSocket.emit('message:new', { channels: ['transcript'], body: 'go ahead TestBot' })
    expect((await speakingStatePromise).state).toBe('speaking')

    const idleStatePromise = waitForEvent<{ state: string }>(browser, 'state')
    browser.emit('audio:finished')
    expect((await idleStatePromise).state).toBe('idle')
  })
})
