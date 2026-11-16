import { jest } from '@jest/globals'

// The backfill script and the archiveEvent job both populate `topic` on a Conversation query.
// mongoose throws MissingSchemaError for that unless the Topic model is registered, which the
// other unit tests hide by mocking the models. Import them for real and check registration.
jest.unstable_mockModule('../src/jobs/index.js', () => ({ default: { jobs: jest.fn(), close: jest.fn() } }))
jest.unstable_mockModule('../src/jobs/schedule.js', () => ({ default: {} }))

async function registeredModels() {
  const { default: mongoose } = await import('mongoose')
  return mongoose.modelNames()
}

describe('archive export model registration', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it('backfill script registers the Topic model it populates', async () => {
    expect(await registeredModels()).not.toContain('Topic')
    await import('../../../scripts/backfillArchiveEvents.js')
    expect(await registeredModels()).toContain('Topic')
  })

  it('archiveEvent job handler registers the Topic model it populates', async () => {
    expect(await registeredModels()).not.toContain('Topic')
    await import('../../../src/jobs/handlers/archiveEvent.js')
    expect(await registeredModels()).toContain('Topic')
  })
})
