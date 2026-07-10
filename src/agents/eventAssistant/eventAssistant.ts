import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory, IChannel, IMessage } from '../../types/index.types.js'
import { buildCheckinResponses } from './checkinHandler.js'
import renderAgentTemplate from '../helpers/renderAgentTemplate.js'

import Message from '../../models/message.model.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { eventAssistantLLMTemplates, eventAssistantLlmTemplateVars, answerQuestion } from './eventQuestionHandler.js'
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
export function buildCheckinCapabilityDescription(agentConfig, adapterType?: string): string {
  const toolNames: string[] = agentConfig?.tools || []
  const hasWebSearch = toolNames.includes('web_search')
  const hasModerator = agentConfig?.moderatorSupport
  const isZoom = adapterType === 'zoom'

  const capabilities = [
    '- Re-explain anything from the event in simpler terms',
    '- Answer any question about the event privately',
    '- Summarize what they missed if they stepped away',
    '- Clarify jargon or terminology used by the speaker'
  ]

  if (hasWebSearch) {
    capabilities.push('- Research related topics, people, or claims the speaker briefly mentioned')
  }
  if (!isZoom) {
    capabilities.push('- Use /visual to get a diagram or image to help explain a concept')
    capabilities.push('- Use /mindmap to generate a visual map of the key topics discussed')
    if (hasModerator) {
      capabilities.push('- Use /mod to submit a question anonymously to the moderator for Q&A')
    }
  }

  for (let i = capabilities.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[capabilities[i], capabilities[j]] = [capabilities[j], capabilities[i]]
  }

  return capabilities.join('\n')
}

/**
 * Generates the first DM a participant receives — a warm, contextual intro that incorporates
 * the capability description and a brief trust note. Used by introduce() for all DM channels.
 * Called with `this` = agent instance.
 */
async function buildDmIntroMessage(this, adapterType?: string): Promise<string | null> {
  const botName = this.agentConfig?.botName || config.conversationBotName
  const personalityName = this.agentConfig?.personality ?? (config.enableAgentPersonality ? 'sarcastic-expert' : null)
  const capabilityDescription = buildCheckinCapabilityDescription(this.agentConfig, adapterType)

  const base = `You are ${botName}, a private AI assistant for this event. Write 1-2 short sentences highlighting what you can help with. Prefer natural, conversational examples (e.g. "ask me to catch you up" or "ask me to simplify something") over listing slash commands. Do not re-explain the channel's purpose or privacy. Friendly and direct, not formal. Output only those sentences, nothing else.`

  const systemPrompt = buildSystemPromptWithPersonality(base, personalityName)

  const userPrompt = `Event: "${this.conversation.name}"
${this.conversation.description ? `Description: ${this.conversation.description}` : ''}
Available capabilities (pick 1-2 to highlight):
${capabilityDescription}`

  const llm = await this.getLLM()
  const body = await getChatPromptResponse(llm, systemPrompt, userPrompt, {})
  let commandHint: string
  if (adapterType === 'zoom') {
    commandHint = this.agentConfig?.moderatorSupport ? 'Use /mod to send a question to the moderator.' : ''
  } else {
    commandHint = 'Just type / if you want to see what else I can do.'
  }
  return `Hi! I'm ${botName}, your private, anonymous support during this session. ${body}${
    commandHint ? ` ${commandHint}` : ''
  } Your pseudonym keeps you anonymous, and nothing you share is ever used to train AI models. No need to respond, just know I'm here.`
}

// Filter /mod and /escalate command messages and moderator_submitted replies from LLM history so
// they don't appear as unanswered questions, causing the LLM to re-answer them on the next turn.
function filterModeratorHistory(conversationHistory) {
  return {
    ...conversationHistory,
    messages: conversationHistory.messages?.filter((msg) => {
      if (msg.bodyType === 'json') {
        const body = msg.body as Record<string, unknown>
        const command = body?.command
        if (command === 'mod' || command === 'escalate') return false
        if (body?.type === 'moderator_submitted') return false
      }
      return true
    })
  }
}

const submitToModeratorReply = 'Your message has been submitted to the moderator.'
const submitToModeratorCommand = '/mod'
const mindMapCommand = '/mindmap'

const escalateCommand = '/escalate '

const supportedCommands: SlashCommand[] = [
  { command: 'mod', prefix: submitToModeratorCommand, addToChannels: ['participant'] },
  { command: 'escalate', prefix: escalateCommand },
  { command: 'visual', prefix: '/visual ' },
  { command: 'mindmap', prefix: mindMapCommand }
]

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

type TraceResponse = {
  message?: unknown
  context?: string
  participantPseudonym?: string
  eligibleTypes?: string[]
  checkinType?: string
  confidenceScore?: number
  detectedPattern?: string
  reasoning?: string
  promptType?: string
  topic?: string
  channels?: IChannel[]
}

export default verify({
  name: 'Event Assistant',
  description: 'An assistant to answer questions about an event',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { directMessages: true, channels: ['chat', 'image-gen'], allowMessagesFromAgents: true },
    periodic: { timerPeriod: 180, proactive: true }
  },
  agentConfig: {
    chatIntroMessage: `Welcome! I'm {{agentConfig.botName}}, your AI event assistant. This is a space to chat with other event participants. You can also ask me questions with an @{{agentConfig.botName}} mention. Just remember that everyone can see what you ask me here. Use the {{agentConfig.botName}} tab if you want to talk privately. Have fun!`,
    enablePersonality: config.enableAgentPersonality,
    zoomChatIntroMessage:
      "Welcome! I'm {{agentConfig.botName}}, your AI event assistant. You can ask me questions in the chat with an @{{agentConfig.botName}} mention. Or send me a DM if you want to talk privately.",
    tools: getDefaultEventAssistantToolNames(),
    seriesHistory: false, // when true, gives the assistant access to other past events in the same series
    minInterval: 10 // minimum minutes between check-ins per participant
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
    if (!userMessage) {
      return {
        action: AgentMessageActions.CONTRIBUTE,
        userMessage,
        userContributionVisible: true,
        suggestion: undefined
      }
    }
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
      : supportedCommands.filter((c) => c.command !== 'mod' && c.command !== 'escalate')
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
    // Periodic check-in tick (no userMessage means this was triggered by the periodic job)
    if (!userMessage) {
      return buildCheckinResponses.call(this, conversationHistory)
    }

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

    if (this.agentConfig?.moderatorSupport && hasCommand(userMessage, 'escalate')) {
      const questionId = userMessage.body?.text
      const originalMessage = await Message.findById(questionId)
      if (originalMessage) {
        originalMessage.channels = originalMessage.channels ?? []
        if (!originalMessage.channels.includes('participant')) {
          originalMessage.channels.push('participant')
          await originalMessage.save()
        }
      } else {
        logger.error(`escalate: could not find original message ${questionId}`)
        return []
      }
      return submitToModeratorResponse.call(this, userMessage, { _id: questionId })
    }

    if (this.agentConfig?.moderatorSupport && userMessage.channels?.includes('participant')) {
      return submitToModeratorResponse.call(this, userMessage, userMessage)
    }

    // Check for visual command (set in evaluate)
    const forceVisual = hasCommand(userMessage, 'visual')

    // Extract text from JSON body if present for processing
    const modifiedMessage = { ...userMessage }
    modifiedMessage.body = extractMessageText(userMessage)

    return answerQuestion.call(this, modifiedMessage, filterModeratorHistory(conversationHistory), {
      forceVisual,
      moderatorSupport: !!this.agentConfig?.moderatorSupport
    })
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
        const introText = await buildDmIntroMessage.call(this, adapterType)
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

  formatTraceInput(_conversationHistory: ConversationHistory, userMessage: IMessage | undefined) {
    if (!userMessage) return { trigger: 'periodic' }
    return userMessage?.body
  },

  formatTraceOutput(responses: TraceResponse[]) {
    if (responses.length > 0 && (responses[0]?.message as { type?: string })?.type === 'checkin') {
      return responses.map((r) => ({
        participant: r.participantPseudonym,
        eligibleTypes: r.eligibleTypes,
        checkinType: r.checkinType,
        confidenceScore: r.confidenceScore,
        detectedPattern: r.detectedPattern,
        reasoning: r.reasoning,
        messageSent: (r.message as { text?: string })?.text
      }))
    }
    return responses[0]?.message
  },

  getTraceMetadata(conversationHistory: ConversationHistory, userMessage: IMessage | undefined, responses: TraceResponse[]) {
    if (!userMessage) {
      return {
        triggerType: 'periodic',
        topic: this.conversation.name,
        context: responses
          .map((r) => `# Participant: ${r.participantPseudonym} (${r.channels?.[0]?.name})\n\n${r.context}`)
          .join('\n\n---\n\n')
      }
    }
    return {
      context: responses[0]?.context,
      conversationHistory,
      channels: userMessage?.channels,
      promptType: responses[0]?.promptType,
      topic: responses[0]?.topic
    }
  }
})
