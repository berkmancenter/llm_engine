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
  summary: 'Summary',
  topic: { private: false, isDeleted: false }
}
const lean = jest.fn<() => Promise<unknown>>().mockResolvedValue(event)
const query = { select: () => query, populate: () => query, lean }
const config = { bkcArchive: { exportEnabled: true, apiUrl: 'https://archive.example', apiToken: 'test-only' } }
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
jest.unstable_mockModule('../src/models/conversation.model.js', () => ({ default: { findById: () => query } }))
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
  lean.mockResolvedValue(event)
})
afterEach(() => jest.restoreAllMocks())

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
