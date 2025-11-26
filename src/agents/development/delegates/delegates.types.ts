/**
 * @typedef {Object} ConversationPhase
 * @property {Message} question
 * @property {Message[]} conversation
 */

/**
 * @typedef {Object} PersonalityPreference
 * @property {String[]} insights
 * @property {String} behavior
 *
 *
 */

export interface Delegate {
  personality: string
  interest: string
  pseudonym: string
  question: string
}
