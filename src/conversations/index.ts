import eventAssistant from './eventAssistant.js'
import backChannel from './backChannel.js'
import eventAssistantPlus from './eventAssistantPlus.js'
import type { ConversationType } from '../types/index.types.js'
import chatbot from './chatbot.js'

// Internal conversation types are usable by the service but not exposed via the config API
const internal: Record<string, ConversationType> = {
  chatbot
}

const defaultConversationTypes: Record<string, ConversationType> = {
  eventAssistant,
  backChannel,
  eventAssistantPlus
}

let conversationTypes: Record<string, ConversationType> = { ...defaultConversationTypes, ...internal }

export const getConversationType = (typeName: string): ConversationType | undefined => conversationTypes[typeName]

export const getAllConversationTypes = (): Record<string, ConversationType> => ({ ...conversationTypes })

export const setConversationTypes = (types: Record<string, ConversationType>): void => {
  conversationTypes = types
}

export const resetConversationTypes = (): void => {
  conversationTypes = { ...defaultConversationTypes, ...internal }
}

export default Object.freeze({ ...defaultConversationTypes })
