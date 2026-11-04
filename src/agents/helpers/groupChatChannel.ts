import { IConversation } from '../../types/index.types.js'
import { CHAT_CHANNEL, PREGAME_CHANNEL } from '../../conversations/eventAssistant.js'
import isPreEventWindowOpen from '../../services/conversation.service/preEventWindow.js'

/** Every channel name that carries the shared group chat, across both conversation phases. */
export const GROUP_CHAT_CHANNELS = [CHAT_CHANNEL, PREGAME_CHANNEL]

/** Whether a message's channels include the group chat, regardless of which phase it was sent in. */
export function isGroupChatMessage(channels?: string[]): boolean {
  return !!channels?.some((channel) => (GROUP_CHAT_CHANNELS as string[]).includes(channel))
}

/** Which group chat channel name is live right now, for addressing a new outgoing message. */
export function currentGroupChannelName(
  conversation: Pick<IConversation, 'scheduledTime' | 'preEventMinutes' | 'startTime' | 'endTime' | 'draft'>
): string {
  return isPreEventWindowOpen(conversation) ? PREGAME_CHANNEL : CHAT_CHANNEL
}
