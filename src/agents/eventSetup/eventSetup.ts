import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { matchBotMention, normalizeBotMention } from '../helpers/intentChecks.js'
import {
  ROUND_PROMPTS,
  buildConfirmationPrompt,
  createEvent,
  extractFieldsFromThread,
  formatCompletionReply,
  getNextRound,
  getThreadMessages,
  lookupTopicByName
} from './fieldCollection.js'
import logger from '../../config/logger.js'

const SETUP_INTENT_PATTERNS = [/\bsetup\b/i, /\bcreate event\b/i, /\bcreate an? event\b/i, /\bnew event\b/i]

export default verify({
  name: 'Event Setup',
  description: 'Collects event details from organizers via Slack and creates a new nextspace event',
  priority: 100,
  maxTokens: 4000,
  defaultTriggers: {
    perMessage: { channels: ['setup'] }
  },
  agentConfig: {
    botName: 'Eventbot'
  },
  llmTemplateVars: {},
  defaultLLMTemplates: {},
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  defaultConversationHistorySettings: { count: 50, channels: ['setup'] },

  async evaluate(userMessage) {
    const body = userMessage?.body ?? ''
    const { botName } = this.agentConfig
    const words = body.trim().split(/\s+/)

    const hasBotMention = matchBotMention(words, botName)
    const hasSetupIntent = SETUP_INTENT_PATTERNS.some((pattern) => pattern.test(body))
    // A threaded reply means the organizer is mid-setup, so accept it
    // without requiring a bot mention.
    const isThreadReply = Boolean(userMessage?.parentMessage)

    if (hasBotMention || hasSetupIntent || isThreadReply) {
      const modifiedMessage = hasBotMention ? { ...userMessage, body: normalizeBotMention(body, botName) } : userMessage
      return {
        userMessage: modifiedMessage,
        action: AgentMessageActions.CONTRIBUTE,
        userContributionVisible: true,
        suggestion: undefined
      }
    }

    return {
      userMessage,
      action: AgentMessageActions.OK,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(conversationHistory: ConversationHistory, userMessage) {
    const setupChannel = this.conversation.channels.find((channel) => channel.name === 'setup')
    const channels = setupChannel ? [setupChannel] : []
    // Reply in-thread so the setup exchange stays grouped under the
    // organizer's first message.
    const parent = userMessage.parentMessage || userMessage._id

    const reply = (message: string) => [{ visible: true, message, messageType: 'text', channels, parent }]

    const llm = await this.getLLM()
    const thread = getThreadMessages(conversationHistory, userMessage)
    const fields = await extractFieldsFromThread(llm, thread, new Date(), this.agentConfig.botName)
    logger.debug(`eventSetup extracted fields: ${JSON.stringify(fields)}`)
    const nextRound = getNextRound(fields)

    if (nextRound === 'confirmation') {
      const topicResult = await lookupTopicByName(fields.topicName!)
      if (topicResult.options && topicResult.options.length > 1) {
        const list = topicResult.options.map((t, i) => `${i + 1}. ${t.name}`).join('\n')
        return reply(`I found multiple topics matching "${fields.topicName}". Which one?\n${list}`)
      }
      const confirmationOptions = topicResult.match
        ? { resolvedTopicName: topicResult.match.name }
        : { topicWarning: "couldn't find this topic in Nextspace — create it there first, then tell me the name" }
      return reply(buildConfirmationPrompt(fields, confirmationOptions))
    }
    if (nextRound !== 'complete') {
      return reply(ROUND_PROMPTS[nextRound])
    }

    const topicResult = await lookupTopicByName(fields.topicName!)
    if (!topicResult.match) {
      if (topicResult.options && topicResult.options.length > 1) {
        const list = topicResult.options.map((t, i) => `${i + 1}. ${t.name}`).join('\n')
        return reply(`I found multiple topics matching "${fields.topicName}". Which one?\n${list}`)
      }
      return reply(
        `I couldn't find a topic named "${fields.topicName}" in Nextspace. Please create it there first, then reply with the topic name.`
      )
    }

    try {
      const event = await createEvent(fields, String(topicResult.match.id ?? topicResult.match._id))
      return reply(formatCompletionReply(event, fields))
    } catch (err) {
      logger.error(`eventSetup createEvent failed: ${(err as Error).message}`)
      return reply(`I hit an error creating the event: ${(err as Error).message}`)
    }
  },

  async start() {
    return true
  },

  async stop() {
    return true
  },

  formatTraceInput(_conversationHistory, userMessage) {
    return userMessage?.body
  },

  formatTraceOutput(responses) {
    return responses[0]?.message
  },

  getTraceMetadata(conversationHistory, userMessage, responses) {
    return {
      conversationHistory,
      channels: userMessage?.channels,
      topic: responses[0]?.topic
    }
  }
})
