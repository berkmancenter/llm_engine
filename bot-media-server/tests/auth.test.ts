import { jest } from '@jest/globals'
import { createAuthManager, describeError } from '../auth.js'

const makeLoginBody = (accessToken: string, refreshToken: string, accessExpiresInMs = 30 * 60_000) => ({
  tokens: {
    access: { token: accessToken, expires: new Date(Date.now() + accessExpiresInMs).toISOString() },
    refresh: { token: refreshToken, expires: new Date(Date.now() + 30 * 24 * 3600_000).toISOString() }
  }
})

const makeRefreshBody = (accessToken: string, refreshToken: string, accessExpiresInMs = 30 * 60_000) => ({
  access: { token: accessToken, expires: new Date(Date.now() + accessExpiresInMs).toISOString() },
  refresh: { token: refreshToken, expires: new Date(Date.now() + 30 * 24 * 3600_000).toISOString() }
})

describe('auth', () => {
  const llmEngineUrl = 'http://llm-engine.test/v1'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchMock: jest.Mock<(...args: any[]) => Promise<any>>

  beforeEach(() => {
    fetchMock = jest.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = fetchMock as any
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('login() applies tokens on success', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => makeLoginBody('access-1', 'refresh-1') })
    const auth = createAuthManager({ llmEngineUrl, username: 'u', password: 'p' })
    await auth.login()
    expect(auth.getAccessToken()).toBe('access-1')
    auth.stop()
  })

  test('login() throws on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
    const auth = createAuthManager({ llmEngineUrl, username: 'u', password: 'p' })
    await expect(auth.login()).rejects.toThrow('login failed: 401')
  })

  test('refreshAccessToken() uses the refresh token (not the password) and picks up the rotated one', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => makeLoginBody('access-1', 'refresh-1') })
      .mockResolvedValueOnce({ ok: true, json: async () => makeRefreshBody('access-2', 'refresh-2') })
      .mockResolvedValueOnce({ ok: true, json: async () => makeRefreshBody('access-3', 'refresh-3') })

    const auth = createAuthManager({ llmEngineUrl, username: 'u', password: 'p' })
    await auth.login()

    await auth.refreshAccessToken()
    expect(auth.getAccessToken()).toBe('access-2')
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${llmEngineUrl}/auth/refresh-tokens`,
      expect.objectContaining({ body: JSON.stringify({ refreshToken: 'refresh-1' }) })
    )

    await auth.refreshAccessToken()
    expect(auth.getAccessToken()).toBe('access-3')
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `${llmEngineUrl}/auth/refresh-tokens`,
      expect.objectContaining({ body: JSON.stringify({ refreshToken: 'refresh-2' }) })
    )
    auth.stop()
  })

  test('refreshAccessToken() falls back to a full login when the refresh token is rejected', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => makeLoginBody('access-1', 'refresh-1') })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => makeLoginBody('access-2', 'refresh-2') })

    const auth = createAuthManager({ llmEngineUrl, username: 'u', password: 'p' })
    await auth.login()
    await auth.refreshAccessToken()
    expect(auth.getAccessToken()).toBe('access-2')
    auth.stop()
  })

  test('refreshAccessToken() never throws, even when both refresh and the fallback login fail', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => makeLoginBody('access-1', 'refresh-1') })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })

    const auth = createAuthManager({ llmEngineUrl, username: 'u', password: 'p' })
    await auth.login()
    await expect(auth.refreshAccessToken()).resolves.toBeUndefined()
    expect(auth.getAccessToken()).toBe('access-1') // unchanged — old token stays in place
    auth.stop()
  })

  test('concurrent refreshAccessToken() calls share one in-flight attempt', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveRefresh: (value: any) => void
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => makeLoginBody('access-1', 'refresh-1') })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve
          })
      )

    const auth = createAuthManager({ llmEngineUrl, username: 'u', password: 'p' })
    await auth.login()

    const p1 = auth.refreshAccessToken()
    const p2 = auth.refreshAccessToken()
    resolveRefresh!({ ok: true, json: async () => makeRefreshBody('access-2', 'refresh-2') })
    await Promise.all([p1, p2])

    const refreshCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('refresh-tokens'))
    expect(refreshCalls).toHaveLength(1)
    expect(auth.getAccessToken()).toBe('access-2')
    auth.stop()
  })

  test('schedules a proactive refresh ahead of the real expiry, and it fires automatically', async () => {
    jest.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => makeLoginBody('access-1', 'refresh-1', 8_000) })
      .mockResolvedValueOnce({ ok: true, json: async () => makeRefreshBody('access-2', 'refresh-2') })

    const auth = createAuthManager({ llmEngineUrl, username: 'u', password: 'p' })
    await auth.login()
    expect(auth.getAccessToken()).toBe('access-1')

    // 8s expiry with a 5-minute safety margin clamps to the 5s minimum delay
    await jest.advanceTimersByTimeAsync(5_000)
    expect(auth.getAccessToken()).toBe('access-2')
    auth.stop()
  })

  test('stop() prevents the scheduled refresh from firing', async () => {
    jest.useFakeTimers()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => makeLoginBody('access-1', 'refresh-1', 8_000) })

    const auth = createAuthManager({ llmEngineUrl, username: 'u', password: 'p' })
    await auth.login()
    auth.stop()

    await jest.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the initial login — no scheduled refresh fired
  })

  describe('describeError', () => {
    test('returns the plain message when there is no cause', () => {
      expect(describeError(new Error('boom'))).toBe('boom')
    })

    test('unwraps a single-level cause', () => {
      const err = new Error('fetch failed')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(err as any).cause = new Error('DNS lookup failed')
      expect(describeError(err)).toBe('fetch failed: DNS lookup failed')
    })

    test('unwraps a code and a nested AggregateError-style cause', () => {
      const err = new Error('fetch failed')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cause: any = new Error('')
      cause.code = 'ECONNREFUSED'
      cause.errors = [new Error('connect ECONNREFUSED 127.0.0.1:3000')]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(err as any).cause = cause
      expect(describeError(err)).toBe('fetch failed (ECONNREFUSED): connect ECONNREFUSED 127.0.0.1:3000')
    })

    test('returns String(err) for a non-Error throw', () => {
      expect(describeError('just a string')).toBe('just a string')
    })
  })
})
