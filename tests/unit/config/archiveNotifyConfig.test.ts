import { jest } from '@jest/globals'

// Keep a developer's local .env out of this: config.ts loads it at import time.
jest.unstable_mockModule('dotenv', () => ({ default: { config: () => ({}) } }))
process.env.BKC_ARCHIVE_NOTIFY_SLACK_ADAPTER_ID = ''
delete process.env.BKC_ARCHIVE_NOTIFY_SLACK_CHANNEL
const { default: config } = await import('../../../src/config/config.js')
const { isArchiveNotifyConfigured } = await import('../../../src/services/archiveNotify.service.js')

test('empty or unset archive notify settings load as empty strings and leave notification off', () => {
  expect(config.bkcArchive.notifySlackAdapterId).toBe('')
  expect(config.bkcArchive.notifySlackChannel).toBe('')
  expect(isArchiveNotifyConfigured(config.bkcArchive)).toBe(false)
})
