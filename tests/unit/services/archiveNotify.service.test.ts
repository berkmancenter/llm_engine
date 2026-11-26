import { jest } from '@jest/globals'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapterLean = jest.fn<() => Promise<any>>()
const adapterQuery = { select: () => adapterQuery, lean: adapterLean }
const findById = jest.fn(() => adapterQuery)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const postMessage = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const WebClient = jest.fn((_token: string, _options: unknown) => ({ chat: { postMessage } }))
jest.unstable_mockModule('../src/models/adapter.model.js', () => ({ default: { findById } }))
jest.unstable_mockModule('@slack/web-api', () => ({ WebClient }))
const { archiveDraftId, isArchiveNotifyConfigured, notifyArchiveDraftCreated } = await import(
  '../../../src/services/archiveNotify.service.js'
)

const config = { notifySlackAdapterId: '507f1f77bcf86cd799439099', notifySlackChannel: 'C0CURATORS' }
const notice = { title: 'Public event', date: '2026-10-14', path: `inbox/conversations/event-${'d'.repeat(64)}.md` }

beforeEach(() => {
  adapterLean.mockReset().mockResolvedValue({ type: 'slack', config: { botToken: 'xoxb-test-only' } })
  postMessage.mockReset().mockResolvedValue({ ok: true })
  WebClient.mockClear()
  findById.mockClear()
})

test('configuration requires both the adapter and the channel', () => {
  expect(isArchiveNotifyConfigured(config)).toBe(true)
  expect(isArchiveNotifyConfigured({ ...config, notifySlackChannel: '' })).toBe(false)
  expect(isArchiveNotifyConfigured({ ...config, notifySlackAdapterId: undefined })).toBe(false)
})

test('draft ID is the event slug from the inbox path', () => {
  expect(archiveDraftId(notice.path)).toBe(`event-${'d'.repeat(64)}`)
})

test('posts a card with text fallback to the configured channel using the adapter bot token', async () => {
  expect(await notifyArchiveDraftCreated(config, notice)).toEqual({ sent: true })
  expect(findById).toHaveBeenCalledWith(config.notifySlackAdapterId)
  // A dedicated fail-fast client: no retries, a request timeout, and no waiting out rate limits.
  expect(WebClient).toHaveBeenCalledWith('xoxb-test-only', {
    retryConfig: { retries: 0 },
    timeout: 10000,
    rejectRateLimitedCalls: true
  })
  const args = postMessage.mock.calls[0][0]
  expect(args.channel).toBe('C0CURATORS')
  expect(args.text).toContain('Public event')
  expect(args.blocks.length).toBeGreaterThan(0)
})

test('does nothing when unconfigured', async () => {
  expect(await notifyArchiveDraftCreated({}, notice)).toEqual({ sent: false, reason: 'not_configured' })
  expect(findById).not.toHaveBeenCalled()
})

test.each([
  [null, 'adapter_not_found'],
  [{ type: 'zoom', config: { botToken: 'x' } }, 'adapter_not_slack'],
  [{ type: 'slack', config: {} }, 'missing_bot_token']
])('adapter %j fails gracefully with %s', async (adapter, reason) => {
  adapterLean.mockResolvedValue(adapter)
  expect(await notifyArchiveDraftCreated(config, notice)).toEqual({ sent: false, reason })
  expect(postMessage).not.toHaveBeenCalled()
})

test('lookup errors and Slack errors become short reasons without throwing', async () => {
  adapterLean.mockRejectedValueOnce(new Error('Cast to ObjectId failed'))
  expect(await notifyArchiveDraftCreated(config, notice)).toEqual({ sent: false, reason: 'adapter_lookup_failed' })
  postMessage.mockRejectedValueOnce(new Error('socket hang up xoxb-test-only'))
  expect(await notifyArchiveDraftCreated(config, notice)).toEqual({ sent: false, reason: 'slack_request_failed' })
  postMessage.mockResolvedValueOnce({ ok: false, error: 'channel_not_found' })
  expect(await notifyArchiveDraftCreated(config, notice)).toEqual({ sent: false, reason: 'slack_channel_not_found' })
})

test('timeouts and rate limits map to their own reasons', async () => {
  postMessage.mockRejectedValueOnce(
    Object.assign(new Error('A request error occurred: timeout of 10000ms exceeded'), {
      code: 'slack_webapi_request_error',
      original: { code: 'ECONNABORTED' }
    })
  )
  expect(await notifyArchiveDraftCreated(config, notice)).toEqual({ sent: false, reason: 'timeout' })
  postMessage.mockRejectedValueOnce(
    Object.assign(new Error('A rate limit was exceeded'), { code: 'slack_webapi_rate_limited_error', retryAfter: 30 })
  )
  expect(await notifyArchiveDraftCreated(config, notice)).toEqual({ sent: false, reason: 'slack_rate_limited' })
  postMessage.mockRejectedValueOnce(
    Object.assign(new Error('A request error occurred: connect ECONNREFUSED'), {
      code: 'slack_webapi_request_error',
      original: { code: 'ECONNREFUSED' }
    })
  )
  expect(await notifyArchiveDraftCreated(config, notice)).toEqual({ sent: false, reason: 'slack_request_failed' })
})
