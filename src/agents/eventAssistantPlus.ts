import verify from './helpers/verify.js'
import { AgentMessageActions, AgentResponse, ConversationHistory } from '../types/index.types.js'
import { formatSingleUserConversationHistory } from './helpers/llmInputFormatters.js'
import {
  backChannelLLMTemplates,
  backChannelLLMTemplateVars,
  processParticipantMessages
} from './backChannel/backChannelInsightsGenerator.js'
import logger from '../config/logger.js'
import Message from '../models/message.model.js'
import { answerQuestion, eventAssistantLlmTemplateVars } from './eventAssistant/eventQuestionHandler.js'

const defaultLLMTemplates = {
  ...backChannelLLMTemplates,
  ...eventAssistantLlmTemplateVars
}

const llmTemplateVars = {
  ...backChannelLLMTemplateVars,
  ...eventAssistantLlmTemplateVars
}

const submitToModeratorQuestion = 'Would you like to submit this question anonymously to the moderator for Q&A?'
const submitToModeratorReply = 'Your message has been submitted to the moderator.'

function isAffirmative(text) {
  const normalized = text.trim().toLowerCase()
  const affirmativePatterns =
    /^(yes|yeah|yep|yup|sure|okay|ok|absolutely|definitely|certainly|affirmative|correct|right|indeed|of course|you bet|sounds good)/

  return affirmativePatterns.test(normalized)
}

export default verify({
  name: 'Event Assistant Plus',
  description: 'A combination of eventAssistant and backChannel for all your event needs',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { directMessages: true },
    periodic: { timerPeriod: 120, conversationHistorySettings: { timeWindow: 120, channels: ['participant'] } }
  },
  agentConfig: {
    introMessage:
      "Hi! I'm the LLM Event Assistant. If you miss something, or want a clarification on something that’s been said during the event, you can DM me. None of your messages to me will be surfaced to the moderator or the rest of the audience."
  },
  llmTemplateVars,
  defaultLLMTemplates,
  defaultLLMPlatform: 'openai',
  defaultLLMModel: 'gpt-4o-mini',
  ragCollectionName: undefined,
  parseOutput: (msg) => {
    if (msg.bodyType === 'text') {
      return msg
    }
    const translatedMsg = msg.toObject()
    translatedMsg.bodyType = 'text'
    translatedMsg.body = `💡 BACKCHANNEL REPORT 💡
${msg.body.insights.map((insight) => `⚫ ${insight.value}`).join('\n')}`
    return translatedMsg
  },
  useTranscriptRAGCollection: true,
  defaultConversationHistorySettings: { count: 100, directMessages: true },

  async initialize() {
    return true
  },
  async evaluate(userMessage) {
    return {
      userMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },
  async respond(conversationHistory: ConversationHistory, userMessage) {
    if (userMessage) {
      // TODO think through how to use replies for this? Not sure if we can get that info from Zoom
      // TODO if the user says yes + anything else in the reply text, that extra will not get processed.
      if (
        conversationHistory.messages.length > 1 &&
        conversationHistory.messages[conversationHistory.messages.length - 1].body === submitToModeratorQuestion
      ) {
        if (isAffirmative(userMessage.body)) {
          const message = await Message.findById(conversationHistory.messages[conversationHistory.messages.length - 3]._id)
          // TODO message not found
          message!.channels = message!.channels ?? []
          message!.channels.push('participant')
          await message!.save()
          return [
            {
              visible: true,
              message: submitToModeratorReply,
              channels: this.conversation.channels.filter((channel) => userMessage.channels.includes(channel.name))
            }
          ]
        }
        return []
      }
      const chatHistory = formatSingleUserConversationHistory(conversationHistory)

      const agentResponse = await answerQuestion.call(this, userMessage, chatHistory)
      const agentResponses: AgentResponse<string>[] = [agentResponse]
      // TODO not every semantic query will be on topic. Not harmful to push it through b/c backChannel functionality
      // should filter, but strange that we are asking?
      const onTopic = agentResponse.semantic
      if (onTopic) {
        agentResponses.push({
          visible: true,
          message: submitToModeratorQuestion,
          channels: this.conversation.channels.filter((channel) => userMessage.channels.includes(channel.name))
        })
      }

      return agentResponses
    }

    if (conversationHistory.messages.length === 0) {
      logger.debug('No periodic messages to process')
      return []
    }
    return processParticipantMessages.call(
      this,
      conversationHistory.messages,
      conversationHistory.start,
      conversationHistory.end
    )
  },
  async start() {
    return true
  },
  async stop() {
    return true
  },
  async introduce(channel) {
    if (channel.direct) {
      return [
        {
          message: this.agentConfig.introMessage,
          channels: [channel],
          visible: true
        }
      ]
    }
    return []
  }
})
