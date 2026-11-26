import { jest } from '@jest/globals'
import type { Job } from 'agenda'
import type { ArchiveEventJobData } from '../../../src/jobs/handlers/archiveEvent.js'

const event = {
  _id: { toString: () => 'event-1' },
  name: 'Public event',
  conversationType: 'eventAssistant',
  active: false,
  draft: false,
  endTime: new Date('2026-10-14'),
  postEventAnalysis: { summary: 'Summary' },
  topic: { private: false, isDeleted: false }
}
const lean = jest.fn<() => Promise<unknown>>().mockResolvedValue(event)
const query = { select: () => query, populate: () => query, lean }
const config = {
  bkcArchive: {
    exportEnabled: true,
    apiUrl: 'https://archive.example',
    apiToken: 'test-only',
    notifySlackAdapterId: '',
    notifySlackChannel: ''
  }
}
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapterLean = jest.fn<() => Promise<any>>()
const adapterQuery = { select: () => adapterQuery, lean: adapterLean }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const postMessage = jest.fn<(...args: any[]) => Promise<any>>()
const getClient = jest.fn(() => ({ chat: { postMessage } }))
jest.unstable_mockModule('../src/models/conversation.model.js', () => ({ default: { findById: () => query } }))
jest.unstable_mockModule('../src/models/adapter.model.js', () => ({ default: { findById: () => adapterQuery } }))
jest.unstable_mockModule('../src/adapters/slack/client.js', () => ({ default: { getClient } }))
jest.unstable_mockModule('../src/config/config.js', () => ({ default: config }))
jest.unstable_mockModule('../src/config/logger.js', () => ({ default: logger }))
const { archiveEvent } = await import('../../../src/jobs/handlers/archiveEvent.js')

function makeJob() {
  const job = {
    attrs: { data: { conversationId: 'event-1', status: 'queued', attempts: 0 } as ArchiveEventJobData },
    schedule: jest.fn(),
    save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
  }
  return job
}

beforeEach(() => {
  config.bkcArchive.exportEnabled = true
  config.bkcArchive.notifySlackAdapterId = ''
  config.bkcArchive.notifySlackChannel = ''
  lean.mockResolvedValue(event)
  adapterLean.mockReset().mockResolvedValue({ type: 'slack', config: { botToken: 'xoxb-test-only' } })
  postMessage.mockReset().mockResolvedValue({ ok: true })
  getClient.mockClear()
  logger.info.mockClear()
  logger.warn.mockClear()
})
afterEach(() => jest.restoreAllMocks())

const draftPath = `inbox/conversations/event-${'c'.repeat(64)}.md`
const ackWith = (status: number) =>
  jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ path: draftPath }), { status }))
const enableNotify = () => {
  config.bkcArchive.notifySlackAdapterId = '507f1f77bcf86cd799439099'
  config.bkcArchive.notifySlackChannel = 'C0CURATORS'
}
const logged = () => JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])

test('a newly created draft pings the curator channel exactly once, without draft content', async () => {
  enableNotify()
  ackWith(201)
  const job = makeJob()
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(job.attrs.data.status).toBe('delivered')
  expect(getClient).toHaveBeenCalledWith('xoxb-test-only')
  expect(postMessage).toHaveBeenCalledTimes(1)
  const args = postMessage.mock.calls[0][0]
  expect(args.channel).toBe('C0CURATORS')
  expect(JSON.stringify(args)).toContain(`event-${'c'.repeat(64)}`)
  expect(JSON.stringify(args)).toContain('Public event')
  expect(JSON.stringify(args)).not.toContain('Summary')
  expect(logger.info).toHaveBeenCalledWith('Archive export notified event=event-1')
  expect(logged()).not.toContain('xoxb-test-only')
})

test('a duplicate acknowledgment (200) does not ping', async () => {
  enableNotify()
  ackWith(200)
  const job = makeJob()
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(job.attrs.data.status).toBe('delivered')
  expect(postMessage).not.toHaveBeenCalled()
})

test('no ping when notification is unconfigured or only half configured', async () => {
  ackWith(201)
  await archiveEvent(makeJob() as unknown as Job<ArchiveEventJobData>)
  config.bkcArchive.notifySlackChannel = 'C0CURATORS'
  await archiveEvent(makeJob() as unknown as Job<ArchiveEventJobData>)
  expect(postMessage).not.toHaveBeenCalled()
  expect(getClient).not.toHaveBeenCalled()
})

test('a Slack failure is logged and leaves the job delivered without a retry', async () => {
  enableNotify()
  ackWith(201)
  postMessage.mockRejectedValue(
    Object.assign(new Error('An API error occurred: not_in_channel'), { data: { error: 'not_in_channel' } })
  )
  const job = makeJob()
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(job.attrs.data).toEqual({ conversationId: 'event-1', status: 'delivered', attempts: 1, path: draftPath })
  expect(job.schedule).not.toHaveBeenCalled()
  expect(logger.warn).toHaveBeenCalledWith('Archive export notify failed event=event-1 reason=slack_not_in_channel')
})

test('a missing or non-Slack adapter is logged, not fatal', async () => {
  enableNotify()
  ackWith(201)
  adapterLean.mockResolvedValueOnce(null)
  const job = makeJob()
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(job.attrs.data.status).toBe('delivered')
  expect(logger.warn).toHaveBeenCalledWith('Archive export notify failed event=event-1 reason=adapter_not_found')
  adapterLean.mockResolvedValueOnce({ type: 'zoom', config: {} })
  const second = makeJob()
  await archiveEvent(second as unknown as Job<ArchiveEventJobData>)
  expect(second.attrs.data.status).toBe('delivered')
  expect(logger.warn).toHaveBeenCalledWith('Archive export notify failed event=event-1 reason=adapter_not_slack')
  expect(postMessage).not.toHaveBeenCalled()
})

test('successful export is acknowledged once and survives rerunning the job', async () => {
  const job = makeJob()
  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ path: `inbox/conversations/event-${'a'.repeat(64)}.md` })))
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(job.attrs.data.status).toBe('delivered')
  expect(job.attrs.data.attempts).toBe(1)
})

test('transient failure persists backoff; retries recheck privacy', async () => {
  const job = makeJob()
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }))
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(job.attrs.data.status).toBe('retry')
  expect(job.schedule).toHaveBeenCalledWith(expect.any(Date))
  lean.mockResolvedValue({ ...event, topic: { private: true, isDeleted: false } })
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(job.attrs.data.status).toBe('skipped')
  expect(spy).toHaveBeenCalledTimes(1)
})

test('authentication failure is terminal and repeated 503 stops after six attempts', async () => {
  const job = makeJob()
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }))
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(job.attrs.data.status).toBe('failed')
  expect(job.schedule).not.toHaveBeenCalled()
  const retryJob = makeJob()
  spy.mockImplementation(async () => new Response('', { status: 503 }))
  for (let i = 0; i < 8; i += 1) await archiveEvent(retryJob as unknown as Job<ArchiveEventJobData>)
  expect(retryJob.attrs.data.attempts).toBe(6)
  expect(retryJob.attrs.data.status).toBe('failed')
  expect(retryJob.schedule).toHaveBeenCalledTimes(5)
})

test('disabled export makes no network call', async () => {
  config.bkcArchive.exportEnabled = false
  const job = makeJob()
  const spy = jest.spyOn(globalThis, 'fetch')
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(spy).not.toHaveBeenCalled()
  expect(job.attrs.data.reason).toBe('export_disabled')
})

test('recovers a persisted delivering job with the same source ID and consumes another attempt', async () => {
  const job = makeJob()
  job.attrs.data.status = 'delivering'
  job.attrs.data.attempts = 1
  const path = `inbox/conversations/event-${'a'.repeat(64)}.md`
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    expect(job.save).toHaveBeenCalled()
    expect(job.attrs.data.status).toBe('delivering')
    expect(job.attrs.data.attempts).toBe(2)
    expect(JSON.parse(init!.body as string)).toEqual(expect.objectContaining({ source: 'llm-engine', source_id: 'event-1' }))
    return new Response(JSON.stringify({ path }))
  })
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(job.attrs.data).toEqual({ conversationId: 'event-1', status: 'delivered', attempts: 2, path })
  expect(job.save).toHaveBeenCalledTimes(2)
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(spy).toHaveBeenCalledTimes(1)
})

test('crash recovery at the attempt limit does not deliver again', async () => {
  const job = makeJob()
  job.attrs.data.status = 'delivering'
  job.attrs.data.attempts = 6
  const spy = jest.spyOn(globalThis, 'fetch')
  await archiveEvent(job as unknown as Job<ArchiveEventJobData>)
  expect(spy).not.toHaveBeenCalled()
  expect(job.attrs.data.status).toBe('failed')
  expect(job.attrs.data.reason).toBe('attempt_limit')
  expect(job.save).toHaveBeenCalledTimes(1)
})
