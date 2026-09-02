import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import Adapter from '../../../src/models/adapter.model.js'
import Conversation from '../../../src/models/conversation.model.js'
import { conversationAgentsEnabled, publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import findSlackAdapter from '../../../src/handlers/helpers/findSlackAdapter.js'

setupIntTest()

const makeAdapter = async (config: Record<string, unknown>) => {
  // A fresh _id per call: the shared fixture pins one, which collides when reused.
  const conversation = new Conversation({ ...conversationAgentsEnabled, _id: new mongoose.Types.ObjectId() })
  await conversation.save()
  // botToken and botUserId satisfy the Slack adapter's pre-save validation without calling out
  // to Slack's auth.test endpoint.
  return Adapter.create({
    type: 'slack',
    config: { botToken: 'xoxb-test', botUserId: 'U_TEST', ...config },
    conversation: conversation._id,
    active: true
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
    const dm = await makeAdapter({ channel: 'direct', workspace: 'T1' })

    const found = await findSlackAdapter({
      payload: { event: { type: 'message', channel_type: 'im', channel: 'D123', team: 'T1' } }
    })
    expect(found?._id.toString()).toBe(dm._id.toString())
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

  it('returns null when there is no event on the payload', async () => {
    const found = await findSlackAdapter({ payload: {} })
    expect(found).toBeNull()
  })
})
