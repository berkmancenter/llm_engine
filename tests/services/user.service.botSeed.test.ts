import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { User, Topic, Follower } from '../../src/models/index.js'
import userService from '../../src/services/user.service.js'
import config from '../../src/config/config.js'

setupIntTest()

const BOT_USERNAME = 'event-setup-bot'

const buildTopic = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  name: 'Test Topic',
  slug: 'test-topic',
  votingAllowed: true,
  conversationCreationAllowed: true,
  private: true,
  archivable: false,
  owner: new mongoose.Types.ObjectId(),
  ...overrides
})

describe('ensureEventSetupBotUser()', () => {
  describe('user creation', () => {
    it('creates a user with the eventSetupBot role and returns its ID', async () => {
      const id = await userService.ensureEventSetupBotUser()

      expect(id).toBeDefined()
      expect(mongoose.Types.ObjectId.isValid(id)).toBe(true)

      const user = await User.findOne({ username: BOT_USERNAME })
      expect(user).not.toBeNull()
      expect(user!.role).toBe('eventSetupBot')
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
        role: 'eventSetupBot',
        pseudonyms: [{ token: 'test-token', pseudonym: 'EventSetupBot', active: true }]
      })

      const id = await userService.ensureEventSetupBotUser()

      expect(id).toBe(existing._id.toString())
    })
  })

  describe('topic following', () => {
    let originalDefaultTopics: string[]

    beforeEach(() => {
      originalDefaultTopics = config.eventSetupDefaultTopics ?? []
    })

    afterEach(() => {
      config.eventSetupDefaultTopics = originalDefaultTopics
    })

    it('follows each topic in EVENT_SETUP_DEFAULT_TOPICS', async () => {
      const topic = await Topic.create(buildTopic())
      config.eventSetupDefaultTopics = [topic._id.toString()]

      await userService.ensureEventSetupBotUser()

      const botUser = await User.findOne({ username: BOT_USERNAME })
      const follower = await Follower.findOne({ user: botUser!._id, topic: topic._id })
      expect(follower).not.toBeNull()
    })

    it('does not create duplicate Follower records on repeated calls', async () => {
      const topic = await Topic.create(buildTopic({ slug: 'test-topic-2', name: 'Test Topic 2' }))
      config.eventSetupDefaultTopics = [topic._id.toString()]

      await userService.ensureEventSetupBotUser()
      await userService.ensureEventSetupBotUser()

      const botUser = await User.findOne({ username: BOT_USERNAME })
      const count = await Follower.countDocuments({ user: botUser!._id, topic: topic._id })
      expect(count).toBe(1)
    })
  })
})
