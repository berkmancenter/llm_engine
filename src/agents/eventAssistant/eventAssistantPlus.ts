import verify from '../helpers/verify.js'
import { AgentMessageActions, AgentResponse, ConversationHistory } from '../../types/index.types.js'
import { formatSingleUserConversationHistory } from '../helpers/llmInputFormatters.js'

import Message from '../../models/message.model.js'
import {
  eventAssistantLLMTemplates,
  eventAssistantLlmTemplateVars,
  answerQuestion,
  QuestionClassification
} from './eventQuestionHandler.js'

import logger from '../../config/logger.js'

const submitToModeratorQuestion = 'Would you like to submit this question anonymously to the moderator for Q&A?'
const submitToModeratorReply = 'Your message has been submitted to the moderator.'
const declineModeratorReply = "OK, I won't submit it. Feel free to ask me anything else!"
const submitToModeratorCommand = '/mod'

function isAffirmative(text) {
  const normalized = text.trim().toLowerCase()
  const affirmativePatterns =
    /^(yes|yeah|yep|yup|sure|okay|ok|absolutely|definitely|certainly|affirmative|correct|right|indeed|of course|you bet|sounds good)/

  return affirmativePatterns.test(normalized)
}

function isNegative(text) {
  const normalized = text.trim().toLowerCase()
  const negativePatterns =
    /^(no|nah|nope|naw|not really|don't|dont|never mind|nevermind|no thanks|no thank you|negative|not now|maybe later|i'm good|im good)/

  return negativePatterns.test(normalized)
}

function submitToModeratorResponse(userMessage, message) {
  return [
    {
      visible: true,
      message: { type: 'backchannel', text: submitToModeratorReply, message: message._id.toString() },
      messageType: 'json',
      channels: this.conversation.channels.filter((channel) => userMessage.channels.includes(channel.name) && channel.direct)
    }
  ]
}

function declineModeratorResponse(userMessage, message) {
  return [
    {
      visible: true,
      message: { type: 'backchannel', text: declineModeratorReply, message: message._id.toString() },
      messageType: 'json',
      channels: this.conversation.channels.filter(
        (channel) => userMessage.channels.includes(channel.name) && channel.direct === true
      )
    }
  ]
}

export default verify({
  name: 'Event Assistant Plus',
  description: 'A combination of eventAssistant and backChannel for all your event needs',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { directMessages: true }
  },
  agentConfig: {
    introMessage: `Hi! I'm the LLM Event Assistant. I'm listening to the event, so feel free to ask me questions like “what did I just miss,” or, “what was that acronym?” If you ask a (relevant!) question I can't answer, I'll ask if you want to send it through to the moderator. Use /mod to fast-track a message to the mod. The mod will get a digestible summary of questions.

A pseudonymized message transcript will be visible to our eng team. Thanks for trying the tool, please share your feedback at brk.mn/feedback!`
  },
  llmTemplateVars: eventAssistantLlmTemplateVars,
  defaultLLMTemplates: eventAssistantLLMTemplates,
  defaultLLMPlatform: 'openai',
  defaultLLMModel: 'gpt-4o-mini',
  parseOutput: (msg) => {
    if (msg.bodyType === 'text') {
      return msg
    }
    const translatedMsg = msg.toObject()
    translatedMsg.bodyType = 'text'
    translatedMsg.body = msg.body.text
    return translatedMsg
  },
  ragCollectionName: undefined,
  useTranscriptRAGCollection: true,
  defaultConversationHistorySettings: { count: 100, directMessages: true },

  async initialize() {
    return true
  },
  async evaluate(userMessage) {
    const modifiedMessage = { ...userMessage }
    if (modifiedMessage.body.trim().toString().toLowerCase().startsWith(submitToModeratorCommand)) {
      modifiedMessage!.channels = modifiedMessage!.channels ?? []
      modifiedMessage!.channels.push('participant')
      // Remove the '/mod ' command from the message body
      modifiedMessage.body = modifiedMessage.body.trim().substring(submitToModeratorCommand.length).trim()
    }
    return {
      userMessage: modifiedMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },
  async respond(conversationHistory: ConversationHistory, userMessage) {
    if (userMessage) {
      // Check if the previous message was asking about submitting to moderator
      const lastMessage = conversationHistory.messages[conversationHistory.messages.length - 1]

      if (
        conversationHistory.messages.length > 1 &&
        lastMessage.bodyType === 'json' &&
        (lastMessage.body as Record<string, unknown>).text === submitToModeratorQuestion
      ) {
        const originalMessageId = (lastMessage.body as Record<string, unknown>).message
        const message = await Message.findById(originalMessageId)
        if (isAffirmative(userMessage.body)) {
          if (!message) {
            logger.error(`Could not find original message with ID ${originalMessageId} to submit to moderator`)
            return []
          }
          message!.channels = message!.channels ?? []
          message!.channels.push('participant')
          await message!.save()
          return submitToModeratorResponse.call(this, userMessage, message)
        }

        if (isNegative(userMessage.body)) {
          return declineModeratorResponse.call(this, userMessage, message)
        }
        // If neither affirmative nor negative, fall through to process as a new question
      }

      if (userMessage.channels?.includes('participant')) {
        return submitToModeratorResponse.call(this, userMessage, userMessage)
      }

      const chatHistory = formatSingleUserConversationHistory(conversationHistory)

      const agentResponse = await answerQuestion.call(this, userMessage, chatHistory)
      const agentResponses: AgentResponse<string | Record<string, unknown>>[] = [agentResponse]
      const { classification } = agentResponse
      if (
        classification === QuestionClassification.UNANSWERABLE ||
        classification === QuestionClassification.ON_TOPIC_ASK_SPEAKER
      ) {
        agentResponses.push({
          visible: true,
          message: {
            type: 'backchannel',
            text: submitToModeratorQuestion,
            message: userMessage._id.toString()
          },
          messageType: 'json',
          channels: this.conversation.channels.filter((channel) => userMessage.channels.includes(channel.name)),
          replyFormat: {
            type: 'singleChoice',
            options: [
              { value: 'no', label: 'No' },
              { value: 'yes', label: 'Yes' }
            ]
          }
        })
      }
      return agentResponses
    }
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
