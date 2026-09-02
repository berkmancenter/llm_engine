import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import Adapter from '../../../src/models/adapter.model.js'
import Conversation from '../../../src/models/conversation.model.js'
import { conversationAgentsEnabled, publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import findSlackAdapter from '../../../src/handlers/helpers/findSlackAdapter.js'

setupIntTest()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeAdapter = async ({ dmChannels, active = true, ...config }: Record<string, any>) => {
  // A fresh _id per call: the shared fixture pins one, which collides when reused.
  const conversation = new Conversation({ ...conversationAgentsEnabled, _id: new mongoose.Types.ObjectId() })
  await conversation.save()
  // botToken and botUserId satisfy the Slack adapter's pre-save validation without calling out
  // to Slack's auth.test endpoint.
  return Adapter.create({
    type: 'slack',
    config: { botToken: 'xoxb-test', botUserId: 'U_TEST', ...config },
    ...(dmChannels && { dmChannels }),
    conversation: conversation._id,
    active
  })
}

describe('findSlackAdapter', () => {
  beforeEach(async () => {
    await insertTopics([publicTopic])
  })

  it('resolves by appKey+workspace+channel when provided and a match exists', async () => {
    await makeAdapter({ channel: 'C_OTHER', workspace: 'T1', appKey: 'berkie' })
    const va = await makeAdapter({ channel: 'C_VA', workspace: 'T1', appKey: 'va' })

    const found = await findSlackAdapter({
      appKey: 'va',
      payload: { event: { type: 'message', channel: 'C_VA', team: 'T1' } }
    })
    expect(found?._id.toString()).toBe(va._id.toString())
  })

  it('routes the same app to different conversations by channel when appKey is present', async () => {
    const channelA = await makeAdapter({ channel: 'C_A', workspace: 'T1', appKey: 'myapp' })
    const channelB = await makeAdapter({ channel: 'C_B', workspace: 'T1', appKey: 'myapp' })

    const foundA = await findSlackAdapter({
      appKey: 'myapp',
      payload: { event: { type: 'message', channel: 'C_A', team: 'T1' } }
    })
    const foundB = await findSlackAdapter({
      appKey: 'myapp',
      payload: { event: { type: 'message', channel: 'C_B', team: 'T1' } }
    })

    expect(foundA?._id.toString()).toBe(channelA._id.toString())
    expect(foundB?._id.toString()).toBe(channelB._id.toString())
  })

  it('falls back to workspace+channel when no appKey is provided', async () => {
    const berkie = await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      payload: { event: { type: 'message', channel: 'C123', team: 'T1' } }
    })
    expect(found?._id.toString()).toBe(berkie._id.toString())
  })

  it('resolves the workspace DM adapter when the event is an im', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1' })
    const dm = await makeAdapter({ channel: 'C123', workspace: 'T1', dmChannels: [{ direct: true, direction: 'both' }] })

    const found = await findSlackAdapter({
      payload: { event: { type: 'message', channel_type: 'im', channel: 'D_USER123', team: 'T1' } }
    })
    expect(found?._id.toString()).toBe(dm._id.toString())
  })

  it('resolves DM adapter by appKey+workspace when appKey is present', async () => {
    await makeAdapter({ channel: 'C_A', workspace: 'T1', appKey: 'app1' })
    const dm = await makeAdapter({
      channel: 'C_A',
      workspace: 'T1',
      appKey: 'app1',
      dmChannels: [{ direct: true, direction: 'both' }]
    })
    await makeAdapter({ channel: 'C_B', workspace: 'T1', appKey: 'app2', dmChannels: [{ direct: true, direction: 'both' }] })

    const found = await findSlackAdapter({
      appKey: 'app1',
      payload: { event: { type: 'message', channel_type: 'im', channel: 'D_USER123', team: 'T1' } }
    })
    expect(found?._id.toString()).toBe(dm._id.toString())
  })

  it('returns null for a DM when no adapter has dmChannels for the workspace', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      payload: { event: { type: 'message', channel_type: 'im', channel: 'D_USER123', team: 'T1' } }
    })
    expect(found).toBeNull()
  })

  it('returns null when the appKey matches but the event came from a different workspace', async () => {
    await makeAdapter({ channel: 'C_VA', workspace: 'W_VA', appKey: 'va' })

    const found = await findSlackAdapter({
      appKey: 'va',
      payload: { event: { type: 'message', channel: 'C_VA', team: 'W_DIFFERENT' } }
    })
    expect(found).toBeNull()
  })

  it('returns null when appKey is provided but no matching row exists', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      appKey: 'nonexistent',
      payload: { event: { type: 'message', channel: 'C123', team: 'T1' } }
    })
    expect(found).toBeNull()
  })

  it('returns null when appKey is provided but workspace or channel is missing from the payload', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1', appKey: 'myapp' })

    const found = await findSlackAdapter({
      appKey: 'myapp',
      payload: { event: { team: 'T1' } }
    })
    expect(found).toBeNull()
  })

  it('returns null when nothing matches', async () => {
    const found = await findSlackAdapter({
      payload: { event: { type: 'message', channel: 'C_MISSING', team: 'T_MISSING' } }
    })
    expect(found).toBeNull()
  })

  it('resolves workspace from outer team_id when event.team is absent (e.g. subtype events)', async () => {
    const adapter = await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      payload: { team_id: 'T1', event: { type: 'message', channel: 'C123' } }
    })
    expect(found?._id.toString()).toBe(adapter._id.toString())
  })

  it('prefers outer team_id over event.team when both are present', async () => {
    const adapter = await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      payload: { team_id: 'T1', event: { type: 'message', channel: 'C123', team: 'T_WRONG' } }
    })
    expect(found?._id.toString()).toBe(adapter._id.toString())
  })

  it('returns null when there is no event on the payload', async () => {
    const found = await findSlackAdapter({ payload: {} })
    expect(found).toBeNull()
  })

  it('does not match an inactive appKey adapter for a group chat message', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1', appKey: 'myapp', active: false })

    const found = await findSlackAdapter({
      appKey: 'myapp',
      payload: { event: { type: 'message', channel: 'C123', team: 'T1' } }
    })
    expect(found).toBeNull()
  })

  it('does not match an inactive appKey DM adapter', async () => {
    await makeAdapter({
      channel: 'C123',
      workspace: 'T1',
      appKey: 'myapp',
      active: false,
      dmChannels: [{ direct: true, direction: 'both' }]
    })

    const found = await findSlackAdapter({
      appKey: 'myapp',
      payload: { event: { type: 'message', channel_type: 'im', channel: 'D_USER123', team: 'T1' } }
    })
    expect(found).toBeNull()
  })

  it('returns null when appKey is set but workspace is missing — no unsafe fallback', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1', appKey: 'myapp' })

    const found = await findSlackAdapter({
      appKey: 'myapp',
      payload: { event: { type: 'message', channel: 'C123' } }
    })
    expect(found).toBeNull()
  })
})
