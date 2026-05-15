import setupIntTest from '../utils/setupIntTest.js'
import { User } from '../../src/models/index.js'
import userService from '../../src/services/user.service.js'
import config from '../../src/config/config.js'

setupIntTest()

describe('ensureSystemUsers()', () => {
  let originalSystemUsers: { username: string; role: string }[]

  beforeEach(() => {
    originalSystemUsers = config.systemUsers
  })

  afterEach(() => {
    config.systemUsers = originalSystemUsers
  })

  it('creates each account defined in config', async () => {
    config.systemUsers = [{ username: 'test-bot', role: 'serviceAccount' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user).not.toBeNull()
    expect(user!.role).toBe('serviceAccount')
  })

  it('creates accounts without a password', async () => {
    config.systemUsers = [{ username: 'test-bot', role: 'serviceAccount' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!.password).toBeFalsy()
  })

  it('creates multiple accounts when config has multiple entries', async () => {
    config.systemUsers = [
      { username: 'bot-one', role: 'serviceAccount' },
      { username: 'bot-two', role: 'serviceAccount' }
    ]

    await userService.ensureSystemUsers()

    const count = await User.countDocuments({ username: { $in: ['bot-one', 'bot-two'] } })
    expect(count).toBe(2)
  })

  it('does not create duplicate accounts on repeated calls', async () => {
    config.systemUsers = [{ username: 'test-bot', role: 'serviceAccount' }]

    await userService.ensureSystemUsers()
    await userService.ensureSystemUsers()

    const count = await User.countDocuments({ username: 'test-bot' })
    expect(count).toBe(1)
  })

  it('does not modify an existing account', async () => {
    const existing = await User.create({
      username: 'test-bot',
      role: 'serviceAccount',
      pseudonyms: [{ token: 'test-token', pseudonym: 'test-bot', active: true }]
    })
    config.systemUsers = [{ username: 'test-bot', role: 'serviceAccount' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!._id.toString()).toBe(existing._id.toString())
  })
})
