import { parseSystemUsersEnv } from '../../../src/config/config.js'

describe('parseSystemUsersEnv()', () => {
  it('returns an empty array for an empty string', () => {
    expect(parseSystemUsersEnv('')).toEqual([])
  })

  it('parses a single username:role:password entry', () => {
    expect(parseSystemUsersEnv('my-bot::secret123')).toEqual([{ username: 'my-bot', password: 'secret123' }])
  })

  it('parses a bare username with no role or password', () => {
    expect(parseSystemUsersEnv('my-bot')).toEqual([{ username: 'my-bot' }])
  })

  it('parses multiple semicolon-separated entries with mixed shapes', () => {
    expect(parseSystemUsersEnv('bot-one;bot-two:admin;bot-three::pass1234')).toEqual([
      { username: 'bot-one' },
      { username: 'bot-two', role: 'admin' },
      { username: 'bot-three', password: 'pass1234' }
    ])
  })

  it('trims whitespace around entries and skips empty ones', () => {
    expect(parseSystemUsersEnv(' bot-one ; ; bot-two:admin ')).toEqual([
      { username: 'bot-one' },
      { username: 'bot-two', role: 'admin' }
    ])
  })

  it('does not split a password containing a comma', () => {
    expect(parseSystemUsersEnv('bot:admin:pa,ss1234')).toEqual([{ username: 'bot', role: 'admin', password: 'pa,ss1234' }])
  })

  it('does not truncate a password containing a colon', () => {
    expect(parseSystemUsersEnv('my-bot:admin:pa:ss1234')).toEqual([
      { username: 'my-bot', role: 'admin', password: 'pa:ss1234' }
    ])
  })

  it('does not judge password strength — that is ensureSystemUsers concern, not parsing', () => {
    expect(parseSystemUsersEnv('bad-bot::weak')).toEqual([{ username: 'bad-bot', password: 'weak' }])
  })
})
