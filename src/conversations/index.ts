import eventAssistant from './eventAssistant.js'
import backChannel from './backChannel.js'
import type { ConversationType } from '../types/index.types.js'

const defaultConversationTypes: Record<string, ConversationType> = {
  eventAssistant,
  backChannel
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
