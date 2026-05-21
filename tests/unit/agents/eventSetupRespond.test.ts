import eventSetup, { buildEventSetupBlocks } from '../../../src/agents/eventSetup/eventSetup.js'
import { verifyHandoffToken } from '../../../src/services/handoffToken.service.js'
import config from '../../../src/config/config.js'

/* respond() accepts an optional third argument for the intent check function.
   Passing a stub here means these unit tests never touch a real LLM. The
   intent check itself has dedicated tests in intentCheck.test.ts. */
const alwaysSetupIntent = async () => true

/* respond() is unit-testable without a DB: it only reads
   this.conversation.channels and the userMessage shape. */
function buildContext() {
  return {
    agentConfig: { botName: 'Event Setup Bot' },
    conversation: {
      channels: [{ name: 'setup' }, { name: 'general' }]
    }
  }
}

function buildSlackMessage(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'user-msg-id-001',
    body: 'setup a new event',
    /* Slack identity lives in source — these fields survive DB persistence
       (unlike the transient user field, which is dropped after auth lookup). */
    source: { type: 'slack', id: '1700000000.000100', userId: 'U456DEF', teamId: 'T123ABC', channelId: 'C789GHI' },
    parentMessage: undefined,
    ...overrides
  }
}

/* Helper types for Block Kit shapes returned by buildEventSetupBlocks */
type Block = Record<string, unknown>
type ActionElement = { type: string; text: { text: string }; url: string }
type ActionsBlock = { type: 'actions'; elements: ActionElement[] }
type SectionBlock = { type: 'section'; text: { type: string; text: string } }

/* ─── buildEventSetupBlocks (pure function) ───────────────────────────────── */

describe('buildEventSetupBlocks()', () => {
  const url = 'https://nextspace.example.org/events/new#token=abc123'

  test('returns a section block with a mrkdwn user mention', () => {
    const blocks = buildEventSetupBlocks('U456DEF', url)
    const section = blocks.find((b): b is SectionBlock => (b as Block).type === 'section') as SectionBlock
    expect(section).toBeDefined()
    expect(section.text.type).toBe('mrkdwn')
    /* Slack renders <@USER_ID> as the user's display name */
    expect(section.text.text).toContain('<@U456DEF>')
  })

  test("returns an actions block with a Let's Go button", () => {
    const blocks = buildEventSetupBlocks('U456DEF', url)
    const actions = blocks.find((b): b is ActionsBlock => (b as Block).type === 'actions') as ActionsBlock
    expect(actions).toBeDefined()
    expect(actions.elements[0].type).toBe('button')
    expect(actions.elements[0].text.text).toBe("Let's Go")
  })

  test('button url matches the provided url exactly', () => {
    const blocks = buildEventSetupBlocks('U456DEF', url)
    const actions = blocks.find((b): b is ActionsBlock => (b as Block).type === 'actions') as ActionsBlock
    expect(actions.elements[0].url).toBe(url)
  })
})

/* ─── respond() ──────────────────────────────────────────────────────────── */

describe('eventSetup respond()', () => {
  test('returns a single message routed to the setup channel', async () => {
    const responses = await eventSetup.respond.call(
      buildContext(),
      { messages: [] },
      buildSlackMessage(),
      alwaysSetupIntent
    )

    expect(responses).toHaveLength(1)
    expect(responses[0].visible).toBe(true)
    expect(responses[0].messageType).toBe('text')
    expect(responses[0].channels.map((c: { name: string }) => c.name)).toContain('setup')
  })

  test('Slack-origin message: Block Kit button carries a verifiable token in the URL fragment', async () => {
    const msg = buildSlackMessage()
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, msg, alwaysSetupIntent)

    /* The token lives in the button URL (inside blocks), not in the fallback
       message text. Browsers never send URL fragments to servers, so placing
       the token after # keeps it out of Nextspace's access logs and Referer
       headers on any third-party resources the form page loads. The fallback
       text is for push notifications and accessibility — it does not need the
       token. */
    const { blocks } = responses[0]
    expect(blocks).toBeDefined()
    const actionsBlock = (blocks as Block[]).find((b): b is ActionsBlock => b.type === 'actions') as ActionsBlock
    expect(actionsBlock).toBeDefined()
    const buttonUrl: string = actionsBlock.elements[0].url
    expect(buttonUrl).toContain(`${config.appHost}/events/new#token=`)
    expect(buttonUrl).not.toContain(`${config.appHost}/events/new?token=`)

    const match = buttonUrl.match(/#token=([A-Za-z0-9._-]+)/)
    expect(match).not.toBeNull()
    const token = decodeURIComponent(match![1])

    const verified = verifyHandoffToken(token)
    expect(verified.slackUserId).toBe('U456DEF')
    expect(verified.slackTeamId).toBe('T123ABC')
    expect(verified.slackChannelId).toBe('C789GHI')
    expect(verified.slackThreadTs).toBe('1700000000.000100')
  })

  test('Slack-origin message: Block Kit section greets the user by Slack mention', async () => {
    const msg = buildSlackMessage()
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, msg, alwaysSetupIntent)

    const { blocks } = responses[0]
    const sectionBlock = (blocks as Block[]).find((b): b is SectionBlock => b.type === 'section') as SectionBlock
    expect(sectionBlock).toBeDefined()
    /* Slack renders <@U456DEF> as the user's display name in the UI */
    expect(sectionBlock.text.text).toContain('<@U456DEF>')
  })

  test('threads the reply under the user message when the user posted at top level', async () => {
    /* If the organizer's message has no parent thread, the bot's reply should
       start a new thread under that message. The Slack adapter sets thread_ts
       to the parent message's source.id, so the response parent needs to be
       the user's own _id when no existing thread exists. */
    const msg = buildSlackMessage({ parentMessage: undefined })
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, msg, alwaysSetupIntent)

    expect(responses[0].parent).toBe('user-msg-id-001')
  })

  test('preserves an existing thread when the user message is already a reply', async () => {
    const msg = buildSlackMessage({ parentMessage: 'existing-thread-root-id' })
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, msg, alwaysSetupIntent)

    expect(responses[0].parent).toBe('existing-thread-root-id')
  })

  test('non-Slack origin: falls back to a text-only message with the Nextspace URL, no blocks', async () => {
    const msg = buildSlackMessage({ source: { type: 'web', id: 'abc' } })
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, msg, alwaysSetupIntent)

    const text: string = responses[0].message
    expect(text).toContain(`${config.appHost}/events/new`)
    expect(text).not.toMatch(/token=/)
    /* No Block Kit blocks for non-Slack messages — other adapters don't
       understand Slack's block format. */
    expect(responses[0].blocks).toBeUndefined()
  })

  test.each([
    ['source.userId is missing', { source: { type: 'slack', id: '1700000000.000100', teamId: 'T123ABC', channelId: 'C789GHI' } }],
    ['source.teamId is missing', { source: { type: 'slack', id: '1700000000.000100', userId: 'U456DEF', channelId: 'C789GHI' } }],
    ['source.channelId is missing', { source: { type: 'slack', id: '1700000000.000100', userId: 'U456DEF', teamId: 'T123ABC' } }],
    ['source.id (thread ts) is missing', { source: { type: 'slack', userId: 'U456DEF', teamId: 'T123ABC', channelId: 'C789GHI' } }],
    ['source.type is not slack', { source: { type: 'web', id: '1700000000.000100', userId: 'U456DEF', teamId: 'T123ABC', channelId: 'C789GHI' } }]
  ])('Slack context but %s: falls back to text-only message without blocks', async (_label, override) => {
    const msg = buildSlackMessage(override)
    const responses = await eventSetup.respond.call(buildContext(), { messages: [] }, msg, alwaysSetupIntent)

    const text: string = responses[0].message
    expect(text).toContain(`${config.appHost}/events/new`)
    expect(text).not.toMatch(/token=/)
    expect(responses[0].blocks).toBeUndefined()
  })
})
