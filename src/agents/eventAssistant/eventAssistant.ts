import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import {
  eventAssistantLLMTemplates,
  eventAssistantLlmTemplateVars,
  answerQuestion,
  generatePseudonymFunFact
} from './eventQuestionHandler.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import renderAgentTemplate from '../helpers/renderAgentTemplate.js'
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import generateImageResponse from './imageGenerator.js'
import { parseSlashCommands, hasCommand, extractMessageText, SlashCommand } from './slashCommandParser.js'
import generateMindMap from './mindMapGenerator.js'

// Supported slash commands for Event Assistant
const supportedCommands: SlashCommand[] = [
  { command: 'visual', prefix: '/visual ' },
  { command: 'mindmap', prefix: '/mindmap' }
]

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
      "Hey! I'm {{agentConfig.botName}}. Ask me about what's happening, or use '/' commands for special functions.",
    chatIntroMessage:
      'Welcome to the chat! This is a space to chat with other event participants. You can also ask me questions with an @{{agentConfig.botName}} mention. Just remember that everyone can see what you ask me here. Use the {{agentConfig.botName}} tab if you want to talk privately. Have fun!',
    enablePersonality: config.enableAgentPersonality
  },
  llmTemplateVars: eventAssistantLlmTemplateVars,
  defaultLLMTemplates: eventAssistantLLMTemplates,
  defaultLLMPlatform,
  defaultLLMModel,
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

    if (userMessage?.channels?.includes('chat') && !userMessage?.body.includes(`@${this.agentConfig.botName}`)) {
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
  async respond(conversationHistory: ConversationHistory, userMessage, options?) {
    // Handle image generation requests from self
    if (userMessage?.channels?.includes('image-gen')) {
      const imageResponse = await generateImageResponse(userMessage, this.conversation)
      return imageResponse ? [imageResponse] : []
    }

    // Handle mind map command
    if (hasCommand(userMessage, 'mindmap')) {
      return await generateMindMap(this, userMessage)
    }

    const modifiedMessage = { ...userMessage }

    // Check for visual command (set in evaluate)
    const forceVisual = hasCommand(userMessage, 'visual')

    // Extract text from JSON body if present
    modifiedMessage.body = extractMessageText(userMessage)

    if (userMessage?.channels?.includes('chat')) {
      // trim the '@${this.agentConfig.botName}' from the message body so it's just a regular question
      modifiedMessage.body = modifiedMessage.body.trim().replaceAll(`@${this.agentConfig.botName}`, '').trim()
    }
    const agentResponse = await answerQuestion.call(this, modifiedMessage, conversationHistory, { ...options, forceVisual })
    return [agentResponse]
  },
  async start() {
    return true
  },
  async stop() {
    return true
  },
  async introduce(channel) {
    logger.debug(
      `[introduce] eventAssistant called for channel: ${channel.name}, direct: ${channel.direct}, agentConfig.botName: ${this.agentConfig?.botName}`
    )
    if (channel.direct) {
      const { introMessage: defaultIntroMessage } = this.agentConfig
      logger.debug(`[introduce] DM path - defaultIntroMessage: ${defaultIntroMessage}`)
      let introMessage
      try {
        introMessage = renderAgentTemplate(defaultIntroMessage, this.toObject())
        logger.debug(`[introduce] DM rendered introMessage: ${introMessage}`)
      } catch (err) {
        logger.error(`[introduce] renderAgentTemplate error (DM): ${err}`)
        throw err
      }

      const funFact = await generatePseudonymFunFact.call(this, channel)
      if (funFact) {
        introMessage = `${introMessage}\n\n${funFact}`
      }

      return [
        {
          message: introMessage,
          channels: [channel],
          visible: true
        }
      ]
    }
    if (channel.name === 'chat') {
      return [
        {
          message: renderAgentTemplate(this.agentConfig.chatIntroMessage, this.toObject()),
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
