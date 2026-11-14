import { jest } from '@jest/globals'
import { MongoClient, ObjectId, type Db } from 'mongodb'

// Real-database integration test for the archive export query path. Nothing here mocks
// mongoose or the models: the only stub is global fetch (the HTTP boundary). Seeding goes
// through the raw driver on purpose. Using the Topic model to seed would register it and hide
// the MissingSchemaError this test exists to catch when the script or job handler forgets to
// import the model it populates.
// config.mongoose.url appends '-test' when NODE_ENV=test, so the database the app code actually
// uses is `<MONGODB_URL db>-test`. Always point at a dedicated database on the configured host,
// whatever MONGODB_URL says, so this test never drops another suite's collections.
const BASE_DB = 'archive_export_integ'
const DB_NAME = `${BASE_DB}-test`
const { host } = new URL(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/x')
process.env.MONGODB_URL = `mongodb://${host}/${BASE_DB}`
const MONGODB_URL = `mongodb://${host}/${DB_NAME}`
process.env.BKC_ARCHIVE_EXPORT_ENABLED = 'true'
process.env.BKC_ARCHIVE_API_URL = 'http://archive.invalid'
process.env.BKC_ARCHIVE_API_TOKEN = 'local-test-only'

const COLLECTIONS = ['conversations', 'topics', 'agendaJobs']
let client: MongoClient
let db: Db

const completed = (topic: ObjectId, overrides: Record<string, unknown> = {}) => ({
  _id: new ObjectId(),
  name: 'Integration event',
  conversationType: 'eventAssistant',
  active: false,
  draft: false,
  locked: false,
  enforceMembership: false,
  startTime: new Date('2026-01-02T10:00:00Z'),
  endTime: new Date('2026-01-02T11:00:00Z'),
  summary: 'A public summary.',
  presenters: [{ name: 'Ada' }],
  topic,
  ...overrides
})

const ids: Record<string, string> = {}

async function seed() {
  const publicTopic = new ObjectId()
  const privateTopic = new ObjectId()
  const deletedTopic = new ObjectId()
  await db.collection('topics').insertMany([
    { _id: publicTopic, name: 'public', private: false, isDeleted: false },
    { _id: privateTopic, name: 'private', private: true, isDeleted: false },
    { _id: deletedTopic, name: 'deleted', private: false, isDeleted: true }
  ])
  const docs = {
    eligible: completed(publicTopic),
    privateTopic: completed(privateTopic),
    deletedTopic: completed(deletedTopic),
    locked: completed(publicTopic, { locked: true }),
    enforceMembership: completed(publicTopic, { enforceMembership: true }),
    noSummary: completed(publicTopic, { summary: '' }),
    active: completed(publicTopic, { active: true }),
    draft: completed(publicTopic, { draft: true })
  }
  await db.collection('conversations').insertMany(Object.values(docs))
  for (const [key, doc] of Object.entries(docs)) ids[key] = doc._id.toString()
}

async function clean() {
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name))
  for (const name of COLLECTIONS) if (existing.has(name)) await db.collection(name).drop()
}

// Fresh module registry per run: the script closes the shared Agenda instance when it finishes.
async function runBackfill(args: string[]): Promise<string[]> {
  jest.resetModules()
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    const { default: backfill } = await import('../../../scripts/backfillArchiveEvents.js')
    await backfill(args)
    return log.mock.calls.map((c) => String(c[0]))
  } finally {
    log.mockRestore()
  }
}

const outcomeFor = (lines: string[], id: string) => lines.find((l) => l.startsWith(`event=${id} `))

beforeAll(async () => {
  client = new MongoClient(MONGODB_URL)
  await client.connect()
  db = client.db(DB_NAME)
})

beforeEach(async () => {
  await clean()
  await seed()
})

afterAll(async () => {
  await clean()
  await client.close()
})

describe('archive export against a real database', () => {
  it('dry-run classifies seeded events by eligibility', async () => {
    const lines = await runBackfill([])
    expect(outcomeFor(lines, ids.eligible)).toBe(`event=${ids.eligible} eligible (dry-run)`)
    expect(outcomeFor(lines, ids.privateTopic)).toBe(`event=${ids.privateTopic} skipped=nonpublic_topic`)
    expect(outcomeFor(lines, ids.deletedTopic)).toBe(`event=${ids.deletedTopic} skipped=nonpublic_topic`)
    expect(outcomeFor(lines, ids.locked)).toBe(`event=${ids.locked} skipped=restricted_event`)
    expect(outcomeFor(lines, ids.enforceMembership)).toBe(`event=${ids.enforceMembership} skipped=restricted_event`)
    // Excluded by the query itself, so they never reach the eligibility check.
    for (const key of ['noSummary', 'active', 'draft']) expect(outcomeFor(lines, ids[key])).toBeUndefined()
    expect(await db.collection('agendaJobs').countDocuments({ name: 'archiveEvent' })).toBe(0)
  })

  it('--enqueue queues only the eligible event, and a second run queues nothing new', async () => {
    const first = await runBackfill(['--enqueue'])
    expect(outcomeFor(first, ids.eligible)).toBe(`event=${ids.eligible} queued`)
    expect(outcomeFor(first, ids.privateTopic)).toBe(`event=${ids.privateTopic} skipped=nonpublic_topic`)

    const second = await runBackfill(['--enqueue'])
    expect(outcomeFor(second, ids.eligible)).toBe(`event=${ids.eligible} already_queued`)

    const jobs = await db.collection('agendaJobs').find({ name: 'archiveEvent' }).toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].data).toMatchObject({ conversationId: ids.eligible, status: 'queued' })
  })

  it('archiveEvent job handler delivers an eligible event, stubbing only fetch', async () => {
    const path = `inbox/conversations/event-${'a'.repeat(64)}.md`
    const fetchStub = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ path }), { status: 200 }))
    try {
      jest.resetModules()
      const { default: agenda } = await import('../../../src/jobs/index.js')
      const { default: schedule } = await import('../../../src/jobs/schedule.js')
      const { archiveEvent } = await import('../../../src/jobs/handlers/archiveEvent.js')
      const { default: mongoose } = await import('mongoose')
      try {
        await mongoose.connect(MONGODB_URL)
        await agenda._ready
        for (const key of ['eligible', 'privateTopic']) await schedule.archiveEvent(ids[key])
        const jobs = await agenda.jobs({ name: 'archiveEvent' })
        for (const job of jobs) await archiveEvent(job as Parameters<typeof archiveEvent>[0])

        const saved = await agenda.jobs({ name: 'archiveEvent' })
        const byId = (id: string) => saved.find((j) => j.attrs.data.conversationId === id)!.attrs.data
        expect(byId(ids.eligible)).toMatchObject({ status: 'delivered', attempts: 1, path })
        expect(byId(ids.privateTopic)).toMatchObject({ status: 'skipped', reason: 'nonpublic_topic' })

        expect(fetchStub).toHaveBeenCalledTimes(1)
        const [url, init] = fetchStub.mock.calls[0] as [string, { body: string }]
        expect(url).toBe('http://archive.invalid/v1/conversations')
        expect(JSON.parse(String(init.body))).toMatchObject({ source_id: ids.eligible, markdown: 'A public summary.' })
      } finally {
        await agenda.close({ force: true })
        await mongoose.disconnect()
      }
    } finally {
      fetchStub.mockRestore()
    }
  })
})
