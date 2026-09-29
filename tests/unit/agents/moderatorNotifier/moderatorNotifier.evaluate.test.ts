/* Covers moderatorNotifier.evaluate()'s activity gate: the framework's own evaluate()
   (agent.model/index.ts) already skips this agent when the conversation's total message
   count hasn't changed since last activation, but that count includes other agents' own
   messages. This narrows the check to real participant activity — no LLM calls involved,
   evaluate() never reaches respond(). */

import { AgentMessageActions } from '../../../../src/types/index.types.js'
import moderatorNotifier from '../../../../src/agents/moderatorNotifier/moderatorNotifier.js'

const AGENT_NAME = 'Moderator Notifier'

function makeMessage(overrides: { fromAgent?: boolean; createdAt?: Date }) {
  const createdAt = overrides.createdAt ?? new Date()
  return {
    fromAgent: false,
    createdAt,
    updatedAt: createdAt,
    ...overrides
  }
}

function makeAgent(overrides: { messages?: ReturnType<typeof makeMessage>[]; timerPeriod?: number } = {}) {
  return {
    name: AGENT_NAME,
    agentType: 'moderatorNotifier',
    _id: 'test-agent-id',
    triggers: { periodic: { timerPeriod: overrides.timerPeriod ?? 120 } },
    conversation: {
      messages: overrides.messages ?? []
    }
  }
}

describe('moderatorNotifier evaluate', () => {
  it('rejects when there is no participant activity at all', async () => {
    const agent = makeAgent({ messages: [] })

    const result = await moderatorNotifier.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.REJECT)
  })

  it('rejects when only other agents posted within the tick window', async () => {
    const now = new Date()
    const agent = makeAgent({
      messages: [
        makeMessage({ fromAgent: true, createdAt: new Date(now.getTime() - 30 * 1000) }),
        makeMessage({ fromAgent: true, createdAt: new Date(now.getTime() - 90 * 1000) })
      ]
    })

    const result = await moderatorNotifier.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.REJECT)
  })

  it('contributes when a participant message is within the tick window', async () => {
    const now = new Date()
    const agent = makeAgent({
      messages: [
        makeMessage({ fromAgent: true, createdAt: new Date(now.getTime() - 30 * 1000) }),
        makeMessage({ fromAgent: false, createdAt: new Date(now.getTime() - 60 * 1000) })
      ]
    })

    const result = await moderatorNotifier.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
  })

  it('rejects when the only participant message is older than the tick window', async () => {
    const now = new Date()
    const agent = makeAgent({
      timerPeriod: 120,
      messages: [makeMessage({ fromAgent: false, createdAt: new Date(now.getTime() - 5 * 60 * 1000) })]
    })

    const result = await moderatorNotifier.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.REJECT)
  })

  it('respects a custom timerPeriod', async () => {
    const now = new Date()
    const agent = makeAgent({
      timerPeriod: 600, // 10 min window
      messages: [makeMessage({ fromAgent: false, createdAt: new Date(now.getTime() - 5 * 60 * 1000) })]
    })

    const result = await moderatorNotifier.evaluate.call(agent, null)

    expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
  })
})
