import { IChannel } from '../../types/index.types.js'

/**
 * Returns true if the given channel names include the agent's chat channel.
 * Breakout-aware: checks the breakout chat channel for room agents.
 */
export function isOnChatChannel(agent, channelNames: string[]): boolean {
  const breakout = agent.agentConfig?.breakout as { roomId: string } | undefined
  if (breakout) {
    return (agent.conversation.channels as IChannel[]).some(
      (c) => c.breakout?.roomId === breakout.roomId && c.breakout?.parentChannel === 'chat' && channelNames.includes(c.name)
    )
  }
  return channelNames.includes('chat')
}


/**
 * Returns the channel names of the given type to use when reading history:
 * - Breakout room agent: the breakout channel of that type for the agent's room.
 * - Reconvened main agent (includeBreakouts): parent channel + all breakout channels of that type.
 * - Otherwise: the default channel name ('chat' or 'transcript').
 */
function getHistoryChannelNames(agent, type: 'chat' | 'transcript'): string[] {
  const breakout = agent.agentConfig?.breakout as { roomId: string } | undefined
  if (breakout) {
    const channel = (agent.conversation.channels as IChannel[]).find(
      (c) => c.breakout?.roomId === breakout.roomId && c.breakout?.type === type
    )
    return channel ? [channel.name] : [type]
  }
  if (agent.conversationHistorySettings?.includeBreakouts) {
    const breakoutChannels = (agent.conversation.channels as IChannel[])
      .filter((c) => c.breakout?.type === type)
      .map((c) => c.name)
    return [type, ...breakoutChannels]
  }
  return [type]
}

/**
 * Returns the chat channel names to use when reading chat history.
 * Delegates to getHistoryChannelNames with type 'chat'.
 */
export function getChatHistoryChannelNames(agent): string[] {
  return getHistoryChannelNames(agent, 'chat')
}


/**
 * Returns the transcript channel names to use when reading transcript history.
 * Delegates to getHistoryChannelNames with type 'transcript'.
 */
export function getTranscriptHistoryChannelNames(agent): string[] {
  return getHistoryChannelNames(agent, 'transcript')
}

