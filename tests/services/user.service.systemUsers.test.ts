import setupIntTest from '../utils/setupIntTest.js'
import { User, Token } from '../../src/models/index.js'
import userService from '../../src/services/user.service.js'
import tokenService from '../../src/services/token.service.js'
import tokenTypes from '../../src/config/tokens.js'
import config from '../../src/config/config.js'
import logger from '../../src/config/logger.js'

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

  // These are real login credentials on the same /v1/auth/login endpoint as everyone else, so
  // they're held to the same floor human registration/reset enforce (see custom.validation.ts).
  it('throws and creates no accounts when a configured password is too short', async () => {
    config.systemUsers = [{ username: 'test-bot', password: 'weak' }]

    await expect(userService.ensureSystemUsers()).rejects.toThrow(/password for "test-bot" is invalid/)

    const user = await User.findOne({ username: 'test-bot' })
    expect(user).toBeNull()
  })

  it('throws for a configured password missing a digit or letter', async () => {
    config.systemUsers = [{ username: 'test-bot', password: 'onlyletters' }]

    await expect(userService.ensureSystemUsers()).rejects.toThrow(/must contain at least 1 letter and 1 number/)
  })

  it('validates every configured password before touching any account (atomic, no partial sync)', async () => {
    config.systemUsers = [
      { username: 'bot-one', password: 'strongpass1' },
      { username: 'bot-two', password: 'weak' }
    ]

    await expect(userService.ensureSystemUsers()).rejects.toThrow(/password for "bot-two" is invalid/)

    expect(await User.findOne({ username: 'bot-one' })).toBeNull()
  })

  it('throws for a configured role that is not in the roles enum', async () => {
    config.systemUsers = [{ username: 'test-bot', role: 'serviceAccount' }]

    await expect(userService.ensureSystemUsers()).rejects.toThrow(/role "serviceAccount" for "test-bot" is invalid/)

    expect(await User.findOne({ username: 'test-bot' })).toBeNull()
  })

  it('validates every configured role before touching any account (atomic, no partial sync)', async () => {
    config.systemUsers = [
      { username: 'bot-one', role: 'admin' },
      { username: 'bot-two', role: 'bogus' }
    ]

    await expect(userService.ensureSystemUsers()).rejects.toThrow(/role "bogus" for "bot-two" is invalid/)

    expect(await User.findOne({ username: 'bot-one' })).toBeNull()
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
      systemAccount: true,
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
      systemAccount: true,
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
      systemAccount: true,
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
      systemAccount: true,
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

  it('does not write to an existing account at all when config is unchanged', async () => {
    config.systemUsers = [{ username: 'test-bot', role: 'admin', password: 'samepass1' }]
    await userService.ensureSystemUsers()

    const saveSpy = jest.spyOn(User.prototype, 'save')
    await userService.ensureSystemUsers()

    expect(saveSpy).not.toHaveBeenCalled()
    saveSpy.mockRestore()
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

  it('deletes outstanding refresh tokens when a password is rotated', async () => {
    config.systemUsers = [{ username: 'test-bot', password: 'startpass1' }]
    await userService.ensureSystemUsers()
    const user = (await User.findOne({ username: 'test-bot' }))!
    await tokenService.generateAuthTokens(user)
    expect(await Token.countDocuments({ user: user._id, type: tokenTypes.REFRESH })).toBe(1)

    config.systemUsers = [{ username: 'test-bot', password: 'rotatedpass1' }]
    await userService.ensureSystemUsers()

    expect(await Token.countDocuments({ user: user._id, type: tokenTypes.REFRESH })).toBe(0)
  })

  it('deletes outstanding refresh tokens when a password is cleared', async () => {
    config.systemUsers = [{ username: 'test-bot', password: 'startpass1' }]
    await userService.ensureSystemUsers()
    const user = (await User.findOne({ username: 'test-bot' }))!
    await tokenService.generateAuthTokens(user)

    config.systemUsers = [{ username: 'test-bot' }]
    await userService.ensureSystemUsers()

    expect(await Token.countDocuments({ user: user._id, type: tokenTypes.REFRESH })).toBe(0)
  })

  it('leaves outstanding refresh tokens alone when only the role changes', async () => {
    config.systemUsers = [{ username: 'test-bot', password: 'startpass1' }]
    await userService.ensureSystemUsers()
    const user = (await User.findOne({ username: 'test-bot' }))!
    await tokenService.generateAuthTokens(user)

    config.systemUsers = [{ username: 'test-bot', role: 'admin', password: 'startpass1' }]
    await userService.ensureSystemUsers()

    expect(await Token.countDocuments({ user: user._id, type: tokenTypes.REFRESH })).toBe(1)
  })

  it('refuses to sync a username collision onto a pre-existing non-system account', async () => {
    const human = await User.create({
      username: 'collision-bot',
      role: 'participant',
      password: await userService.hashPassword('humanpass1'),
      pseudonyms: [{ token: 'test-token', pseudonym: 'collision-bot', active: true }]
    })
    config.systemUsers = [{ username: 'collision-bot', role: 'admin', password: 'newpass123' }]

    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger)
    await userService.ensureSystemUsers()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('collision-bot'))
    errorSpy.mockRestore()

    const user = await User.findOne({ username: 'collision-bot' })
    expect(user!._id.toString()).toBe(human._id.toString())
    expect(user!.systemAccount).toBeFalsy()
    expect(user!.role).toBe('participant')
    expect(await userService.getUserByUsernamePassword('collision-bot', 'humanpass1')).not.toBeNull()
    expect(await userService.getUserByUsernamePassword('collision-bot', 'newpass123')).toBeNull()
  })
})
