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
import { checkBotIntent, matchBotMention, normalizeBotMention } from '../helpers/intentChecks.js'

const submitToModeratorQuestion = 'Would you like to submit this question anonymously to the moderator for Q&A?'
const submitToModeratorReply = 'Your message has been submitted to the moderator.'
const declineModeratorReply = "OK, I won't submit it. Feel free to ask me anything else!"
const submitToModeratorCommand = '/mod'
const mindMapCommand = '/mindmap'

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

async function handleModeratorReply(conversationHistory, userMessage) {
  const lastMessage = conversationHistory.messages[conversationHistory.messages.length - 1]
  if (
    conversationHistory.messages.length > 1 &&
    lastMessage.bodyType === 'json' &&
    (lastMessage.body as Record<string, unknown>).text === submitToModeratorQuestion
  ) {
    const originalMessageId = (lastMessage.body as Record<string, unknown>).message
    const message = await Message.findById(originalMessageId)
    const responseText = extractMessageText(userMessage)

    if (isAffirmative(responseText)) {
      if (!message) {
        logger.error(`Could not find original message with ID ${originalMessageId} to submit to moderator`)
        return []
      }
      message.channels = message.channels ?? []
      message.channels.push('participant')
      await message.save()
      return submitToModeratorResponse.call(this, userMessage, message)
    }

    if (isNegative(responseText)) {
      if (!message) {
        logger.error(`Could not find original message with ID ${originalMessageId} to send acknowledgement of decline`)
        return []
      }
      return declineModeratorResponse.call(this, userMessage, message)
    }
    // Neither affirmative nor negative — fall through to process as a new question
  }
  return null
}

function offerModeratorSubmission(userMessage, agentResponses, conversation) {
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
      channels: conversation.channels.filter((channel) => userMessage.channels.includes(channel.name)),
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
}

export default verify({
  name: 'Event Assistant',
  description: 'An assistant to answer questions about an event',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { directMessages: true, channels: ['chat', 'image-gen'], allowMessagesFromAgents: true }
  },
  agentConfig: {
    introMessage:
      "Hi! I'm {{agentConfig.botName}}, your AI event assistant. Ask me anything, or tap '/' to see available commands.",
    chatIntroMessage: `Welcome! I'm {{agentConfig.botName}}, your AI event assistant. This is a space to chat with other event participants. You can also ask me questions with an @{{agentConfig.botName}} mention. Just remember that everyone can see what you ask me here. Use the {{agentConfig.botName}} tab if you want to talk privately. Have fun!`,
    enablePersonality: config.enableAgentPersonality,
    zoomIntroMessage: "Hi! I'm {{agentConfig.botName}}, your AI event assistant. Ask me anything about the event!",
    zoomChatIntroMessage:
      "Welcome! I'm {{agentConfig.botName}}, your AI event assistant. You can ask me questions in the chat with an @{{agentConfig.botName}} mention. Or send me a DM if you want to talk privately."
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
  defaultConversationHistorySettings: { count: 100, directMessages: true, channels: ['chat'] },

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

    // Parse slash commands using shared parser
    const activeCommands = this.agentConfig?.moderatorSupport
      ? supportedCommands
      : supportedCommands.filter((c) => c.command !== 'mod')
    let modifiedMessage = parseSlashCommands(userMessage, activeCommands)

    if (modifiedMessage?.channels?.includes('chat')) {
      const words = modifiedMessage?.body?.trim().split(/\s+/) ?? []
      if (matchBotMention(words, this.agentConfig?.botName)) {
        modifiedMessage = { ...modifiedMessage, body: normalizeBotMention(modifiedMessage.body, this.agentConfig?.botName) }
      }
    }

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
      const llm = await this.getLLM()
      if (!(await checkBotIntent(llm, this.agentConfig?.botName, userMessage))) {
        return []
      }
      return await answerQuestion.call(this, userMessage, conversationHistory)
    }

    if (this.agentConfig?.moderatorSupport) {
      const moderatorReply = await handleModeratorReply.call(this, conversationHistory, userMessage)
      if (moderatorReply !== null) return moderatorReply

      if (userMessage.channels?.includes('participant')) {
        return submitToModeratorResponse.call(this, userMessage, userMessage)
      }
    }

    // Check for visual command (set in evaluate)
    const forceVisual = hasCommand(userMessage, 'visual')

    // Extract text from JSON body if present for processing
    const modifiedMessage = { ...userMessage }
    modifiedMessage.body = extractMessageText(userMessage)

    const agentResponses = await answerQuestion.call(this, modifiedMessage, conversationHistory, { forceVisual })

    if (this.agentConfig?.moderatorSupport) {
      offerModeratorSubmission(userMessage, agentResponses, this.conversation)
    }

    return agentResponses
  },
  async start() {
    return true
  },
  async stop() {
    return true
  },
  async introduce(channel, adapterType?) {
    logger.debug(
      `[introduce] eventAssistant called for channel: ${channel.name}, direct: ${channel.direct}, adapterType: ${
        adapterType ?? 'socket'
      }, agentConfig.botName: ${this.agentConfig?.botName}`
    )
    if (channel.direct) {
      const templateStr = adapterType === 'zoom' ? this.agentConfig.zoomIntroMessage : this.agentConfig.introMessage
      logger.debug(`[introduce] DM path - templateStr: ${templateStr}`)
      let introMessage
      try {
        introMessage = renderAgentTemplate(templateStr, this.toObject())
        logger.debug(`[introduce] DM rendered introMessage: ${introMessage}`)
      } catch (err) {
        logger.error(`[introduce] renderAgentTemplate error (DM): ${err}`)
        throw err
      }

      if (adapterType === 'zoom' && this.agentConfig?.moderatorSupport) {
        introMessage = `${introMessage} Use /mod to send a question to the moderator.`
      }

      if (adapterType !== 'zoom') {
        const funFact = await generatePseudonymFunFact.call(this, channel)
        if (funFact) {
          introMessage = `${introMessage}\n\n${funFact}`
        }
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
      const templateStr = adapterType === 'zoom' ? this.agentConfig.zoomChatIntroMessage : this.agentConfig.chatIntroMessage
      return [
        {
          message: {
            text: renderAgentTemplate(templateStr, this.toObject()),
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
