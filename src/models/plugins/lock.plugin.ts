import mongoose from 'mongoose'

/**
 * A simple mongoose lock plugin, which keeps queue order
 * Consider adding a TTLs KV store like Redis to better handle locking
 * NOTE! The simplistic acquireLock and releaseLock can result in outdated data in the doc
 * Better to use withLock for fresh data! Otherwise you need to reload the doc after the lock is available
 */

const LOCK_COLLECTION_NAME = 'mongo_safe_locks'
export const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000
const RECHECK_LOCK_MS = 200

interface ILock {
  resourceId: mongoose.Schema.Types.ObjectId
  createdAt: Date
  expiresAt: Date
}

const lockSchema = new mongoose.Schema<ILock>(
  {
    resourceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },
    createdAt: { type: Date, default: Date.now, required: true, index: true },
    // note expires parameter for auto-expiration
    expiresAt: { type: Date, default: () => Date.now() + DEFAULT_LOCK_TTL_MS, expires: 0, required: true, index: true }
  },
  { versionKey: false, collection: LOCK_COLLECTION_NAME }
)

// Create a compound index for uniqueness
lockSchema.index({ resourceId: 1, createdAt: 1 }, {
  unique: true,
  name: 'resourceId_createdAt_unique'
} as mongoose.IndexOptions)

const Lock = mongoose.model<ILock>('Lock', lockSchema)

// Use this to get current, up to date document
export const withLock = async function (resourceId, handler, ttlMs = DEFAULT_LOCK_TTL_MS) {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + (ttlMs || DEFAULT_LOCK_TTL_MS))

  let lockEntry
  while (true) {
    // Clean up expired locks before trying to create a new one
    await Lock.deleteMany({
      resourceId,
      expiresAt: { $lte: new Date() }
    })

    try {
      lockEntry = await Lock.create({
        resourceId,
        createdAt: new Date(),
        expiresAt
      })
      break
    } catch (err) {
      if (err.code === 11000) {
        await new Promise((r) => setTimeout(r, 10))
        continue
      }
      throw err
    }
  }

  try {
    while (true) {
      const oldest = await Lock.findOne({
        resourceId,
        expiresAt: { $gt: new Date() }
      }).sort({ createdAt: 1 })

      if (oldest && oldest._id.equals(lockEntry._id)) {
        break
      }

      await new Promise((r) => setTimeout(r, RECHECK_LOCK_MS))
    }

    return await handler()
  } finally {
    await Lock.deleteOne({ _id: lockEntry._id })
  }
}

const lockPlugin = (schema) => {
  // eslint-disable-next-line no-param-reassign
  schema.methods.acquireLock = async function (ttlMs = DEFAULT_LOCK_TTL_MS): Promise<void> {
    const resourceId = this._id.toString()

    let lockEntry
    let isOwner = false

    while (!isOwner) {
      // Clean up any expired locks
      await Lock.deleteMany({
        resourceId,
        expiresAt: { $lte: new Date() }
      })

      try {
        // Try to create a new lock
        const createdAt = new Date()
        const expiresAt = new Date(createdAt.getTime() + (ttlMs || DEFAULT_LOCK_TTL_MS))
        lockEntry = await Lock.create({
          resourceId,
          createdAt,
          expiresAt
        })
      } catch (err) {
        if (err.code === 11000) {
          // Duplicate key error, retry
          await new Promise((r) => setTimeout(r, 10))
          continue
        }
        throw err
      }

      // Find the oldest, unexpired lock
      const oldest = await Lock.findOne({
        resourceId,
        expiresAt: { $gt: new Date() }
      }).sort({ createdAt: 1 })

      if (oldest && oldest._id.equals(lockEntry._id)) {
        isOwner = true
        break
      }

      await new Promise((r) => setTimeout(r, RECHECK_LOCK_MS))
    }

    this.__lockId = lockEntry._id
  }

  // eslint-disable-next-line no-param-reassign
  schema.methods.releaseLock = async function (): Promise<void> {
    if (!this.__lockId) return

    await Lock.deleteOne({ _id: this.__lockId })
    this.__lockId = null
  }

  // eslint-disable-next-line no-param-reassign
  schema.statics.withLock = withLock
}

export default lockPlugin
