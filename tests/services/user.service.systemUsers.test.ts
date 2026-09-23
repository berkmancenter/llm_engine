import setupIntTest from '../utils/setupIntTest.js'
import { User } from '../../src/models/index.js'
import userService from '../../src/services/user.service.js'
import config from '../../src/config/config.js'

setupIntTest()

describe('ensureSystemUsers()', () => {
  let originalSystemUsers: { username: string; role?: string; password?: string }[]

  beforeEach(() => {
    originalSystemUsers = config.systemUsers
  })

  afterEach(() => {
    config.systemUsers = originalSystemUsers
  })

  it('creates each account defined in config', async () => {
    config.systemUsers = [{ username: 'test-bot' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user).not.toBeNull()
  })

  it('marks a newly created account as a system account', async () => {
    config.systemUsers = [{ username: 'test-bot' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!.systemAccount).toBe(true)
  })

  it('creates a new account with no role, not defaulted to participant', async () => {
    config.systemUsers = [{ username: 'test-bot' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!.role).toBeFalsy()
  })

  it('creates an account with the configured role', async () => {
    config.systemUsers = [{ username: 'test-bot', role: 'admin' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!.role).toBe('admin')
  })

  it('creates accounts without a password when none is configured', async () => {
    config.systemUsers = [{ username: 'test-bot' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!.password).toBeFalsy()
  })

  it('creates an account with a hashed password when one is configured', async () => {
    config.systemUsers = [{ username: 'test-bot', password: 'startpass1' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!.password).toBeTruthy()
    expect(user!.password).not.toBe('startpass1')
  })

  it('creates multiple accounts when config has multiple entries', async () => {
    config.systemUsers = [{ username: 'bot-one' }, { username: 'bot-two' }]

    await userService.ensureSystemUsers()

    const count = await User.countDocuments({ username: { $in: ['bot-one', 'bot-two'] } })
    expect(count).toBe(2)
  })

  it('does not create duplicate accounts on repeated calls', async () => {
    config.systemUsers = [{ username: 'test-bot' }]

    await userService.ensureSystemUsers()
    await userService.ensureSystemUsers()

    const count = await User.countDocuments({ username: 'test-bot' })
    expect(count).toBe(1)
  })

  it('preserves the existing account identity when config is unchanged', async () => {
    const existing = await User.create({
      username: 'test-bot',
      pseudonyms: [{ token: 'test-token', pseudonym: 'test-bot', active: true }]
    })
    config.systemUsers = [{ username: 'test-bot' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!._id.toString()).toBe(existing._id.toString())
  })

  it('updates the role on an existing account when config changes', async () => {
    await User.create({
      username: 'test-bot',
      role: 'participant',
      pseudonyms: [{ token: 'test-token', pseudonym: 'test-bot', active: true }]
    })
    config.systemUsers = [{ username: 'test-bot', role: 'admin' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!.role).toBe('admin')
  })

  it('clears the role on an existing account when config drops it', async () => {
    await User.create({
      username: 'test-bot',
      role: 'admin',
      pseudonyms: [{ token: 'test-token', pseudonym: 'test-bot', active: true }]
    })
    config.systemUsers = [{ username: 'test-bot' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!.role).toBeFalsy()
  })

  it('sets a password on an existing passwordless account when config adds one', async () => {
    await User.create({
      username: 'test-bot',
      pseudonyms: [{ token: 'test-token', pseudonym: 'test-bot', active: true }]
    })
    config.systemUsers = [{ username: 'test-bot', password: 'newpass123' }]

    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!.password).toBeTruthy()
    expect(await userService.getUserByUsernamePassword('test-bot', 'newpass123')).not.toBeNull()
  })

  it('updates the password on an existing account when it changes in config', async () => {
    config.systemUsers = [{ username: 'test-bot', password: 'startpass1' }]
    await userService.ensureSystemUsers()

    config.systemUsers = [{ username: 'test-bot', password: 'rotatedpass1' }]
    await userService.ensureSystemUsers()

    expect(await userService.getUserByUsernamePassword('test-bot', 'startpass1')).toBeNull()
    expect(await userService.getUserByUsernamePassword('test-bot', 'rotatedpass1')).not.toBeNull()
  })

  it('leaves the password untouched on an existing account when config is unchanged', async () => {
    config.systemUsers = [{ username: 'test-bot', password: 'samepass1' }]
    await userService.ensureSystemUsers()
    const beforeHash = (await User.findOne({ username: 'test-bot' }))!.password

    await userService.ensureSystemUsers()

    const afterHash = (await User.findOne({ username: 'test-bot' }))!.password
    expect(afterHash).toBe(beforeHash)
  })

  it('clears the password on an existing account when config drops it', async () => {
    config.systemUsers = [{ username: 'test-bot', password: 'startpass1' }]
    await userService.ensureSystemUsers()

    config.systemUsers = [{ username: 'test-bot' }]
    await userService.ensureSystemUsers()

    const user = await User.findOne({ username: 'test-bot' })
    expect(user!.password).toBeFalsy()
    expect(await userService.getUserByUsernamePassword('test-bot', 'startpass1')).toBeNull()
  })
})
