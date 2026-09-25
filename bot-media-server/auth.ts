export interface AuthTokens {
  access: { token: string; expires: string }
  refresh: { token: string; expires: string }
}

/**
 * Node's fetch() collapses a network-level failure (connection refused, DNS failure, ...)
 * down to a generic `TypeError: fetch failed` — the actually useful detail (e.g.
 * ECONNREFUSED) is nested in `err.cause`, and often two levels deep in `err.cause.errors`
 * when a host resolves to more than one address (localhost -> ::1 and 127.0.0.1). Surface
 * that instead of just "fetch failed".
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as Error & { cause?: unknown }).cause as (Error & { code?: string; errors?: Error[] }) | undefined
  if (!cause) return err.message
  const detail = cause.errors?.[0]?.message || cause.message
  const code = cause.code ? ` (${cause.code})` : ''
  return detail ? `${err.message}${code}: ${detail}` : `${err.message}${code}`
}

// Refresh this long before the access token's real (server-reported) expiry, so a slow
// request or clock skew never lets it actually lapse. Clamped to a minimum so an unusually
// short-lived token (a non-default JWT_ACCESS_EXPIRATION_MINUTES) still schedules sanely.
export const TOKEN_REFRESH_SAFETY_MARGIN_MS = 5 * 60_000
export const TOKEN_REFRESH_MIN_DELAY_MS = 5_000
// If a refresh attempt itself fails (llm_engine restart, network blip), retry sooner than
// waiting for a full token lifetime.
export const TOKEN_REFRESH_RETRY_DELAY_MS = 30_000

export interface AuthManagerConfig {
  llmEngineUrl: string
  username: string
  password: string
  onLog?: (message: string) => void
  onWarn?: (message: string) => void
  onError?: (message: string) => void
}

export interface AuthManager {
  /** Full username/password login. Throws on failure — the caller decides whether that's
   *  fatal (it is, at startup) or not. */
  login(): Promise<void>
  getAccessToken(): string
  /**
   * Refreshes the shared access token — via the refresh token first (no password resent),
   * falling back to a full login only if the refresh token itself was rejected (expired, or
   * already consumed by a concurrent refresh). Never throws: a failure here just leaves the
   * previous token in place and retries shortly, so one bad tick can't take down every other
   * conversation this process is handling. Concurrent calls share one in-flight attempt.
   */
  refreshAccessToken(): Promise<void>
  /** Clears the pending refresh timer. For tests, and for a clean process shutdown. */
  stop(): void
}

/**
 * Creates an auth manager that owns a single shared access/refresh token pair and keeps the
 * access token proactively refreshed, scheduled off the real expires timestamp the server
 * returns rather than a guessed or hardcoded lifetime.
 */
export function createAuthManager(config: AuthManagerConfig): AuthManager {
  const log = config.onLog ?? (() => {})
  const warn = config.onWarn ?? (() => {})
  const error = config.onError ?? (() => {})

  let authToken: string
  let refreshTokenValue: string
  let accessTokenExpiresAt: number
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  // Dedupes concurrent refresh attempts — e.g. an llm_engine restart can make every active
  // conversation's socket reconnect within the same moment, and refresh tokens are single-use
  // (rotating), so two simultaneous refreshes with the same token would have the second one
  // rejected. All concurrent callers share one in-flight attempt instead.
  let pendingRefresh: Promise<void> | null = null

  async function requestLogin(): Promise<AuthTokens> {
    const res = await fetch(`${config.llmEngineUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: config.username, password: config.password })
    })
    if (!res.ok) throw new Error(`login failed: ${res.status}`)
    const data = (await res.json()) as { tokens: AuthTokens }
    return data.tokens
  }

  async function requestRefresh(): Promise<AuthTokens> {
    const res = await fetch(`${config.llmEngineUrl}/auth/refresh-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshTokenValue })
    })
    if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
    return (await res.json()) as AuthTokens
  }

  // scheduleTokenRefresh and applyTokens take the refresh callback as a parameter rather than
  // closing over the name `refreshAccessToken` directly — otherwise refreshAccessToken ->
  // applyTokens -> scheduleTokenRefresh -> refreshAccessToken is a genuine cycle, and no
  // ordering of plain function declarations satisfies no-use-before-define (whichever one is
  // declared last is still called by an earlier one). With the callback threaded through as
  // a parameter, only refreshAccessToken (and login) ever mention it by name, and only as a
  // self-reference — always allowed — leaving a clean top-down declaration order.
  function scheduleTokenRefresh(refresh: () => Promise<void>) {
    if (refreshTimer) clearTimeout(refreshTimer)
    const delay = Math.max(accessTokenExpiresAt - Date.now() - TOKEN_REFRESH_SAFETY_MARGIN_MS, TOKEN_REFRESH_MIN_DELAY_MS)
    refreshTimer = setTimeout(() => {
      refresh().catch(() => {})
    }, delay)
  }

  function applyTokens(tokens: AuthTokens, refresh: () => Promise<void>) {
    authToken = tokens.access.token
    refreshTokenValue = tokens.refresh.token
    accessTokenExpiresAt = new Date(tokens.access.expires).getTime()
    scheduleTokenRefresh(refresh)
  }

  async function refreshAccessToken(): Promise<void> {
    if (pendingRefresh) return pendingRefresh
    pendingRefresh = (async () => {
      try {
        applyTokens(await requestRefresh(), refreshAccessToken)
        log('access token refreshed')
        return
      } catch (err) {
        warn(`token refresh failed, falling back to full login: ${describeError(err)}`)
      }
      try {
        applyTokens(await requestLogin(), refreshAccessToken)
        log('re-authenticated via full login')
      } catch (err) {
        error(`re-authentication failed, will retry: ${describeError(err)}`)
        refreshTimer = setTimeout(() => {
          refreshAccessToken().catch(() => {})
        }, TOKEN_REFRESH_RETRY_DELAY_MS)
      }
    })()
    try {
      await pendingRefresh
    } finally {
      pendingRefresh = null
    }
  }

  return {
    async login() {
      applyTokens(await requestLogin(), refreshAccessToken)
    },
    getAccessToken() {
      return authToken
    },
    refreshAccessToken,
    stop() {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = null
    }
  }
}
