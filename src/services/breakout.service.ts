import { nanoid } from 'nanoid'
import channelService from './channel.service.js'
import agentService from './agent.service/index.js'
import logger from '../config/logger.js'

const ROUND_ID_LENGTH = 8

// Replace known parent chat/transcript channel names with their breakout equivalents,
// leaving all other channel names (e.g. DM channels) unchanged.
// Falls back to [chatChannel] if the parent had no channels configured.
function mapBreakoutChannels(
  parentChannels: string[],
  parentChatChannels: string[],
  parentTranscriptChannels: string[],
  chatChannel: string,
  transcriptChannel: string
) {
  if (parentChannels.length === 0) return []
  return parentChannels.map((c) => {
    if (parentChatChannels.includes(c)) return chatChannel
    if (parentTranscriptChannels.includes(c)) return transcriptChannel
    return c
  })
}

// Remap any channel references in a trigger to their breakout equivalents.
// Handles both top-level channels (e.g. perMessage.channels) and nested conversationHistorySettings.channels.
function mapTriggerChannels(trigger, parentChatChannels, parentTranscriptChannels, chatChannel, transcriptChannel) {
  if (!trigger) return trigger
  return {
    ...trigger,
    ...(trigger.channels && {
      channels: mapBreakoutChannels(
        trigger.channels,
        parentChatChannels,
        parentTranscriptChannels,
        chatChannel,
        transcriptChannel
      )
    }),
    ...(trigger.conversationHistorySettings?.channels && {
      conversationHistorySettings: {
        ...trigger.conversationHistorySettings,
        channels: mapBreakoutChannels(
          trigger.conversationHistorySettings.channels,
          parentChatChannels,
          parentTranscriptChannels,
          chatChannel,
          transcriptChannel
        )
      }
    })
  }
}
const INHERITED_AGENT_FIELDS = [
  'agentConfig',
  'llmPlatform',
  'llmPlatformOptions',
  'llmModel',
  'llmModelOptions',
  'llmTemplates',
  'ragCollectionName',
  'triggers'
] as const

export const breakoutTranscriptChannelName = (roundId: string, roomId: string) => `breakout/${roundId}/${roomId}/transcript`

export const breakoutChatChannelName = (roundId: string, roomId: string) => `breakout/${roundId}/${roomId}/chat`

interface OpenBreakoutRoomArgs {
  roomId: string
  name?: string
  description?: string
  parentChatChannels: string[]
  parentTranscriptChannels: string[]
}

async function openBreakoutRoom(
  conversation,
  { roomId, name, description, parentChatChannels, parentTranscriptChannels }: OpenBreakoutRoomArgs
) {
  if (!conversation.populated('channels')) await conversation.populate('channels')
  if (!conversation.populated('agents')) await conversation.populate('agents')

  // Join the active round or start a new one
  const activeBreakoutChannel = conversation.channels.find((c) => c.breakout?.active !== false && c.breakout?.roundId)
  const roundId = activeBreakoutChannel?.breakout?.roundId ?? nanoid(ROUND_ID_LENGTH)

  const transcriptChannel = breakoutTranscriptChannelName(roundId, roomId)
  const chatChannel = breakoutChatChannelName(roundId, roomId)

  await channelService.createChannel(conversation, {
    name: transcriptChannel,
    breakout: {
      roomId,
      roundId,
      name,
      description,
      active: true,
      parentChannel: parentTranscriptChannels[0],
      type: 'transcript'
    }
  })
  await channelService.createChannel(conversation, {
    name: chatChannel,
    breakout: { roomId, roundId, name, description, active: true, parentChannel: parentChatChannels[0], type: 'chat' }
  })

  const agentTypes: string[] = (conversation.properties?.breakoutAgentTypes as string[]) ?? []
  const agents: unknown[] = []

  for (const agentType of agentTypes) {
    const parentAgent = conversation.agents.find((a) => a.agentType === agentType && a.active)
    const inherited = parentAgent
      ? Object.fromEntries(
          INHERITED_AGENT_FIELDS.filter((k) => parentAgent[k] !== undefined).map((k) => [k, parentAgent[k]])
        )
      : {}
    const parentHistorySettings = parentAgent?.conversationHistorySettings || {}
    const parentHistoryChannels = parentHistorySettings.channels as string[] | undefined
    const breakoutAdditions = [
      ...(parentHistoryChannels?.some((c) => parentChatChannels.includes(c)) ? [chatChannel] : []),
      ...(parentHistoryChannels?.some((c) => parentTranscriptChannels.includes(c)) ? [transcriptChannel] : [])
    ]
    const historyChannels = parentHistoryChannels
      ? [...new Set([...parentHistoryChannels, ...breakoutAdditions])]
      : undefined
    const agent = await agentService.createAgent(agentType, conversation, {
      ...inherited,
      agentConfig: {
        ...((inherited.agentConfig as Record<string, unknown>) || {}),
        breakout: { roomId, roundId }
      },
      conversationHistorySettings: {
        ...parentHistorySettings,
        ...(historyChannels !== undefined ? { channels: historyChannels } : {})
      }
    })
    // Remap trigger channels after creation so defaults are applied first
    const mappedTriggers = Object.fromEntries(
      Object.entries(agent.triggers || {}).map(([key, trigger]) => [
        key,
        mapTriggerChannels(trigger, parentChatChannels, parentTranscriptChannels, chatChannel, transcriptChannel)
      ])
    )
    await agentService.patchAgent(agent, { triggers: mappedTriggers })
    conversation.agents.push(agent)
    await agentService.startAgent(agent)
    agents.push(agent)
  }

  await conversation.save()

  logger.info(`Opened breakout room ${name || roomId} (round ${roundId}), spawned agents: ${agentTypes.join(', ')}`)
  return { roundId, transcriptChannel, chatChannel, agents }
}

async function closeBreakoutRoom(conversation, { roomId }) {
  if (!conversation.populated('channels')) await conversation.populate('channels')
  if (!conversation.populated('agents')) await conversation.populate('agents')

  for (const channel of conversation.channels) {
    if (channel.breakout?.roomId === roomId && channel.breakout?.active !== false) {
      channel.breakout.active = false
      await channel.save()
    }
  }

  for (const agent of conversation.agents) {
    if (!agent.active) continue
    if ((agent.agentConfig?.breakout as Record<string, unknown>)?.roomId === roomId) {
      await agentService.stopAgent(agent)
    }
  }

  logger.info(`Closed breakout room ${roomId} on conversation ${conversation._id}`)
}

async function closeBreakoutRound(conversation, roundId) {
  if (!conversation.populated('channels')) await conversation.populate('channels')

  const roomIds = new Set(
    conversation.channels
      .filter((c) => c.breakout?.roundId === roundId && c.breakout?.active !== false)
      .map((c) => c.breakout.roomId)
  )

  for (const roomId of roomIds) {
    await closeBreakoutRoom(conversation, { roomId })
  }

  logger.info(`Closed breakout round ${roundId} on conversation ${conversation._id}`)
}

async function reconvene(conversation) {
  if (!conversation.populated('agents')) await conversation.populate('agents')

  for (const agent of conversation.agents) {
    if (!agent.active) continue
    if (agent.agentConfig?.breakout) continue

    agent.conversationHistorySettings = {
      ...(agent.conversationHistorySettings || {}),
      includeBreakouts: true
    }
    agent.markModified('conversationHistorySettings')
    await agent.save()
  }

  logger.info(`Reconvened conversation ${conversation._id} with all breakout context`)
}

const breakoutService = { openBreakoutRoom, closeBreakoutRoom, closeBreakoutRound, reconvene }
export default breakoutService
