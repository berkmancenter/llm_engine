import eventSetup from '../../../src/agents/eventSetup/eventSetup.js'
import { verifyHandoffToken } from '../../../src/services/handoffToken.service.js'
import config from '../../../src/config/config.js'

/* The event-setup respond() function is unit-testable without a DB: it only
   reads this.conversation.channels and the userMessage shape. We mock both. */
function buildContext() {
  return {
    conversation: {
      channels: [{ name: 'setup' }, { name: 'general' }]
    }
  }
}

function buildSlackMessage(overrides: Record<string, unknown> = {}) {
  return {
    body: 'setup a new event',
    source: { type: 'slack', id: '1700000000.000100' },
    user: { username: 'T123ABC-U456DEF', pseudonym: 'U456DEF' },
    channels: [{ name: 'C789GHI' }],
    parentMessage: undefined,
    ...overrides
  }
}

describe('eventSetup respond()', () => {
  test('returns a single message routed to the setup channel', async () => {
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, buildSlackMessage())

    expect(responses).toHaveLength(1)
    expect(responses[0].visible).toBe(true)
    expect(responses[0].messageType).toBe('text')
    expect(responses[0].channels.map((c) => c.name)).toContain('setup')
  })

  test('Slack-origin message: posts a Nextspace handoff URL with a verifiable token', async () => {
    const msg = buildSlackMessage()
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, msg)

    const text: string = responses[0].message
    /* The URL we tell the organizer to open must point at the configured
       Nextspace host and include the handoff token as a query param. */
    expect(text).toContain(`${config.appHost}/events/new?token=`)

    const match = text.match(/token=([A-Za-z0-9._-]+)/)
    expect(match).not.toBeNull()
    const token = decodeURIComponent(match![1])

    const verified = verifyHandoffToken(token)
    expect(verified.slackUserId).toBe('U456DEF')
    expect(verified.slackTeamId).toBe('T123ABC')
    expect(verified.slackChannelId).toBe('C789GHI')
    expect(verified.slackThreadTs).toBe('1700000000.000100')
  })

  test('non-Slack origin: falls back to a generic Nextspace URL without a token', async () => {
    const msg = buildSlackMessage({
      source: { type: 'web', id: 'abc' },
      user: { username: 'alice', pseudonym: 'alice' }
    })
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, msg)

    const text: string = responses[0].message
    expect(text).toContain(`${config.appHost}/events/new`)
    expect(text).not.toMatch(/token=/)
  })

  test.each([
    ['user is missing entirely', { user: undefined }],
    ['username has no dash separator', { user: { username: 'alice', pseudonym: 'alice' } }],
    ['username is empty string', { user: { username: '', pseudonym: '' } }],
    ['channels array is empty', { channels: [] }],
    ['source.id is missing', { source: { type: 'slack' } }]
  ])('Slack origin but %s: falls back without minting a token', async (_label, override) => {
    const msg = buildSlackMessage(override)
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, msg)

    const text: string = responses[0].message
    expect(text).toContain(`${config.appHost}/events/new`)
    expect(text).not.toMatch(/token=/)
  })
})
