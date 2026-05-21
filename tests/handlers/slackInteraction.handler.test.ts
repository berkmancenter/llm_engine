import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import slackInteractionHandler from '../../src/handlers/slackInteraction.js'
import Adapter from '../../src/models/adapter.model.js'
import webhookService from '../../src/services/webhook.service.js'

setupIntTest()

// Minimal mock adapter — just needs to look like a Mongoose doc
const mockAdapter = {
  _id: new mongoose.Types.ObjectId(),
  type: 'slack',
  config: { channel: 'C1234567890', workspace: '123456' }
}

// Builds a minimal valid block_actions payload. Override any field to test edge cases.
function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'block_actions',
    team: { id: '123456' },
    channel: { id: 'C1234567890' },
    user: { id: 'U1234567890' },
    actions: [{ action_id: 'confirm', value: 'yes' }],
    message: { ts: '1234567890.123456' },
    response_url: 'https://hooks.slack.com/actions/T123/B123/xyz',
    ...overrides
  }
}

describe('slackInteraction handler — receiveInteraction()', () => {
  let findOneSpy
  let receiveMessageSpy

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findOneSpy = jest.spyOn(Adapter, 'findOne').mockResolvedValue(mockAdapter as any)
    receiveMessageSpy = jest.spyOn(webhookService, 'receiveMessage').mockResolvedValue()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('feeds a button click into the message pipeline as a synthetic message event', async () => {
    await slackInteractionHandler.receiveInteraction(makePayload())

    expect(receiveMessageSpy).toHaveBeenCalledTimes(1)
    expect(receiveMessageSpy).toHaveBeenCalledWith(
      mockAdapter,
      expect.objectContaining({
        type: 'message',
        text: 'yes',
        team: '123456',
        user: 'U1234567890',
        channel: 'C1234567890'
      })
    )
  })

  it('skips processing when no meaningful value can be extracted from the action', async () => {
    const payload = makePayload({ actions: [{ action_id: 'my_action' }] })
    await slackInteractionHandler.receiveInteraction(payload)

    expect(receiveMessageSpy).not.toHaveBeenCalled()
  })

  it('extracts the selected value from a select menu or overflow action', async () => {
    const payload = makePayload({ actions: [{ action_id: 'pick_topic', selected_option: { value: 'topic_climate' } }] })
    await slackInteractionHandler.receiveInteraction(payload)

    expect(receiveMessageSpy).toHaveBeenCalledWith(mockAdapter, expect.objectContaining({ text: 'topic_climate' }))
  })

  it('extracts comma-separated values from a multi-select or checkboxes action', async () => {
    const payload = makePayload({
      actions: [{ action_id: 'pick_days', selected_options: [{ value: 'mon' }, { value: 'wed' }, { value: 'fri' }] }]
    })
    await slackInteractionHandler.receiveInteraction(payload)

    expect(receiveMessageSpy).toHaveBeenCalledWith(mockAdapter, expect.objectContaining({ text: 'mon,wed,fri' }))
  })

  it('extracts the selected date from a date picker action', async () => {
    const payload = makePayload({ actions: [{ action_id: 'pick_date', selected_date: '2026-06-15' }] })
    await slackInteractionHandler.receiveInteraction(payload)

    expect(receiveMessageSpy).toHaveBeenCalledWith(mockAdapter, expect.objectContaining({ text: '2026-06-15' }))
  })

  it('extracts the selected time from a time picker action', async () => {
    const payload = makePayload({ actions: [{ action_id: 'pick_time', selected_time: '14:30' }] })
    await slackInteractionHandler.receiveInteraction(payload)

    expect(receiveMessageSpy).toHaveBeenCalledWith(mockAdapter, expect.objectContaining({ text: '14:30' }))
  })

  it('looks up the "direct" channel adapter for DM button clicks (Slack DM IDs start with D)', async () => {
    const payload = makePayload({ channel: { id: 'D1234567890' } })
    await slackInteractionHandler.receiveInteraction(payload)

    expect(findOneSpy).toHaveBeenCalledWith(expect.objectContaining({ 'config.channel': 'direct' }))
    expect(receiveMessageSpy).toHaveBeenCalledWith(mockAdapter, expect.objectContaining({ channel_type: 'im' }))
  })

  it('uses container.channel_id as fallback when payload.channel is null (e.g. modal context)', async () => {
    const payload = makePayload({ channel: null, container: { channel_id: 'C9999999999' } })
    await slackInteractionHandler.receiveInteraction(payload)

    expect(findOneSpy).toHaveBeenCalledWith(expect.objectContaining({ 'config.channel': 'C9999999999' }))
  })

  it('skips processing when neither payload.channel nor container.channel_id is set', async () => {
    const payload = makePayload({ channel: null })
    await slackInteractionHandler.receiveInteraction(payload)

    expect(receiveMessageSpy).not.toHaveBeenCalled()
  })

  it('skips processing when the block_actions payload has no actions array entries', async () => {
    const payload = makePayload({ actions: [] })
    await slackInteractionHandler.receiveInteraction(payload)

    expect(receiveMessageSpy).not.toHaveBeenCalled()
  })

  it('throws a 404 error when no Slack adapter matches the workspace and channel', async () => {
    findOneSpy.mockResolvedValue(null)
    await expect(slackInteractionHandler.receiveInteraction(makePayload())).rejects.toThrow('Slack adapter not found')
  })

  it('omits thread_ts on the synthetic event when the original message timestamp is not in the payload', async () => {
    const payload = makePayload({ message: undefined })
    await slackInteractionHandler.receiveInteraction(payload)

    const syntheticEvent = receiveMessageSpy.mock.calls[0][1]
    expect(syntheticEvent).not.toHaveProperty('thread_ts')
  })

  it('uses message.thread_ts as the thread anchor when present (button on a bot reply, not the root)', async () => {
    /* When a bot reply carries buttons, payload.message.ts is the bot reply ts
       but payload.message.thread_ts is the actual thread root ts. We must use
       the root so synthetic events are parented correctly. */
    const payload = makePayload({ message: { ts: '111.222', thread_ts: '999.000' } })
    await slackInteractionHandler.receiveInteraction(payload)

    const syntheticEvent = receiveMessageSpy.mock.calls[0][1]
    expect(syntheticEvent.thread_ts).toBe('999.000')
  })

  it('falls back to message.ts when thread_ts is absent (button on a root message)', async () => {
    const payload = makePayload({ message: { ts: '1234567890.123456' } })
    await slackInteractionHandler.receiveInteraction(payload)

    const syntheticEvent = receiveMessageSpy.mock.calls[0][1]
    expect(syntheticEvent.thread_ts).toBe('1234567890.123456')
  })

  it('passes response_url through so the agent can send a deferred loading or follow-up message', async () => {
    await slackInteractionHandler.receiveInteraction(makePayload())

    const syntheticEvent = receiveMessageSpy.mock.calls[0][1]
    expect(syntheticEvent.response_url).toBe('https://hooks.slack.com/actions/T123/B123/xyz')
  })
})
