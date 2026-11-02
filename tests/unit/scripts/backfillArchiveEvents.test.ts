import { jest } from '@jest/globals'

const event = {
  _id: '507f1f77bcf86cd799439011',
  name: 'Public event',
  conversationType: 'eventAssistant',
  active: false,
  draft: false,
  endTime: new Date('2026-10-14'),
  summary: 'Summary',
  topic: { private: false, isDeleted: false }
}
const lean = jest.fn<() => Promise<unknown[]>>()
const query = { select: () => query, populate: () => query, sort: () => query, limit: jest.fn(() => query), lean }
const find = jest.fn(() => query)
const connect = jest.fn<() => Promise<void>>()
const disconnect = jest.fn<() => Promise<void>>()
const jobs = jest.fn<() => Promise<unknown[]>>()
const close = jest.fn<() => Promise<void>>()
const archiveEvent = jest.fn<() => Promise<void>>()
const retryArchiveEvent = jest.fn<() => Promise<void>>()
const config = { bkcArchive: { exportEnabled: true }, mongoose: { url: 'test', options: {} } }

jest.unstable_mockModule('mongoose', () => ({
  default: { connect, disconnect, isValidObjectId: (id: string) => /^[a-f0-9]{24}$/.test(id) }
}))
jest.unstable_mockModule('../src/models/conversation.model.js', () => ({ default: { find } }))
jest.unstable_mockModule('../src/config/config.js', () => ({ default: config }))
jest.unstable_mockModule('../src/jobs/index.js', () => ({ default: { jobs, close } }))
jest.unstable_mockModule('../src/jobs/schedule.js', () => ({ default: { archiveEvent, retryArchiveEvent } }))
const { default: backfillArchiveEvents } = await import('../../../scripts/backfillArchiveEvents.js')
let output: ReturnType<typeof jest.spyOn>

beforeEach(() => {
  jest.clearAllMocks()
  lean.mockResolvedValue([event])
  jobs.mockResolvedValue([])
  config.bkcArchive.exportEnabled = true
  output = jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

test('dry-run checks eligibility without enqueueing or retrying', async () => {
  await backfillArchiveEvents(['--limit=5', `--id=${event._id}`, '--retry'])
  expect(find).toHaveBeenCalledWith(expect.objectContaining({ _id: event._id, active: false }))
  expect(query.limit).toHaveBeenCalledWith(5)
  expect(output).toHaveBeenCalledWith(`event=${event._id} eligible (dry-run)`)
  expect(archiveEvent).not.toHaveBeenCalled()
  expect(retryArchiveEvent).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledWith({ force: true })
  expect(disconnect).toHaveBeenCalled()
})

test('enqueue schedules a new eligible event', async () => {
  await backfillArchiveEvents(['--enqueue'])
  expect(archiveEvent).toHaveBeenCalledWith(event._id)
  expect(output).toHaveBeenCalledWith(`event=${event._id} queued`)
})

test.each(['queued', 'retry', 'delivering', 'failed', 'skipped', 'delivered'])(
  'reports existing %s work without claiming an insertion',
  async (status) => {
    jobs.mockResolvedValue([{ attrs: { data: { status } } }])
    await backfillArchiveEvents(['--enqueue'])
    expect(jobs).toHaveBeenCalledWith({ name: 'archiveEvent', 'data.conversationId': event._id })
    expect(output).toHaveBeenCalledWith(`event=${event._id} already_${status === 'delivered' ? 'delivered' : 'queued'}`)
    expect(archiveEvent).not.toHaveBeenCalled()
    expect(retryArchiveEvent).not.toHaveBeenCalled()
  }
)

test.each(['failed', 'skipped'])('explicit retry requeues %s work', async (status) => {
  jobs.mockResolvedValue([{ attrs: { data: { status } } }])
  await backfillArchiveEvents(['--enqueue', '--retry'])
  expect(retryArchiveEvent).toHaveBeenCalledWith(event._id)
  expect(archiveEvent).not.toHaveBeenCalled()
  expect(output).toHaveBeenCalledWith(`event=${event._id} requeued`)
})

test('retry dry-run leaves terminal work untouched', async () => {
  jobs.mockResolvedValue([{ attrs: { data: { status: 'failed' } } }])
  await backfillArchiveEvents(['--retry'])
  expect(output).toHaveBeenCalledWith(`event=${event._id} retryable (dry-run)`)
  expect(retryArchiveEvent).not.toHaveBeenCalled()
  expect(archiveEvent).not.toHaveBeenCalled()
})

test('explicit retry preserves delivered work', async () => {
  jobs.mockResolvedValue([{ attrs: { data: { status: 'delivered' } } }])
  await backfillArchiveEvents(['--enqueue', '--retry'])
  expect(output).toHaveBeenCalledWith(`event=${event._id} already_delivered`)
  expect(retryArchiveEvent).not.toHaveBeenCalled()
  expect(archiveEvent).not.toHaveBeenCalled()
})

test('ineligible events are skipped', async () => {
  lean.mockResolvedValue([{ ...event, topic: { private: true, isDeleted: false } }])
  await backfillArchiveEvents(['--enqueue'])
  expect(output).toHaveBeenCalledWith(expect.stringMatching(/skipped=/))
  expect(archiveEvent).not.toHaveBeenCalled()
})

test('disabled export rejects enqueue before connecting', async () => {
  config.bkcArchive.exportEnabled = false
  await expect(backfillArchiveEvents(['--enqueue'])).rejects.toThrow('Archive export is disabled')
  expect(connect).not.toHaveBeenCalled()
  expect(archiveEvent).not.toHaveBeenCalled()
})

test('queue failure is surfaced and connections are closed', async () => {
  archiveEvent.mockRejectedValueOnce(new Error('queue unavailable'))
  await expect(backfillArchiveEvents(['--enqueue'])).rejects.toThrow('queue unavailable')
  expect(output).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalled()
  expect(disconnect).toHaveBeenCalled()
})
