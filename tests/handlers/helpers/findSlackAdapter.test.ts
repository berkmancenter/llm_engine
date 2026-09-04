import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import Adapter from '../../../src/models/adapter.model.js'
import Conversation from '../../../src/models/conversation.model.js'
import { conversationAgentsEnabled, publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import findSlackAdapter, { findSlackAppHomeAdapter } from '../../../src/handlers/helpers/findSlackAdapter.js'
import Agent from '../../../src/models/user.model/agent.model/index.js'

setupIntTest()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeAdapter = async ({ dmChannels, active = true, ...config }: Record<string, any>) => {
  // A fresh _id per call: the shared fixture pins one, which collides when reused.
  const conversation = new Conversation({ ...conversationAgentsEnabled, _id: new mongoose.Types.ObjectId() })
  await conversation.save()
  return conversation
}

const makeAdapter = async (config: Record<string, unknown>) => {
  const conversation = await makeConversation()
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

/* Same as makeAdapter, but the conversation also runs an agent, since the App Home lookup
   picks between adapter rows by which one serves the community assistant. Only agentType is
   needed: the agent schema's pre-validate hook fills the rest from that type's defaults. */
const makeAppHomeAdapter = async (config: Record<string, unknown>, agentType = 'communityAssistant') => {
  const conversation = await makeConversation()
  const agent = new Agent({ agentType, conversation: conversation._id })
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  return Adapter.create({
    type: 'slack',
    config: { botToken: 'xoxb-test', botUserId: 'U_TEST', ...config },
    ...(dmChannels && { dmChannels }),
    conversation: conversation._id,
    active
  })
}

/* Same as makeAdapter, but the conversation also runs an agent, since the App Home lookup
   picks between adapter rows by which one serves the community assistant. Only agentType is
   needed: the agent schema's pre-validate hook fills the rest from that type's defaults. */
const makeAppHomeAdapter = async (config: Record<string, unknown>, agentType = 'communityAssistant') => {
  const conversation = await makeConversation()
  const agent = new Agent({ agentType, conversation: conversation._id })
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
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

  it('resolves by appKey alone for url_verification (no workspace in payload)', async () => {
    const adapter = await makeAdapter({ channel: 'C123', workspace: 'T1', appKey: 'myapp' })

    const found = await findSlackAdapter({
      appKey: 'myapp',
      payload: { type: 'url_verification' }
    })
    expect(found?._id.toString()).toBe(adapter._id.toString())
  })

  it('returns null for url_verification when no adapter matches the appKey', async () => {
    const found = await findSlackAdapter({
      appKey: 'nonexistent',
      payload: { type: 'url_verification' }
    })
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

  it('resolves by appKey alone for url_verification (no workspace in payload)', async () => {
    const adapter = await makeAdapter({ channel: 'C123', workspace: 'T1', appKey: 'myapp' })

    const found = await findSlackAdapter({
      appKey: 'myapp',
      payload: { type: 'url_verification' }
    })
    expect(found?._id.toString()).toBe(adapter._id.toString())
  })

  it('returns null for url_verification when no adapter matches the appKey', async () => {
    const found = await findSlackAdapter({
      appKey: 'nonexistent',
      payload: { type: 'url_verification' }
    })
    expect(found).toBeNull()
  })
})

/* An app_home_opened payload identifies itself differently from a message: the workspace
   sits at the top level as team_id rather than on the event, and the bot's own user id
   arrives under authorizations. The Home tab also belongs to the whole Slack app rather
   than one channel, so several adapter rows in a workspace can match. */
describe('findSlackAppHomeAdapter', () => {
  beforeEach(async () => {
    await insertTopics([publicTopic])
  })

  const appHomePayload = (overrides: Record<string, unknown> = {}) => ({
    team_id: 'T1',
    authorizations: [{ is_bot: true, user_id: 'U_TEST' }],
    event: { type: 'app_home_opened', user: 'U_HUMAN', channel: 'D123', tab: 'home' },
    ...overrides
  })

  it('resolves by appKey when the webhook address carries one', async () => {
    await makeAppHomeAdapter({ channel: 'C_OTHER', workspace: 'T1' })
    const berkie = await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1', appKey: 'berkie' })

    const found = await findSlackAppHomeAdapter({ appKey: 'berkie', payload: appHomePayload() })
    expect(found?._id.toString()).toBe(berkie._id.toString())
  })

  it('refuses an appKey match whose workspace disagrees with the payload', async () => {
    await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T_OTHER', appKey: 'berkie' })

    const found = await findSlackAppHomeAdapter({ appKey: 'berkie', payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('resolves by workspace and bot user id when no appKey is present', async () => {
    const berkie = await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1' })

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found?._id.toString()).toBe(berkie._id.toString())
  })

  it('ignores an adapter in another workspace using the same bot user id', async () => {
    await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T_OTHER' })

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('ignores an inactive adapter, since its page would describe a stopped assistant', async () => {
    const stopped = await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1' })
    stopped.active = false
    await stopped.save()

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('ignores a workspace whose conversation runs no community assistant', async () => {
    await makeAppHomeAdapter({ channel: 'C_SETUP', workspace: 'T1' }, 'eventSetup')

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('prefers the direct conversation, which is the one sitting in the Messages tab', async () => {
    await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1' })
    const dm = await makeAppHomeAdapter({ channel: 'direct', workspace: 'T1' })

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found?._id.toString()).toBe(dm._id.toString())
  })

  it('falls back to the channel conversation when the workspace has no direct one', async () => {
    await makeAppHomeAdapter({ channel: 'C_SETUP', workspace: 'T1' }, 'eventSetup')
    const berkie = await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1' })

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found?._id.toString()).toBe(berkie._id.toString())
  })

  it('still resolves when the payload carries no bot authorization', async () => {
    const berkie = await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1' })

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload({ authorizations: undefined }) })
    expect(found?._id.toString()).toBe(berkie._id.toString())
  })

  it('returns null when nothing matches', async () => {
    expect(await findSlackAppHomeAdapter({ payload: appHomePayload({ team_id: 'T_MISSING' }) })).toBeNull()
  })
})

/* An app_home_opened payload identifies itself differently from a message: the workspace
   sits at the top level as team_id rather than on the event, and the bot's own user id
   arrives under authorizations. The Home tab also belongs to the whole Slack app rather
   than one channel, so several adapter rows in a workspace can match. */
describe('findSlackAppHomeAdapter', () => {
  beforeEach(async () => {
    await insertTopics([publicTopic])
  })

  const appHomePayload = (overrides: Record<string, unknown> = {}) => ({
    team_id: 'T1',
    authorizations: [{ is_bot: true, user_id: 'U_TEST' }],
    event: { type: 'app_home_opened', user: 'U_HUMAN', channel: 'D123', tab: 'home' },
    ...overrides
  })

  it('resolves by appKey when the webhook address carries one', async () => {
    await makeAppHomeAdapter({ channel: 'C_OTHER', workspace: 'T1' })
    const berkie = await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1', appKey: 'berkie' })

    const found = await findSlackAppHomeAdapter({ appKey: 'berkie', payload: appHomePayload() })
    expect(found?._id.toString()).toBe(berkie._id.toString())
  })

  it('refuses an appKey match whose workspace disagrees with the payload', async () => {
    await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T_OTHER', appKey: 'berkie' })

    const found = await findSlackAppHomeAdapter({ appKey: 'berkie', payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('resolves by workspace and bot user id when no appKey is present', async () => {
    const berkie = await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1' })

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found?._id.toString()).toBe(berkie._id.toString())
  })

  it('ignores an adapter in another workspace using the same bot user id', async () => {
    await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T_OTHER' })

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('ignores an inactive adapter, since its page would describe a stopped assistant', async () => {
    const stopped = await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1' })
    stopped.active = false
    await stopped.save()

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('ignores a workspace whose conversation runs no community assistant', async () => {
    await makeAppHomeAdapter({ channel: 'C_SETUP', workspace: 'T1' }, 'eventSetup')

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('prefers the direct conversation, which is the one sitting in the Messages tab', async () => {
    await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1' })
    const dm = await makeAppHomeAdapter({ channel: 'direct', workspace: 'T1' })

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found?._id.toString()).toBe(dm._id.toString())
  })

  it('falls back to the channel conversation when the workspace has no direct one', async () => {
    await makeAppHomeAdapter({ channel: 'C_SETUP', workspace: 'T1' }, 'eventSetup')
    const berkie = await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1' })

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload() })
    expect(found?._id.toString()).toBe(berkie._id.toString())
  })

  it('still resolves when the payload carries no bot authorization', async () => {
    const berkie = await makeAppHomeAdapter({ channel: 'C_BERKIE', workspace: 'T1' })

    const found = await findSlackAppHomeAdapter({ payload: appHomePayload({ authorizations: undefined }) })
    expect(found?._id.toString()).toBe(berkie._id.toString())
  })

  it('returns null when nothing matches', async () => {
    expect(await findSlackAppHomeAdapter({ payload: appHomePayload({ team_id: 'T_MISSING' }) })).toBeNull()
  })
})
