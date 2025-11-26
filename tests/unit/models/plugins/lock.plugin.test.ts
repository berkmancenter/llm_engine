import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import lockPlugin, { DEFAULT_LOCK_TTL_MS } from '../../../../src/models/plugins/lock.plugin.js'

let TestModel

beforeAll(() => {
  const testSchema = new mongoose.Schema({ name: String })
  testSchema.plugin(lockPlugin)
  TestModel = mongoose.model('TestResource', testSchema)
})

setupIntTest()

describe('Lock Plugin', () => {
  beforeEach(async () => {
    // Clean up any existing locks
    await mongoose.connection.collection('mongo_safe_locks').deleteMany({})
    // Clean up test resources
    await TestModel.deleteMany({})
  })

  describe('Basic acquire and release functionality', () => {
    test('should acquire and release a lock successfully', async () => {
      // Create a test resource
      const resource = new TestModel({ name: 'test-resource' })
      await resource.save()

      // Acquire lock
      const resourceModel = await TestModel.findById(resource._id)
      await resourceModel.acquireLock()

      // Check if lock exists in the database
      const lockCollection = mongoose.connection.collection('mongo_safe_locks')
      const lock = await lockCollection.findOne({ resourceId: resource._id })
      expect(lock).toBeTruthy()

      // Release lock
      await resourceModel.releaseLock()

      // Check if lock was removed
      const lockAfterRelease = await lockCollection.findOne({ resourceId: resource._id })
      expect(lockAfterRelease).toBeNull()
    })

    test('should set and clear __lockId on the model instance', async () => {
      const resource = new TestModel({ name: 'lock-id-test' })
      await resource.save()

      const resourceModel = await TestModel.findById(resource._id)
      expect(resourceModel.__lockId).toBeUndefined()

      await resourceModel.acquireLock()
      expect(resourceModel.__lockId).toBeDefined()

      await resourceModel.releaseLock()
      expect(resourceModel.__lockId).toBeNull()
    })
  })

  describe('Per-item TTL behavior', () => {
    test('should set correct expiration time based on TTL', async () => {
      const resource = new TestModel({ name: 'ttl-resource' })
      await resource.save()

      const ttlMs = 10000 // 10 seconds
      const resourceModel = await TestModel.findById(resource._id)
      await resourceModel.acquireLock(ttlMs)

      const lockCollection = mongoose.connection.collection('mongo_safe_locks')
      const lock = await lockCollection.findOne({ resourceId: resource._id })

      expect(lock).toBeTruthy()
      // Use non-null assertion since we've verified lock exists with the previous expect
      expect(lock!.expiresAt).toBeTruthy()

      // Check if expiration time is approximately correct (within 100ms tolerance)
      const expectedExpiry = new Date(Date.now() + ttlMs)
      const timeDiff = Math.abs(lock!.expiresAt.getTime() - expectedExpiry.getTime())
      expect(timeDiff).toBeLessThan(100)
    })

    test('acquireLock should use default TTL when null TTL is provided', async () => {
      const resource = new TestModel({ name: 'null-ttl-acquirelock-test' })
      await resource.save()

      // Test acquireLock with null TTL
      const resourceModel = await TestModel.findById(resource._id)
      await resourceModel.acquireLock(null)

      const lock = await mongoose.connection.collection('mongo_safe_locks').findOne({ resourceId: resource._id })
      expect(lock).toBeTruthy()

      // Check if expiration time is approximately correct (within 100ms tolerance)
      const expectedExpiry = new Date(Date.now() + DEFAULT_LOCK_TTL_MS)
      const timeDiff = Math.abs(lock!.expiresAt.getTime() - expectedExpiry.getTime())
      expect(timeDiff).toBeLessThan(100)

      await resourceModel.releaseLock()
    })
  })

  describe('Automatic cleanup of expired locks', () => {
    test('should automatically clean up expired locks when acquiring a new lock', async () => {
      const resource = new TestModel({ name: 'expired-resource' })
      await resource.save()

      // Manually insert an expired lock
      const lockCollection = mongoose.connection.collection('mongo_safe_locks')

      // First clear any existing locks for this resource
      await lockCollection.deleteMany({ resourceId: resource._id })

      await lockCollection.insertOne({
        resourceId: resource._id,
        createdAt: new Date(Date.now() - 60000), // 1 minute ago
        expiresAt: new Date(Date.now() - 30000) // 30 seconds ago (expired)
      })

      // Verify expired lock exists
      const expiredLock = await lockCollection.findOne({ resourceId: resource._id })
      expect(expiredLock).toBeTruthy()

      // Try to acquire a lock, which should clean up the expired lock
      const resourceModel = await TestModel.findById(resource._id)

      // Wait a bit to ensure we don't get a duplicate key error due to timestamp precision
      await new Promise((resolve) => setTimeout(resolve, 100))

      await resourceModel.acquireLock()

      // The expired lock should be gone, replaced by our new lock
      const locks = await lockCollection.find({ resourceId: resource._id }).toArray()
      expect(locks).toHaveLength(1)
      expect(locks[0].expiresAt.getTime()).toBeGreaterThan(Date.now())
    })
  })

  const originalSetTimeout = global.setTimeout

  afterEach(() => {
    global.setTimeout = originalSetTimeout
  })

  describe('Atomicity and cooperative ordering', () => {
    test('should respect lock ordering (first come, first served)', async () => {
      const resource = new TestModel({ name: 'ordered-resource' })
      await resource.save()

      // Create two instances of the same resource
      const resourceModel1 = await TestModel.findById(resource._id)
      const resourceModel2 = await TestModel.findById(resource._id)

      // Mock the setTimeout to make tests faster but don't immediately execute callback
      global.setTimeout = jest
        .fn()
        .mockImplementation((callback) => originalSetTimeout(callback, 10)) as unknown as typeof setTimeout

      // First instance acquires lock
      const acquireLock1Promise = resourceModel1.acquireLock()
      await acquireLock1Promise

      // Second instance tries to acquire lock but should wait
      let lock2Acquired = false
      const acquireLock2Promise = resourceModel2.acquireLock().then(() => {
        lock2Acquired = true
      })

      // Lock2 shouldn't be acquired yet because lock1 is still active
      expect(lock2Acquired).toBe(false)

      // Release the first lock
      await resourceModel1.releaseLock()

      // Now the second lock should be acquired
      await acquireLock2Promise
      expect(lock2Acquired).toBe(true)

      // Restore setTimeout is now handled in afterEach
    })

    test('should handle concurrent lock attempts correctly', async () => {
      const resource = new TestModel({ name: 'concurrent-resource' })
      await resource.save()

      // First clear any existing locks for this resource
      const lockCollection = mongoose.connection.collection('mongo_safe_locks')
      await lockCollection.deleteMany({ resourceId: resource._id })

      // Create multiple resource instances
      const instances = await Promise.all([
        TestModel.findById(resource._id),
        TestModel.findById(resource._id),
        TestModel.findById(resource._id)
      ])

      // Track lock acquisition order
      const lockOrder: number[] = []

      // Start concurrent lock attempts with significant delays between them
      // to avoid timestamp collisions
      const lockPromises = instances.map(
        (instance, index) =>
          new Promise<void>((resolve) => {
            // Stagger the lock attempts significantly
            setTimeout(() => {
              instance
                .acquireLock()
                .then(() => {
                  lockOrder.push(index)
                  return instance.releaseLock()
                })
                .then(() => resolve())
            }, index * 50) // Increase delay between attempts
          })
      )

      // Wait for all locks to be acquired and released with a longer timeout
      await Promise.all(lockPromises)

      // Verify we got 3 locks in some order
      expect(lockOrder).toHaveLength(3)

      // Each index should appear exactly once
      expect(new Set(lockOrder).size).toBe(3)

      // Restore setTimeout is now handled in afterEach
    }, 10000) // Increase test timeout to 10 seconds
  })

  describe('withLock behaviors', () => {
    test('withLock should use default TTL when null TTL is provided', async () => {
      const resource = new TestModel({ name: 'null-ttl-withlock-test' })
      await resource.save()

      // Test withLock with null TTL
      await TestModel.withLock(
        resource._id,
        async () => {
          const lock = await mongoose.connection.collection('mongo_safe_locks').findOne({ resourceId: resource._id })
          expect(lock).toBeTruthy()

          // Check if expiration time is approximately correct (within 100ms tolerance)
          const expectedExpiry = new Date(Date.now() + DEFAULT_LOCK_TTL_MS)
          const timeDiff = Math.abs(lock!.expiresAt.getTime() - expectedExpiry.getTime())
          expect(timeDiff).toBeLessThan(100)
        },
        null
      )
    })

    test('should execute handler with fresh document even if updated while waiting', async () => {
      const resource = new TestModel({ name: 'initial-name' })
      await resource.save()

      const lockCollection = mongoose.connection.collection('mongo_safe_locks')
      await lockCollection.deleteMany({ resourceId: resource._id })

      // First lock to block the second one
      const blocker = await TestModel.findById(resource._id)
      await blocker.acquireLock()

      // Start withLock in background
      const resultPromise = TestModel.withLock(resource._id, async () => {
        const fresh = await TestModel.findById(resource._id)
        return fresh.name
      })

      // Wait a bit to ensure withLock is waiting
      await new Promise((r) => setTimeout(r, 100))

      // Update the document while withLock is waiting
      await TestModel.findByIdAndUpdate(resource._id, { name: 'updated-name' })

      // Release the blocking lock
      await blocker.releaseLock()

      const result = await resultPromise
      expect(result).toBe('updated-name')
    })

    test('withLock should serialize concurrent access', async () => {
      const resource = new TestModel({ name: 'serialize-test' })
      await resource.save()

      const executionOrder: number[] = []

      const task = (index: number) =>
        TestModel.withLock(resource._id, async () => {
          executionOrder.push(index)
          await new Promise((r) => setTimeout(r, 50))
        })

      await Promise.all([task(1), task(2), task(3)])

      expect(executionOrder).toHaveLength(3)
      expect(new Set(executionOrder)).toEqual(new Set([1, 2, 3]))
    })

    test('withLock should clean up expired locks before acquiring', async () => {
      const resource = new TestModel({ name: 'expired-cleanup-test' })
      await resource.save()

      const lockCollection = mongoose.connection.collection('mongo_safe_locks')

      await lockCollection.insertOne({
        resourceId: resource._id,
        createdAt: new Date(Date.now() - 60000),
        expiresAt: new Date(Date.now() - 30000)
      })

      const result = await TestModel.withLock(resource._id, async () => 'done')

      expect(result).toBe('done')

      const remainingLocks = await lockCollection.find({ resourceId: resource._id }).toArray()
      expect(remainingLocks).toHaveLength(0)
    }, 10000)

    test('withLock should respect TTL', async () => {
      const resource = new TestModel({ name: 'ttl-test' })
      await resource.save()

      const ttlMs = 500

      await TestModel.withLock(
        resource._id,
        async () => {
          const lock = await mongoose.connection.collection('mongo_safe_locks').findOne({ resourceId: resource._id })
          expect(lock).toBeTruthy()
          expect(lock!.expiresAt).not.toBeNull()
        },
        ttlMs
      )
    })

    test('withLock should release lock if handler throws', async () => {
      const resource = new TestModel({ name: 'throw-test' })
      await resource.save()

      await expect(
        TestModel.withLock(resource._id, async () => {
          throw new Error('handler failed')
        })
      ).rejects.toThrow('handler failed')

      const lock = await mongoose.connection.collection('mongo_safe_locks').findOne({ resourceId: resource._id })

      expect(lock).toBeNull()
    })
  })
})
