import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import Adapter from '../../../src/models/adapter.model.js'
import Conversation from '../../../src/models/conversation.model.js'
import ConversationMembership from '../../../src/models/conversationMembership.model.js'
import { conversationAgentsEnabled, publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import findSlackAdapter, {
  findSlackAppHomeTarget,
  resolveSlackDmAdapter
} from '../../../src/handlers/helpers/findSlackAdapter.js'
import Agent from '../../../src/models/user.model/agent.model/index.js'

let memberCounter = 0
const addMembership = (conversation: unknown, slackUserId: string) => {
  memberCounter += 1
  const conversationId =
    conversation && typeof conversation === 'object' && '_id' in conversation
      ? (conversation as { _id: unknown })._id
      : conversation
  return ConversationMembership.create({
    conversation: conversationId,
    email: `member${memberCounter}@example.com`,
    name: `Member ${memberCounter}`,
    status: 'active',
    externalIds: { slack: slackUserId }
  })
}

setupIntTest()

const makeConversation = async () => {
  // A fresh _id per call: the shared fixture pins one, which collides when reused.
  const conversation = new Conversation({ ...conversationAgentsEnabled, _id: new mongoose.Types.ObjectId() })
  await conversation.save()
  return conversation
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeAdapter = async ({ dmChannels, active = true, ...config }: Record<string, any>) => {
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
const makeAppHomeAdapter = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { dmChannels, ...config }: Record<string, any>,
  { agentType = 'communityAssistant', agentConfig = {} } = {}
) => {
  const conversation = await makeConversation()
  const agent = new Agent({ agentType, conversation: conversation._id, agentConfig })
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  return Adapter.create({
    type: 'slack',
    config: { botToken: 'xoxb-test', botUserId: 'U_TEST', ...config },
    ...(dmChannels && { dmChannels }),
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
    expect(found.adapter?._id.toString()).toBe(va._id.toString())
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

    expect(foundA.adapter?._id.toString()).toBe(channelA._id.toString())
    expect(foundB.adapter?._id.toString()).toBe(channelB._id.toString())
  })

  it('falls back to workspace+channel when no appKey is provided', async () => {
    const berkie = await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      payload: { event: { type: 'message', channel: 'C123', team: 'T1' } }
    })
    expect(found.adapter?._id.toString()).toBe(berkie._id.toString())
  })

  it('resolves the workspace DM adapter when the event is an im', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1' })
    const dm = await makeAdapter({ channel: 'C123', workspace: 'T1', dmChannels: [{ direct: true, direction: 'both' }] })

    const found = await findSlackAdapter({
      payload: { event: { type: 'message', channel_type: 'im', channel: 'D_USER123', team: 'T1' } }
    })
    expect(found.adapter?._id.toString()).toBe(dm._id.toString())
    expect(found.unresolved).toBeUndefined()
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
    expect(found.adapter?._id.toString()).toBe(dm._id.toString())
  })

  it('returns no adapter for a DM when no adapter has dmChannels for the workspace', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      payload: { event: { type: 'message', channel_type: 'im', channel: 'D_USER123', team: 'T1' } }
    })
    expect(found.adapter).toBeNull()
    expect(found.unresolved).toBeUndefined()
  })

  it('returns no adapter when the appKey matches but the event came from a different workspace', async () => {
    await makeAdapter({ channel: 'C_VA', workspace: 'W_VA', appKey: 'va' })

    const found = await findSlackAdapter({
      appKey: 'va',
      payload: { event: { type: 'message', channel: 'C_VA', team: 'W_DIFFERENT' } }
    })
    expect(found.adapter).toBeNull()
  })

  it('returns no adapter when appKey is provided but no matching row exists', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      appKey: 'nonexistent',
      payload: { event: { type: 'message', channel: 'C123', team: 'T1' } }
    })
    expect(found.adapter).toBeNull()
  })

  it('returns no adapter when appKey is provided but workspace or channel is missing from the payload', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1', appKey: 'myapp' })

    const found = await findSlackAdapter({
      appKey: 'myapp',
      payload: { event: { team: 'T1' } }
    })
    expect(found.adapter).toBeNull()
  })

  it('returns no adapter when nothing matches', async () => {
    const found = await findSlackAdapter({
      payload: { event: { type: 'message', channel: 'C_MISSING', team: 'T_MISSING' } }
    })
    expect(found.adapter).toBeNull()
  })

  it('resolves workspace from outer team_id when event.team is absent (e.g. subtype events)', async () => {
    const adapter = await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      payload: { team_id: 'T1', event: { type: 'message', channel: 'C123' } }
    })
    expect(found.adapter?._id.toString()).toBe(adapter._id.toString())
  })

  it('prefers outer team_id over event.team when both are present', async () => {
    const adapter = await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      payload: { team_id: 'T1', event: { type: 'message', channel: 'C123', team: 'T_WRONG' } }
    })
    expect(found.adapter?._id.toString()).toBe(adapter._id.toString())
  })

  it('returns no adapter when there is no event on the payload', async () => {
    const found = await findSlackAdapter({ payload: {} })
    expect(found.adapter).toBeNull()
  })

  it('does not match an inactive appKey adapter for a group chat message', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1', appKey: 'myapp', active: false })

    const found = await findSlackAdapter({
      appKey: 'myapp',
      payload: { event: { type: 'message', channel: 'C123', team: 'T1' } }
    })
    expect(found.adapter).toBeNull()
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
    expect(found.adapter).toBeNull()
    expect(found.unresolved).toBeUndefined()
  })

  it('returns no adapter when appKey is set but workspace is missing — no unsafe fallback', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1', appKey: 'myapp' })

    const found = await findSlackAdapter({
      appKey: 'myapp',
      payload: { event: { type: 'message', channel: 'C123' } }
    })
    expect(found.adapter).toBeNull()
  })

  it("resolves to the sender's own community when multiple communities in the workspace have dmChannels", async () => {
    const communityA = await makeAdapter({
      channel: 'C_A',
      workspace: 'T1',
      dmChannels: [{ direct: true, direction: 'both' }]
    })
    const communityB = await makeAdapter({
      channel: 'C_B',
      workspace: 'T1',
      dmChannels: [{ direct: true, direction: 'both' }]
    })
    await addMembership(communityB.conversation, 'U_MEMBER')

    const found = await findSlackAdapter({
      payload: { event: { type: 'message', channel_type: 'im', channel: 'D_USER123', team: 'T1', user: 'U_MEMBER' } }
    })
    expect(found.adapter?._id.toString()).toBe(communityB._id.toString())
    expect(found.adapter?._id.toString()).not.toBe(communityA._id.toString())
    expect(found.unresolved).toBeUndefined()
  })

  it('resolves unresolved (not a hard null) for a DM when the sender is not a member of any community sharing the workspace', async () => {
    await makeAdapter({ channel: 'C_A', workspace: 'T1', dmChannels: [{ direct: true, direction: 'both' }] })
    await makeAdapter({ channel: 'C_B', workspace: 'T1', dmChannels: [{ direct: true, direction: 'both' }] })

    const found = await findSlackAdapter({
      payload: { event: { type: 'message', channel_type: 'im', channel: 'D_USER123', team: 'T1', user: 'U_STRANGER' } }
    })
    // Not null: a legitimate DM-capable candidate is still returned (any one works for
    // signature validation) so the caller can acknowledge the webhook rather than reject it.
    expect(found.adapter).not.toBeNull()
    expect(found.unresolved).toBe(true)
  })

  it('picks the first candidate when the sender is a member of more than one community sharing the workspace', async () => {
    const communityA = await makeAdapter({
      channel: 'C_A',
      workspace: 'T1',
      dmChannels: [{ direct: true, direction: 'both' }]
    })
    const communityB = await makeAdapter({
      channel: 'C_B',
      workspace: 'T1',
      dmChannels: [{ direct: true, direction: 'both' }]
    })
    await addMembership(communityA.conversation, 'U_BOTH')
    await addMembership(communityB.conversation, 'U_BOTH')

    const found = await resolveSlackDmAdapter({ workspaceId: 'T1', slackUserId: 'U_BOTH' })
    expect(found.adapter?._id.toString()).toBe(communityA._id.toString())
    expect(found.unresolved).toBeUndefined()
  })

  it('returns unresolved for multiple DM candidates when the payload carries no sender id to disambiguate by', async () => {
    await makeAdapter({ channel: 'C_A', workspace: 'T1', dmChannels: [{ direct: true, direction: 'both' }] })
    await makeAdapter({ channel: 'C_B', workspace: 'T1', dmChannels: [{ direct: true, direction: 'both' }] })

    const found = await resolveSlackDmAdapter({ workspaceId: 'T1' })
    expect(found.adapter).not.toBeNull()
    expect(found.unresolved).toBe(true)
  })

  it('returns no adapter for a non-DM event with no channel, even when workspace matches (catch-all path)', async () => {
    await makeAdapter({ channel: 'C123', workspace: 'T1' })

    const found = await findSlackAdapter({
      payload: { event: { type: 'message', team: 'T1' } }
    })
    expect(found.adapter).toBeNull()
  })

  it('resolves by appKey alone for url_verification (no workspace in payload)', async () => {
    const adapter = await makeAdapter({ channel: 'C123', workspace: 'T1', appKey: 'myapp' })

    const found = await findSlackAdapter({
      appKey: 'myapp',
      payload: { type: 'url_verification' }
    })
    expect(found.adapter?._id.toString()).toBe(adapter._id.toString())
  })

  it('returns no adapter for url_verification when no adapter matches the appKey', async () => {
    const found = await findSlackAdapter({
      appKey: 'nonexistent',
      payload: { type: 'url_verification' }
    })
    expect(found.adapter).toBeNull()
  })
})

/* An app_home_opened payload identifies itself differently from a message: the workspace
   sits at the top level as team_id rather than on the event, and the bot's own user id
   arrives under authorizations. The Home tab also belongs to the whole Slack app rather
   than one channel, so several adapter rows in a workspace can match. */
describe('findSlackAppHomeTarget', () => {
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
    const assistant = await makeAppHomeAdapter({ channel: 'C_ASSISTANT', workspace: 'T1', appKey: 'assistant' })

    const found = await findSlackAppHomeTarget({ appKey: 'assistant', payload: appHomePayload() })
    expect(found?.adapter._id.toString()).toBe(assistant._id.toString())
  })

  it('refuses an appKey match whose workspace disagrees with the payload', async () => {
    await makeAppHomeAdapter({ channel: 'C_ASSISTANT', workspace: 'T_OTHER', appKey: 'assistant' })

    const found = await findSlackAppHomeTarget({ appKey: 'assistant', payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('resolves by workspace and bot user id when no appKey is present', async () => {
    const assistant = await makeAppHomeAdapter({ channel: 'C_ASSISTANT', workspace: 'T1' })

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })
    expect(found?.adapter._id.toString()).toBe(assistant._id.toString())
  })

  it('ignores an adapter in another workspace using the same bot user id', async () => {
    await makeAppHomeAdapter({ channel: 'C_ASSISTANT', workspace: 'T_OTHER' })

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('ignores an inactive adapter, since its page would describe a stopped assistant', async () => {
    const stopped = await makeAppHomeAdapter({ channel: 'C_ASSISTANT', workspace: 'T1' })
    stopped.active = false
    await stopped.save()

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('ignores a workspace whose conversation runs no community assistant', async () => {
    await makeAppHomeAdapter({ channel: 'C_SETUP', workspace: 'T1' }, { agentType: 'eventSetup' })

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })
    expect(found).toBeNull()
  })

  it('prefers the direct conversation, which is the one sitting in the Messages tab', async () => {
    await makeAppHomeAdapter({ channel: 'C_ASSISTANT', workspace: 'T1' })
    const dm = await makeAppHomeAdapter({ channel: 'direct', workspace: 'T1' })
    // Two distinct communities now need membership to disambiguate which one this viewer gets.
    await addMembership(dm.conversation, 'U_HUMAN')

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })
    expect(found?.adapter._id.toString()).toBe(dm._id.toString())
  })

  it('falls back to the channel conversation when the workspace has no direct one', async () => {
    await makeAppHomeAdapter({ channel: 'C_SETUP', workspace: 'T1' }, { agentType: 'eventSetup' })
    const assistant = await makeAppHomeAdapter({ channel: 'C_ASSISTANT', workspace: 'T1' })

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })
    expect(found?.adapter._id.toString()).toBe(assistant._id.toString())
  })

  it('still resolves when the payload carries no bot authorization', async () => {
    const assistant = await makeAppHomeAdapter({ channel: 'C_ASSISTANT', workspace: 'T1' })

    const found = await findSlackAppHomeTarget({ payload: appHomePayload({ authorizations: undefined }) })
    expect(found?.adapter._id.toString()).toBe(assistant._id.toString())
  })

  it("names the shared channel for the viewer's own community", async () => {
    const channelAdapter = await makeAppHomeAdapter({ channel: 'C_ASSISTANT', workspace: 'T1' })
    await makeAppHomeAdapter({ channel: 'direct', workspace: 'T1' })
    await addMembership(channelAdapter.conversation, 'U_HUMAN')

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })
    expect(found?.sharedChannelId).toBe('C_ASSISTANT')
  })

  it('names no shared channel when the assistant only runs in direct messages', async () => {
    await makeAppHomeAdapter({ channel: 'direct', workspace: 'T1' })

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })
    expect(found?.sharedChannelId).toBeUndefined()
  })

  it("resolves to the viewer's own community's settings, not a blend with another community sharing the workspace", async () => {
    // Each community here answers DMs itself (real dmChannels, not the "one shared direct
    // conversation" pattern), so both the channel role AND the direct role are genuinely
    // ambiguous across the two communities and both need membership to resolve.
    const mine = await makeAppHomeAdapter(
      { channel: 'C_MINE', workspace: 'T1', dmChannels: [{ direct: true, direction: 'both' }] },
      { agentConfig: { notifications: ['event_ended'] } }
    )
    await makeAppHomeAdapter(
      { channel: 'C_OTHER', workspace: 'T1', dmChannels: [{ direct: true, direction: 'both' }] },
      { agentConfig: { notifications: [] } }
    )
    await addMembership(mine.conversation, 'U_HUMAN')

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })

    expect(found?.channelAgentConfig?.notifications).toEqual(['event_ended'])
    // Same community answers both roles here, so directAgentConfig resolves to it too — the
    // other community's settings must never leak in just because it shares the workspace.
    expect(found?.directAgentConfig?.notifications).toEqual(['event_ended'])
  })

  it('narrows by appKey before counting communities, excluding an unrelated conversation entirely', async () => {
    const channelRow = await makeAppHomeAdapter({ channel: 'C_ASSISTANT', workspace: 'T1', appKey: 'assistant' })
    await makeAppHomeAdapter({ channel: 'direct', workspace: 'T1' })

    const found = await findSlackAppHomeTarget({ appKey: 'assistant', payload: appHomePayload() })

    expect(found?.adapter._id.toString()).toBe(channelRow._id.toString())
    expect(found?.unresolved).toBeUndefined()
    // The other (unkeyed) conversation belongs to a different app context and must not blend in.
    expect(found?.directAgentConfig).toBeUndefined()
  })

  it('falls back to the full eligible set when appKey matches none of them (truncated authorizations recovery)', async () => {
    // config.appKey is unset here, same as a legitimately configured row with no appKey. A
    // webhook address naming an appKey that matches nothing should not zero out an otherwise
    // correct botUserId match — see the comment on the appKey-narrowing block in the source.
    const assistant = await makeAppHomeAdapter({ channel: 'C_ASSISTANT', workspace: 'T1' })

    const found = await findSlackAppHomeTarget({ appKey: 'no-such-app', payload: appHomePayload() })

    expect(found?.adapter._id.toString()).toBe(assistant._id.toString())
    expect(found?.unresolved).toBeUndefined()
  })

  it('reports the one DM-capable community for direct messages even when the channel role is ambiguous', async () => {
    // Only one of the two communities answers DMs — that role isn't ambiguous (only one
    // candidate exists for it), so it resolves unconditionally. The channel role still needs
    // membership, since both communities have their own channel.
    await makeAppHomeAdapter(
      { channel: 'C_DM', workspace: 'T1', dmChannels: [{ direct: true, direction: 'both' }] },
      { agentConfig: { notifications: ['event_ended'] } }
    )
    const channelOnly = await makeAppHomeAdapter(
      { channel: 'C_CHANNEL_ONLY', workspace: 'T1' },
      { agentConfig: { notifications: [] } }
    )
    await addMembership(channelOnly.conversation, 'U_HUMAN')

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })

    expect(found?.channelAgentConfig?.notifications).toEqual([])
    expect(found?.directAgentConfig?.notifications).toEqual(['event_ended'])
  })

  it('returns unresolved when the viewer cannot be matched to any of several communities', async () => {
    const first = await makeAppHomeAdapter({ channel: 'C_A', workspace: 'T1' })
    const second = await makeAppHomeAdapter({ channel: 'C_B', workspace: 'T1' })

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })

    expect(found?.unresolved).toBe(true)
    // Either adapter works for the bot token — they share one Slack app.
    expect([first._id.toString(), second._id.toString()]).toContain(found?.adapter._id.toString())
  })

  it('picks the first community when the viewer is a member of more than one', async () => {
    const first = await makeAppHomeAdapter({ channel: 'C_A', workspace: 'T1' })
    const second = await makeAppHomeAdapter({ channel: 'C_B', workspace: 'T1' })
    await addMembership(first.conversation, 'U_HUMAN')
    await addMembership(second.conversation, 'U_HUMAN')

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })

    expect(found?.unresolved).toBeUndefined()
    expect(found?.adapter._id.toString()).toBe(first._id.toString())
  })

  it('prefers the channel marked showOnAppHome over others when multiple channels are eligible', async () => {
    // Both adapters belong to the SAME community/conversation (unlike the other tests in this
    // block) — showOnAppHome tiebreaks between a community's own multiple channels, not between
    // different communities, which membership resolution already handles above.
    const conversation = await makeConversation()
    const agent = new Agent({ agentType: 'communityAssistant', conversation: conversation._id, agentConfig: {} })
    await agent.save()
    conversation.agents.push(agent)
    await conversation.save()

    await Adapter.create({
      type: 'slack',
      config: { botToken: 'xoxb-test', botUserId: 'U_TEST', channel: 'C_TEST', workspace: 'T1' },
      conversation: conversation._id,
      active: true
    })
    await Adapter.create({
      type: 'slack',
      config: { botToken: 'xoxb-test', botUserId: 'U_TEST', channel: 'C_MAIN', workspace: 'T1', showOnAppHome: true },
      conversation: conversation._id,
      active: true
    })

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })
    expect(found?.sharedChannelId).toBe('C_MAIN')
  })

  it('falls back to any channel when none has showOnAppHome set', async () => {
    await makeAppHomeAdapter({ channel: 'C_FALLBACK', workspace: 'T1' })

    const found = await findSlackAppHomeTarget({ payload: appHomePayload() })
    expect(found?.sharedChannelId).toBe('C_FALLBACK')
  })

  it('returns null when nothing matches', async () => {
    expect(await findSlackAppHomeTarget({ payload: appHomePayload({ team_id: 'T_MISSING' }) })).toBeNull()
  })
})
