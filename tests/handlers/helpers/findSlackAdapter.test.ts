import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import Adapter from '../../../src/models/adapter.model.js'
import Conversation from '../../../src/models/conversation.model.js'
import { conversationAgentsEnabled, publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import findSlackAdapter from '../../../src/handlers/helpers/findSlackAdapter.js'

setupIntTest()

const makeAdapter = async (config: Record<string, unknown>) => {
  // Fresh _id per call: the shared fixture pins one, which collides when used twice.
  const conversation = new Conversation({ ...conversationAgentsEnabled, _id: new mongoose.Types.ObjectId() })
  await conversation.save()
  // botToken + botUserId satisfy the slack adapter pre-validate hook without hitting Slack.
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

  it('resolves by appKey when provided and a match exists', async () => {
    await makeAdapter({ channel: 'C_OTHER', workspace: 'T1', appKey: 'berkie' })
    const va = await makeAdapter({ channel: 'C_VA', workspace: 'T1', appKey: 'va' })

    const found = await findSlackAdapter({ appKey: 'va', payload: { event: {} } })
    expect(found?._id.toString()).toBe(va._id.toString())
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

  it('falls back to workspace+channel when appKey is provided but not found', async () => {
    const berkie = await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      appKey: 'nonexistent',
      payload: { event: { type: 'message', channel: 'C123', team: 'T1' } }
    })
    expect(found?._id.toString()).toBe(berkie._id.toString())
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
