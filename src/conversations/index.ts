import eventAssistant from './eventAssistant.js'
import backChannel from './backChannel.js'
import type { ConversationType } from '../types/index.types.js'
import chatbot from './chatbot.js'
import eventHistorian from './eventHistorian.js'
import eventSetup from './eventSetup.js'
import vibesAnalyst from './vibesAnalyst.js'
import numberCruncher from './numberCruncher.js'
import scorekeeper from './scorekeeper.js'

// Internal conversation types are usable by the service but not exposed via the config API
const internal: Record<string, ConversationType> = {
  chatbot,
  eventHistorian,
  eventSetup,
  vibesAnalyst,
  numberCruncher,
  scorekeeper
}

const defaultConversationTypes: Record<string, ConversationType> = {
  eventAssistant,
  backChannel
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
