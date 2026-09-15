import mongoose from 'mongoose'
import { AgentIntroduction } from '../models/index.js'
import { AgentResponse, IChannel } from '../types/index.types.js'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const withoutChannel = ({ channels, ...intro }: AgentResponse<unknown>) => intro

interface IntroduceOnceArgs {
  conversation: { _id: mongoose.Types.ObjectId }
  agent: {
    _id: mongoose.Types.ObjectId
    introduce(channel: IChannel, adapterType?: string): Promise<AgentResponse<unknown>[]>
  }
  channel: IChannel
  user: { _id: mongoose.Types.ObjectId }
  adapterType?: string
}

/**
 * Asks an agent to greet a participant on a channel the first time, stores the greeting, and hands
 * back the stored copy on every later call without asking the agent again (a DM greeting is a live
 * LLM call). Nothing is stored when the agent returns no greeting, so the next join asks again.
 *
 * Two joins from one browser can race past the lookup and both generate a greeting; the unique
 * index lets the first insert win, and the other call returns that copy so both show identical text.
 */
export default async function introduceOnce({
  conversation,
  agent,
  channel,
  user,
  adapterType
}: IntroduceOnceArgs): Promise<AgentResponse<unknown>[]> {
  const filter = { conversation: conversation._id, user: user._id, agent: agent._id, channel: channel.name }
  const withChannel = (intro: Omit<AgentResponse<unknown>, 'channels'>) => ({ ...intro, channels: [channel] })

  const saved = await AgentIntroduction.findOne(filter)
  if (saved) return saved.intros.map(withChannel)

  const generated = await agent.introduce(channel, adapterType)
  if (generated.length === 0) return []

  try {
    const result = await AgentIntroduction.findOneAndUpdate(
      filter,
      { $setOnInsert: { intros: generated.map(withoutChannel) } },
      { upsert: true, returnDocument: 'after' }
    )
    return result!.intros.map(withChannel)
  } catch (err) {
    if (err.code !== 11000) throw err
    const winner = await AgentIntroduction.findOne(filter)
    return winner!.intros.map(withChannel)
  }
}
