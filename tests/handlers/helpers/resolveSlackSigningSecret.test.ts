import config from '../../../src/config/config.js'
import resolveSlackSigningSecret from '../../../src/handlers/helpers/resolveSlackSigningSecret.js'

describe('resolveSlackSigningSecret', () => {
  let originalEnvSecret: string

  beforeAll(() => {
    originalEnvSecret = config.slack.signingSecret
  })

  afterAll(() => {
    config.slack.signingSecret = originalEnvSecret
  })

  it('returns the adapter-specific secret when set', () => {
    config.slack.signingSecret = 'env-secret'
    const adapter = { config: { signingSecret: 'per-adapter-secret' } }
    expect(resolveSlackSigningSecret(adapter)).toBe('per-adapter-secret')
  })

  it('falls back to the global env secret when the adapter has none', () => {
    config.slack.signingSecret = 'env-secret'
    const adapter = { config: {} }
    expect(resolveSlackSigningSecret(adapter)).toBe('env-secret')
  })

  it('falls back when the adapter has no config at all', () => {
    config.slack.signingSecret = 'env-secret'
    const adapter = {}
    expect(resolveSlackSigningSecret(adapter)).toBe('env-secret')
  })

  it('throws when neither adapter nor env secret is available', () => {
    config.slack.signingSecret = ''
    const adapter = { config: {} }
    expect(() => resolveSlackSigningSecret(adapter)).toThrow(/signing secret/i)
  })
})
