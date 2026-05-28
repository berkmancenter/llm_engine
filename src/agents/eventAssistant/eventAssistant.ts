import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import renderAgentTemplate from '../helpers/renderAgentTemplate.js'

import Message from '../../models/message.model.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import {
  eventAssistantLLMTemplates,
  eventAssistantLlmTemplateVars,
  answerQuestion,
  QuestionClassification
} from './eventQuestionHandler.js'
import { buildSystemPromptWithPersonality } from '../helpers/agentPersonality.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'

import logger from '../../config/logger.js'
import config from '../../config/config.js'
import getDefaultEventAssistantToolNames from './eventAssistantDefaultTools.js'
import generateImageResponse from './imageGenerator.js'
import { parseSlashCommands, hasCommand, extractMessageText, SlashCommand } from '../helpers/slashCommandParser.js'
import generateMindMap from './mindMapGenerator.js'
import { checkBotIntent, matchBotMention, normalizeBotMention } from '../helpers/intentChecks.js'

/**
 * Builds a dynamic capability description for the WELCOME check-in message.
 * Varies based on which tools and features are enabled in agentConfig.
 */
export function buildCheckinCapabilityDescription(agentConfig): string {
  const toolNames: string[] = agentConfig?.tools || []
  const hasWebSearch = toolNames.includes('web_search')
  const hasModerator = agentConfig?.moderatorSupport

  const capabilities = [
    '- Re-explain anything from the event in simpler terms',
    '- Answer any question about the event privately',
    '- Summarize what they missed if they stepped away',
    '- Clarify jargon or terminology used by the speaker'
  ]

  if (hasWebSearch) {
    capabilities.push('- Research related topics, people, or claims the speaker briefly mentioned')
  }
  capabilities.push('- Just work with a fragment like "I\'m lost" or "the second part" — no need to form a full question')
  capabilities.push('- Use /visual to get a diagram or image to help explain a concept')
  capabilities.push('- Use /mindmap to generate a visual map of the key topics discussed')

  if (hasModerator) {
    capabilities.push('- Use /mod to submit a question anonymously to the moderator for Q&A')
  }

  return capabilities.join('\n')
}

/**
 * Generates the first DM a participant receives — a warm, contextual intro that incorporates
 * the capability description and a brief trust note. Used by introduce() for all DM channels.
 * Called with `this` = agent instance.
 */
async function buildDmIntroMessage(this): Promise<string | null> {
  const botName = this.agentConfig?.botName || config.conversationBotName
  const personalityName = this.agentConfig?.personality ?? (config.enableAgentPersonality ? 'sarcastic-expert' : null)
  const capabilityDescription = buildCheckinCapabilityDescription(this.agentConfig)

  const base = `You are ${botName}, a private AI assistant for this event. Your job is to send a participant their very first message — a brief, warm welcome that sets concrete expectations for what this private channel is for.

Rules:
- Otherwise open with a simple "Hi!" — do not address the participant by name
- 2-3 sentences describing what this channel is for, with 1-2 concrete examples (e.g. asking a question privately, typing "I'm lost", asking for a recap)
- Include one brief trust note: their pseudonym keeps them anonymous, and their messages are never used to train AI models
- End with explicit permission to not respond: "No need to reply — just wanted you to know I'm here."
- Never imply the participant should participate more, or that silence is a problem
- Friendly and direct, not formal`

  const systemPrompt = buildSystemPromptWithPersonality(base, personalityName)

  const userPrompt = `You are sending the first message to a participant in a private channel at a live event.

Event: "${this.conversation.name}"
${this.conversation.description ? `Description: ${this.conversation.description}` : ''}
What ${botName} can do in this private channel:
${capabilityDescription}
Write their welcome message.`

  const llm = await this.getLLM()
  return (await getChatPromptResponse(llm, systemPrompt, userPrompt, {})) as string
}

const MODERATOR_MESSAGE_TYPES = new Set(['moderator_offered', 'moderator_submitted', 'moderator_declined'])

// Filter out moderator interaction messages before passing history to the LLM.
// Seeing these in history causes the model to spontaneously replicate the offer.
// Also drops the user's confirmed yes/no reply (sandwiched between moderator_offered
// and moderator_submitted/declined) since without the offer it becomes a non-sequitur.
function filterModeratorHistory(conversationHistory) {
  return {
    ...conversationHistory,
    messages: conversationHistory.messages?.filter((msg, i, msgs) => {
      if (msg.bodyType === 'json' && MODERATOR_MESSAGE_TYPES.has((msg.body as Record<string, unknown>)?.type as string)) {
        return false
      }
      const prev = msgs[i - 1]
      const next = msgs[i + 1]
      if (
        prev?.bodyType === 'json' &&
        (prev.body as Record<string, unknown>)?.type === 'moderator_offered' &&
        next?.bodyType === 'json' &&
        ((next.body as Record<string, unknown>)?.type === 'moderator_submitted' ||
          (next.body as Record<string, unknown>)?.type === 'moderator_declined')
      ) {
        return false
      }
      return true
    })
  }
}

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
    chatIntroMessage: `Welcome! I'm {{agentConfig.botName}}, your AI event assistant. This is a space to chat with other event participants. You can also ask me questions with an @{{agentConfig.botName}} mention. Just remember that everyone can see what you ask me here. Use the {{agentConfig.botName}} tab if you want to talk privately. Have fun!`,
    enablePersonality: config.enableAgentPersonality,
    zoomChatIntroMessage:
      "Welcome! I'm {{agentConfig.botName}}, your AI event assistant. You can ask me questions in the chat with an @{{agentConfig.botName}} mention. Or send me a DM if you want to talk privately.",
    tools: getDefaultEventAssistantToolNames()
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
    if (userMessage.fromAgent) {
      // Handle image generation requests from self
      if (userMessage?.channels?.includes('image-gen')) {
        return {
          userMessage,
          action: AgentMessageActions.CONTRIBUTE,
          userContributionVisible: true,
          suggestion: undefined
        }
      }
      // do not contribute to other agent messages
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
      return await answerQuestion.call(this, userMessage, filterModeratorHistory(conversationHistory))
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

    const agentResponses = await answerQuestion.call(this, modifiedMessage, filterModeratorHistory(conversationHistory), {
      forceVisual
    })

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
      // LLM-generated intro: capability description, trust note, no-reply close.
      try {
        const introText = await buildDmIntroMessage.call(this)
        return [
          {
            message: { text: introText, type: 'intro' },
            messageType: 'json',
            channels: [channel],
            visible: true
          }
        ]
      } catch (err) {
        logger.error('[introduce] LLM call failed for DM intro', err)
        return []
      }
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
