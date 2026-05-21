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
    _id: 'user-msg-id-001',
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
    /* The token must be in the URL fragment (after #), not the query
       string (after ?). Browsers do not send URL fragments to servers,
       so this keeps the token out of Nextspace's server access logs and
       out of the Referer header on any third-party resource the form
       page loads. */
    expect(text).toContain(`${config.appHost}/events/new#token=`)
    expect(text).not.toContain(`${config.appHost}/events/new?token=`)

    const match = text.match(/#token=([A-Za-z0-9._-]+)/)
    expect(match).not.toBeNull()
    const token = decodeURIComponent(match![1])

    const verified = verifyHandoffToken(token)
    expect(verified.slackUserId).toBe('U456DEF')
    expect(verified.slackTeamId).toBe('T123ABC')
    expect(verified.slackChannelId).toBe('C789GHI')
    expect(verified.slackThreadTs).toBe('1700000000.000100')
  })

  test('threads the reply under the user message when the user posted at top level', async () => {
    /* If the organizer's message itself has no parent, the bot's reply
       should start a new thread under that message rather than landing
       back in the main channel. The Slack adapter does this by setting
       thread_ts to the parent message's source.id, so we need to set our
       response's parent to the user's own _id when no existing thread
       exists. */
    const msg = buildSlackMessage({ parentMessage: undefined })
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, msg)

    expect(responses[0].parent).toBe('user-msg-id-001')
  })

  test('preserves an existing thread when the user message is already a reply', async () => {
    const msg = buildSlackMessage({ parentMessage: 'existing-thread-root-id' })
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, msg)

    expect(responses[0].parent).toBe('existing-thread-root-id')
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
