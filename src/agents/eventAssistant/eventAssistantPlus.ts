import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import renderAgentTemplate from '../helpers/renderAgentTemplate.js'

import Message from '../../models/message.model.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import {
  eventAssistantLLMTemplates,
  eventAssistantLlmTemplateVars,
  answerQuestion,
  QuestionClassification,
  generatePseudonymFunFact
} from './eventQuestionHandler.js'

import logger from '../../config/logger.js'
import config from '../../config/config.js'
import generateImageResponse from './imageGenerator.js'
import { parseSlashCommands, hasCommand, extractMessageText, SlashCommand } from '../helpers/slashCommandParser.js'
import generateMindMap from './mindMapGenerator.js'

const submitToModeratorQuestion = 'Would you like to submit this question anonymously to the moderator for Q&A?'
const submitToModeratorReply = 'Your message has been submitted to the moderator.'
const declineModeratorReply = "OK, I won't submit it. Feel free to ask me anything else!"
const submitToModeratorCommand = '/mod'
const mindMapCommand = '/mindmap'

// Supported slash commands for Event Assistant Plus
const supportedCommands: SlashCommand[] = [
  { command: 'mod', prefix: submitToModeratorCommand, addToChannels: ['participant'] },
  { command: 'visual', prefix: '/visual ' },
  { command: 'mindmap', prefix: mindMapCommand }
]

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
      message: { type: 'moderator_submitted', text: submitToModeratorReply, message: message._id.toString() },
      messageType: 'json',
      channels: this.conversation.channels.filter(
        (channel) => userMessage.channels.includes(channel.name) && channel.direct
      ),
      parent: userMessage.parentMessage
    }
  ]
}

function declineModeratorResponse(userMessage, message) {
  return [
    {
      visible: true,
      message: { type: 'moderator_declined', text: declineModeratorReply, message: message._id.toString() },
      messageType: 'json',
      channels: this.conversation.channels.filter(
        (channel) => userMessage.channels.includes(channel.name) && channel.direct === true
      ),
      parent: userMessage.parentMessage
    }
  ]
}

export default verify({
  name: 'Event Assistant Plus',
  description: 'A combination of eventAssistant and backChannel for all your event needs',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { directMessages: true, channels: ['chat', 'image-gen'], allowMessagesFromAgents: true }
  },
  agentConfig: {
    introMessage:
      "Hey! I'm {{agentConfig.botName}}. Ask me about what's happening, or use '/' commands for special functions.",
    chatIntroMessage:
      'Welcome to the chat! This is a space to chat with other event participants. You can also ask me questions with an @{{agentConfig.botName}} mention. Just remember that everyone can see what you ask me here. Use the {{agentConfig.botName}} tab if you want to talk privately. Have fun!',
    enablePersonality: config.enableAgentPersonality,
    ragTopic: 'AI Triad'
  },
  llmTemplateVars: eventAssistantLlmTemplateVars,
  defaultLLMTemplates: eventAssistantLLMTemplates,
  defaultLLMPlatform,
  defaultLLMModel,
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
  defaultConversationHistorySettings: { count: 100, directMessages: true, channels: ['chat'] },

  async initialize() {
    return true
  },
  async evaluate(userMessage) {
    if (userMessage.pseudonym === this.name) {
      // Handle image generation requests from self
      if (userMessage?.channels?.includes('image-gen')) {
        return {
          userMessage,
          action: AgentMessageActions.CONTRIBUTE,
          userContributionVisible: true,
          suggestion: undefined
        }
      }
      // do not contribute to your own messages
      return {
        userMessage,
        action: AgentMessageActions.OK,
        userContributionVisible: true,
        suggestion: undefined
      }
    }

    if (
      userMessage?.channels?.includes('chat') &&
      !userMessage?.body.toLowerCase().includes(`@${this.agentConfig.botName}`.toLowerCase())
    ) {
      // regular chat message, no need to process
      return {
        userMessage,
        action: AgentMessageActions.OK,
        userContributionVisible: true,
        suggestion: undefined
      }
    }

    // Parse slash commands using shared parser
    const modifiedMessage = parseSlashCommands(userMessage, supportedCommands)

    return {
      userMessage: modifiedMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },
  async respond(conversationHistory: ConversationHistory, userMessage) {
    // Handle image generation requests from self
    if (userMessage?.channels?.includes('image-gen')) {
      const imageResponse = await generateImageResponse(userMessage, this.conversation)
      return imageResponse ? [imageResponse] : []
    }

    // Handle mind map command
    if (hasCommand(userMessage, 'mindmap')) {
      return await generateMindMap(this, userMessage)
    }

    // Message on chat channel?
    if (userMessage?.channels?.includes('chat')) {
      const modifiedMessage = { ...userMessage }
      // trim the '@${this.agentConfig.botName}' from the message body so it's just a regular question
      const escapedBotName = this.agentConfig.botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // eslint-disable-next-line security/detect-non-literal-regexp
      const botMentionRegex = new RegExp(`@${escapedBotName}`, 'gi')
      modifiedMessage.body = modifiedMessage.body.trim().replace(botMentionRegex, '').trim()
      const agentResponses = await answerQuestion.call(this, modifiedMessage, conversationHistory)
      return agentResponses
    }

    // Check if the previous message was asking about submitting to moderator
    const lastMessage = conversationHistory.messages[conversationHistory.messages.length - 1]

    if (
      conversationHistory.messages.length > 1 &&
      lastMessage.bodyType === 'json' &&
      (lastMessage.body as Record<string, unknown>).text === submitToModeratorQuestion
    ) {
      const originalMessageId = (lastMessage.body as Record<string, unknown>).message
      const message = await Message.findById(originalMessageId)
      // Get the text from body (handle both string and JSON body types)
      const responseText = extractMessageText(userMessage)
      if (isAffirmative(responseText)) {
        if (!message) {
          logger.error(`Could not find original message with ID ${originalMessageId} to submit to moderator`)
          return []
        }
        message!.channels = message!.channels ?? []
        message!.channels.push('participant')
        await message!.save()
        return submitToModeratorResponse.call(this, userMessage, message)
      }

      if (isNegative(responseText)) {
        return declineModeratorResponse.call(this, userMessage, message)
      }
      // If neither affirmative nor negative, fall through to process as a new question
    }

    if (userMessage.channels?.includes('participant')) {
      return submitToModeratorResponse.call(this, userMessage, userMessage)
    }

    // Check for visual command (set in evaluate)
    const forceVisual = hasCommand(userMessage, 'visual')

    // Extract text from JSON body if present for processing
    const modifiedMessage = { ...userMessage }
    modifiedMessage.body = extractMessageText(userMessage)

    const agentResponses = await answerQuestion.call(this, modifiedMessage, conversationHistory, { forceVisual })
    const { classification } = agentResponses[0]
    if (
      classification === QuestionClassification.UNANSWERABLE ||
      classification === QuestionClassification.ON_TOPIC_ASK_SPEAKER
    ) {
      agentResponses.push({
        visible: true,
        message: {
          type: 'moderator_offered',
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
        },
        parent: userMessage.parentMessage
      })
    }
    return agentResponses
  },
  async start() {
    return true
  },
  async stop() {
    return true
  },
  async introduce(channel) {
    if (channel.direct) {
      const { introMessage: defaultIntroMessage } = this.agentConfig
      let introMessage = renderAgentTemplate(defaultIntroMessage, this.toObject())

      const funFact = await generatePseudonymFunFact.call(this, channel)
      if (funFact) {
        introMessage = `${introMessage}\n\n${funFact}`
      }

      return [
        {
          message: {
            text: introMessage,
            type: 'intro'
          },
          messageType: 'json',
          channels: [channel],
          visible: true
        }
      ]
    }
    if (channel.name === 'chat') {
      return [
        {
          message: {
            text: renderAgentTemplate(this.agentConfig.chatIntroMessage, this.toObject()),
            type: 'intro'
          },
          messageType: 'json',
          channels: [channel],
          visible: true
        }
      ]
    }
    return []
  },
  formatTraceInput(conversationHistory, userMessage) {
    return userMessage?.body
  },

  formatTraceOutput(responses) {
    return responses[0]?.message
  },

  getTraceMetadata(conversationHistory, userMessage, responses) {
    return {
      context: responses[0]?.context,
      conversationHistory,
      channels: userMessage?.channels,
      promptType: responses[0]?.promptType,
      topic: responses[0]?.topic
    }
  }
})
