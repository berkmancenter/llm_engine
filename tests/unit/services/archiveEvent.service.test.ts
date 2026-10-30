import { jest } from '@jest/globals'
import {
  ArchiveDeliveryError,
  archiveEventEligibility,
  archiveEventPayload,
  deliverArchiveEvent
} from '../../../src/services/archiveEvent.service.js'

const event = {
  _id: { toString: () => '507f1f77bcf86cd799439011' },
  name: 'Public event',
  conversationType: 'eventAssistant',
  active: false,
  draft: false,
  endTime: new Date('2026-10-14'),
  summary: 'Saved summary',
  presenters: [{ name: 'Speaker' }],
  topic: { private: false, isDeleted: false }
}

afterEach(() => jest.restoreAllMocks())

test('eligibility fails closed for private, missing, restricted, live and nonsummary events', () => {
  expect(archiveEventEligibility(event)).toBeNull()
  for (const changes of [
    { topic: undefined },
    { topic: { private: true, isDeleted: false } },
    { topic: { private: false, isDeleted: true } },
    { enforceMembership: true },
    { locked: true },
    { active: true },
    { draft: true },
    { summary: '' },
    { conversationType: 'communityRoom' },
    { endTime: undefined }
  ]) {
    expect(archiveEventEligibility({ ...event, ...changes })).not.toBeNull()
  }
  expect(archiveEventEligibility(null)).toBe('missing_event')
})

test('payload contains only summary, date, identity and presenters', () => {
  const payload = archiveEventPayload({ ...event, transcript: 'private text', messages: ['private chat'] } as typeof event)
  expect(payload).toEqual({
    source: 'llm-engine',
    source_id: '507f1f77bcf86cd799439011',
    title: 'Public event',
    date: '2026-10-14',
    markdown: 'Saved summary',
    participants: ['Speaker']
  })
})

test('posts an authenticated idempotent event and accepts a duplicate acknowledgment', async () => {
  const path = `inbox/conversations/event-${'a'.repeat(64)}.md`
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ path }), { status: 200 }))
  expect(await deliverArchiveEvent('https://archive.example/', 'test-token', event)).toBe(path)
  expect(spy.mock.calls[0][0]).toBe('https://archive.example/v1/conversations')
  expect(spy.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' })
  expect(JSON.parse(String(spy.mock.calls[0][1]?.body)).source_id).toBe(event._id.toString())
})

test.each([
  [401, false],
  [403, false],
  [400, false],
  [429, true],
  [503, true]
])('HTTP %i retryability is %s', async (status, retryable) => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('DO NOT LOG THIS', { status }))
  await expect(deliverArchiveEvent('https://archive.example', 'test-token', event)).rejects.toMatchObject({
    message: `http_${status}`,
    retryable
  })
})

test('network failures and invalid acknowledgments retry without leaking downstream text', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('sensitive response'))
  await expect(deliverArchiveEvent('https://archive.example', 'test-token', event)).rejects.toMatchObject({
    message: 'network_or_timeout',
    retryable: true
  })
  spy.mockResolvedValue(new Response('{}'))
  await expect(deliverArchiveEvent('https://archive.example', 'test-token', event)).rejects.toBeInstanceOf(
    ArchiveDeliveryError
  )
})
