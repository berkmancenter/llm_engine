import eventAssistant from './eventAssistant.js'
import backChannel from './backChannel.js'
import eventAssistantPlus from './eventAssistantPlus.js'
import eventChannelMediator from './eventChannelMediator.js'
import eventChannelMediatorPlus from './eventChannelMediatorPlus.js'
import type { ConversationType } from '../types/index.types.js'

const defaultConversationTypes: Record<string, ConversationType> = {
  eventAssistant,
  backChannel,
  eventAssistantPlus,
  eventChannelMediator,
  eventChannelMediatorPlus
}

let conversationTypes: Record<string, ConversationType> = { ...defaultConversationTypes }

export const getConversationType = (typeName: string): ConversationType | undefined => conversationTypes[typeName]

export const getAllConversationTypes = (): Record<string, ConversationType> => ({ ...conversationTypes })

export const setConversationTypes = (types: Record<string, ConversationType>): void => {
  conversationTypes = types
}

export const resetConversationTypes = (): void => {
  conversationTypes = { ...defaultConversationTypes }
}

export default Object.freeze({ ...defaultConversationTypes })
