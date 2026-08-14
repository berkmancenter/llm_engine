import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import { Conversation, Agent } from '../../../../src/models/index.js'
import { labelActiveAgentTypes, resolveActiveAgentTypeLabels } from '../../../../src/agents/vibesAnalyst/buildSummary.js'

setupIntTest()

describe('labelActiveAgentTypes', () => {
  it('maps known agent types to their scene-setting labels', () => {
    expect(labelActiveAgentTypes(['eventAssistant', 'jargonFilterAgent'])).toEqual([
      'an assistant participants could summon',
      'a jargon filter'
    ])
  })

  it('drops the Vibes Analyst from its own list of active agents', () => {
    expect(labelActiveAgentTypes(['eventAssistant', 'vibesAnalyst'])).toEqual(['an assistant participants could summon'])
  })

  it('deduplicates repeated agent types', () => {
    expect(labelActiveAgentTypes(['eventAssistant', 'eventAssistant'])).toEqual(['an assistant participants could summon'])
  })

  it('drops an agent type with no mapped label instead of leaking its raw key', () => {
    expect(labelActiveAgentTypes(['someBrandNewAgentType'])).toEqual([])
  })

  it('returns an empty list when no agent types are given', () => {
    expect(labelActiveAgentTypes([])).toEqual([])
  })
})

/* Creates a real Agent document on the conversation, the same lightweight fixture
   pattern conversationAnalytics.service.test.ts uses: agentType is enough, since the
   agent schema's pre-validate hook fills name/description/pseudonyms/llmPlatform/
   llmModel from that type's registered defaults. */
async function seedAgent(conversation, agentType: string) {
  const agent = new Agent({ agentType, conversation })
  await agent.save()
  conversation.agents.push(agent._id)
  await conversation.save()
  return agent
}

async function makeConversation() {
  return Conversation.create({
    name: 'Setup metadata event',
    slug: `setup-meta-${new mongoose.Types.ObjectId().toString()}`,
    owner: new mongoose.Types.ObjectId(),
    topic: new mongoose.Types.ObjectId(),
    transcript: { status: 'stopped' }
  })
}

describe('resolveActiveAgentTypeLabels', () => {
  it('resolves labels from unpopulated agent references by querying their agentType', async () => {
    const conversation = await makeConversation()
    await seedAgent(conversation, 'eventAssistant')
    await seedAgent(conversation, 'vibesAnalyst')

    const labels = await resolveActiveAgentTypeLabels(conversation)

    expect(labels).toEqual(['an assistant participants could summon'])
  })

  it('resolves labels from already-populated agent documents without an extra query', async () => {
    const conversation = await makeConversation()
    const agent = await seedAgent(conversation, 'jargonFilterAgent')
    const populatedConversation = await Conversation.findById(conversation._id).populate('agents')
    expect(populatedConversation!.agents[0]).toHaveProperty('agentType', 'jargonFilterAgent')

    const labels = await resolveActiveAgentTypeLabels(populatedConversation!)

    expect(labels).toEqual(['a jargon filter'])
    expect(agent.agentType).toBe('jargonFilterAgent')
  })

  it('returns an empty list when the conversation has no agents', async () => {
    const conversation = await makeConversation()

    const labels = await resolveActiveAgentTypeLabels(conversation)

    expect(labels).toEqual([])
  })
})
