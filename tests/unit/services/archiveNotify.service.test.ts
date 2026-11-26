import { jest } from '@jest/globals'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapterLean = jest.fn<() => Promise<any>>()
const adapterQuery = { select: () => adapterQuery, lean: adapterLean }
const findById = jest.fn(() => adapterQuery)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const postMessage = jest.fn<(...args: any[]) => Promise<any>>()
const getClient = jest.fn(() => ({ chat: { postMessage } }))
jest.unstable_mockModule('../src/models/adapter.model.js', () => ({ default: { findById } }))
jest.unstable_mockModule('../src/adapters/slack/client.js', () => ({ default: { getClient } }))
const { archiveDraftId, isArchiveNotifyConfigured, notifyArchiveDraftCreated } = await import(
  '../../../src/services/archiveNotify.service.js'
)

const config = { notifySlackAdapterId: '507f1f77bcf86cd799439099', notifySlackChannel: 'C0CURATORS' }
const notice = { title: 'Public event', date: '2026-10-14', path: `inbox/conversations/event-${'d'.repeat(64)}.md` }

beforeEach(() => {
  adapterLean.mockReset().mockResolvedValue({ type: 'slack', config: { botToken: 'xoxb-test-only' } })
  postMessage.mockReset().mockResolvedValue({ ok: true })
  getClient.mockClear()
  findById.mockClear()
})
afterEach(() => jest.useRealTimers())

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
  expect(getClient).toHaveBeenCalledWith('xoxb-test-only')
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

test('a hung Slack call is bounded by a timeout', async () => {
  jest.useFakeTimers()
  postMessage.mockReturnValue(new Promise(() => undefined))
  const pending = notifyArchiveDraftCreated(config, notice)
  await jest.advanceTimersByTimeAsync(10000)
  expect(await pending).toEqual({ sent: false, reason: 'timeout' })
})
