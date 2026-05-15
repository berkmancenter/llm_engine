import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { User } from '../../src/models/index.js'
import userService from '../../src/services/user.service.js'

setupIntTest()

const BOT_USERNAME = 'event-setup-bot'

describe('ensureEventSetupBotUser()', () => {
  describe('user creation', () => {
    it('creates a user with the serviceAccount role and returns its ID', async () => {
      const id = await userService.ensureEventSetupBotUser()

      expect(id).toBeDefined()
      expect(mongoose.Types.ObjectId.isValid(id)).toBe(true)

      const user = await User.findOne({ username: BOT_USERNAME })
      expect(user).not.toBeNull()
      expect(user!.role).toBe('serviceAccount')
    })

    it('creates exactly one user document', async () => {
      await userService.ensureEventSetupBotUser()

      const count = await User.countDocuments({ username: BOT_USERNAME })
      expect(count).toBe(1)
    })

    it('creates the bot user without a password', async () => {
      await userService.ensureEventSetupBotUser()

      const user = await User.findOne({ username: BOT_USERNAME })
      expect(user!.password).toBeFalsy()
    })
  })

  describe('idempotency', () => {
    it('returns the same ID on repeated calls', async () => {
      const id1 = await userService.ensureEventSetupBotUser()
      const id2 = await userService.ensureEventSetupBotUser()

      expect(id1).toBe(id2)
    })

    it('does not create duplicate user documents on repeated calls', async () => {
      await userService.ensureEventSetupBotUser()
      await userService.ensureEventSetupBotUser()

      const count = await User.countDocuments({ username: BOT_USERNAME })
      expect(count).toBe(1)
    })

    it('finds and returns an existing bot user ID when one already exists', async () => {
      const existing = await User.create({
        username: BOT_USERNAME,
        role: 'serviceAccount',
        pseudonyms: [{ token: 'test-token', pseudonym: 'EventSetupBot', active: true }]
      })

      const id = await userService.ensureEventSetupBotUser()

      expect(id).toBe(existing._id.toString())
    })
  })
})
