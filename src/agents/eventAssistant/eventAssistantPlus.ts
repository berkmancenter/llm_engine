import verify from '../helpers/verify.js'
import { AgentMessageActions, AgentResponse, ConversationHistory } from '../../types/index.types.js'
import { formatSingleUserConversationHistory } from '../helpers/llmInputFormatters.js'

import Message from '../../models/message.model.js'
import { eventAssistantLLMTemplates, eventAssistantLlmTemplateVars, answerQuestion } from './eventQuestionHandler.js'

const submitToModeratorQuestion = 'Would you like to submit this question anonymously to the moderator for Q&A?'
const submitToModeratorReply = 'Your message has been submitted to the moderator.'
const submitToModeratorCommand = '/mod'

function isAffirmative(text) {
  const normalized = text.trim().toLowerCase()
  const affirmativePatterns =
    /^(yes|yeah|yep|yup|sure|okay|ok|absolutely|definitely|certainly|affirmative|correct|right|indeed|of course|you bet|sounds good)/

  return affirmativePatterns.test(normalized)
}

function submitToModeratorResponse(userMessage) {
  return [
    {
      visible: true,
      message: submitToModeratorReply,
      channels: this.conversation.channels.filter((channel) => userMessage.channels.includes(channel.name))
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
    introMessage:
      "Hi! I'm the LLM Event Assistant. If you miss something, or want a clarification on something that’s been said during the event, you can DM me. None of your messages to me will be surfaced to the moderator or the rest of the audience."
  },
  llmTemplateVars: eventAssistantLlmTemplateVars,
  defaultLLMTemplates: eventAssistantLLMTemplates,
  defaultLLMPlatform: 'openai',
  defaultLLMModel: 'gpt-4o-mini',
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
          return [submitToModeratorResponse.call(this, userMessage)]
        }
        return []
      }
      if (userMessage.channels?.includes('participant')) {
        return [submitToModeratorResponse.call(this, userMessage)]
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
