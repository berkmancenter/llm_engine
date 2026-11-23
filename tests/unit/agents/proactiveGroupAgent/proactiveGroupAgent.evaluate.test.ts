/* Covers proactiveGroupAgent.evaluate()'s three-way gate: this agent is proactive
   (triggers.periodic.proactive, or a cron trigger), so the framework's own "no new messages"
   skip never applies to it — see agent.model/index.ts. Some of its goals (provoke_participation,
   play_commentary, poll_reveal, missing_perspective) trigger ON chat silence, so the gate
   must distinguish "nothing anywhere" from "chat quiet but a silence-compatible goal is
   eligible" from "chat has activity". No LLM calls involved — evaluate() never reaches
   respond(). Goal loading (promptComposer/goals loader) is real, not mocked — it's pure
   and reads goal JSON files already on disk. */

import { AgentMessageActions } from '../../../../src/types/index.types.js'
import proactiveGroupAgent from '../../../../src/agents/proactiveGroupAgent/proactiveGroupAgent.js'
import resolveConversationType from '../../../../src/conversations/resolver.js'
import slackCommunityAssistant from '../../../../src/conversations/slackCommunityAssistant.js'

const AGENT_NAME = 'Proactive Group Agent'

function makeMessage(overrides: { fromAgent?: boolean; channels?: string[]; createdAt?: Date }) {
  const createdAt = overrides.createdAt ?? new Date()
  return {
    fromAgent: false,
    channels: ['chat'],
    createdAt,
    updatedAt: createdAt,
    ...overrides
  }
}

function makeAgent(
  overrides: {
    messages?: ReturnType<typeof makeMessage>[]
    goals?: string[]
    transcriptWindow?: number
  } = {}
) {
  return {
    name: AGENT_NAME,
    agentType: 'proactiveGroupAgent',
    _id: 'test-agent-id',
    agentConfig: { transcriptWindow: overrides.transcriptWindow ?? 10 },
    conversation: {
      goals: overrides.goals ?? ['provoke_participation'],
      behaviorPolicy: undefined,
      messages: overrides.messages ?? []
    }
  }
}

describe('proactiveGroupAgent evaluate', () => {
  it('rejects when chat and transcript are both quiet and no eligible goal is silence-compatible', async () => {
    const agent = makeAgent({ goals: ['synthesize_discussion'], messages: [] })

    const result = await proactiveGroupAgent.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.REJECT)
  })

  it('contributes when chat and transcript are both quiet but a silence-compatible goal is eligible', async () => {
    // The case the gate used to miss: this is the normal steady state for an async, chat-only
    // conversation (e.g. a Slack community) with no transcript channel at all, not just an
    // edge case within a live event, which auto-stop bounds separately.
    const agent = makeAgent({ goals: ['provoke_participation'], messages: [] })

    const result = await proactiveGroupAgent.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
  })

  it('contributes when chat has recent activity, regardless of goals', async () => {
    const now = new Date()
    const agent = makeAgent({
      goals: ['synthesize_discussion'], // not silence-compatible
      messages: [makeMessage({ channels: ['chat'], createdAt: new Date(now.getTime() - 30 * 1000) })]
    })

    const result = await proactiveGroupAgent.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
  })

  it('rejects when chat is quiet, transcript is active, but no silence-compatible goal is eligible', async () => {
    const now = new Date()
    const agent = makeAgent({
      goals: ['synthesize_discussion', 'structure_conversation'], // neither is silence-compatible
      messages: [makeMessage({ channels: ['transcript'], createdAt: new Date(now.getTime() - 30 * 1000) })]
    })

    const result = await proactiveGroupAgent.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.REJECT)
  })

  it('contributes when chat is quiet, transcript is active, and provoke_participation is eligible', async () => {
    const now = new Date()
    const agent = makeAgent({
      goals: ['provoke_participation'],
      messages: [makeMessage({ channels: ['transcript'], createdAt: new Date(now.getTime() - 30 * 1000) })]
    })

    const result = await proactiveGroupAgent.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
  })

  it('contributes when chat is quiet, transcript is active, and missing_perspective is eligible', async () => {
    const now = new Date()
    const agent = makeAgent({
      goals: ['missing_perspective'],
      messages: [makeMessage({ channels: ['transcript'], createdAt: new Date(now.getTime() - 30 * 1000) })]
    })

    const result = await proactiveGroupAgent.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
  })

  it('does not count a chat message from another agent as recent chat activity', async () => {
    const now = new Date()
    const agent = makeAgent({
      goals: ['synthesize_discussion'], // not silence-compatible, so this matters
      messages: [
        makeMessage({ channels: ['chat'], fromAgent: true, createdAt: new Date(now.getTime() - 30 * 1000) }),
        makeMessage({ channels: ['transcript'], fromAgent: false, createdAt: new Date(now.getTime() - 30 * 1000) })
      ]
    })

    const result = await proactiveGroupAgent.evaluate.call(agent, null)

    // chat is agent-only (not "recent chat activity"), transcript is active, no silence goal → reject
    expect(result.action).toBe(AgentMessageActions.REJECT)
  })

  it('respects a custom transcriptWindow from agentConfig', async () => {
    const now = new Date()
    const agent = makeAgent({
      goals: ['synthesize_discussion'], // not silence-compatible, so this isolates the window check
      transcriptWindow: 2, // 2 minutes
      messages: [makeMessage({ channels: ['transcript'], createdAt: new Date(now.getTime() - 5 * 60 * 1000) })]
    })

    const result = await proactiveGroupAgent.evaluate.call(agent, null)

    // transcript message is outside the 2-minute window → both channels quiet → reject
    expect(result.action).toBe(AgentMessageActions.REJECT)
  })
})

describe('proactiveGroupAgent evaluate as configured by slackCommunityAssistant', () => {
  const HOUR_MS = 60 * 60 * 1000

  // Merges the type's agentConfig defaults under the resolved instance config, the same way the
  // agent model's pre-validate hook does, so the test sees the window a real Slack agent gets.
  function makeSlackAgent(messages: ReturnType<typeof makeMessage>[]) {
    const resolved = resolveConversationType(
      { properties: { slackChannel: 'C123', slackWorkspace: 'T123', slackBotToken: 'xoxb-test' } },
      slackCommunityAssistant
    )
    const instance = resolved.agentTypes.find((a) => a.name === 'proactiveGroupAgent')!.properties as {
      agentConfig?: Record<string, unknown>
    }
    return {
      name: AGENT_NAME,
      agentType: 'proactiveGroupAgent',
      _id: 'test-agent-id',
      agentConfig: { ...proactiveGroupAgent.agentConfig, ...instance.agentConfig },
      conversation: { goals: ['synthesize_discussion'], behaviorPolicy: undefined, messages }
    }
  }

  it('contributes on the daily tick when members chatted earlier that day', async () => {
    const agent = makeSlackAgent([makeMessage({ channels: ['chat'], createdAt: new Date(Date.now() - 3 * HOUR_MS) })])

    const result = await proactiveGroupAgent.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
  })

  it('still rejects when the only chat is older than a day and no goal is silence-compatible', async () => {
    const agent = makeSlackAgent([makeMessage({ channels: ['chat'], createdAt: new Date(Date.now() - 30 * HOUR_MS) })])

    const result = await proactiveGroupAgent.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.REJECT)
  })
})
