/**
 * Set the active Slack conversation's eventHistorian agent to search its own topic,
 * so tools get bound (no textual tool-call leak) and retrieval targets the right
 * collection. Run: node --loader ts-node/esm scripts/fixHistorianTopicIds.ts
 */
/* eslint-disable no-console */
import mongoose from 'mongoose'
import config from '../src/config/config.js'
import { Adapter, Agent, Conversation } from '../src/models/index.js'

await mongoose.connect(config.mongoose.url)
const adapter = await Adapter.findOne({ type: 'slack', active: true }).lean()
const convo = await Conversation.findById(adapter!.conversation).select('topic').lean()
const topicId = convo!.topic!.toString()

const agent = await Agent.findOne({ conversation: adapter!.conversation, agentType: 'eventHistorian' })
if (!agent) {
  console.log('No eventHistorian agent found.')
} else {
  const ac = (agent as { agentConfig?: Record<string, unknown> }).agentConfig || {}
  ac.topicIds = [topicId]
  ;(agent as { agentConfig?: Record<string, unknown> }).agentConfig = ac
  agent.markModified('agentConfig')
  await agent.save()
  console.log(`Updated historian agent ${agent._id}: agentConfig.topicIds = ["${topicId}"]`)
}
await mongoose.disconnect()
