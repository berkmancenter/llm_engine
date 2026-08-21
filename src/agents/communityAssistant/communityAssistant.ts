import type { StructuredToolInterface } from '@langchain/core/tools'
import { getAgentStructuredResponse } from '../helpers/llmChain.js'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { formatMultiUserConversationHistory } from '../helpers/llmInputFormatters.js'
import { composeSystemPrompt } from '../helpers/promptComposer.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { extractMessageText } from '../helpers/slashCommandParser.js'
import { getTools, buildToolsGuidance } from '../tools/registry.js'
import Conversation from '../../models/conversation.model.js'
import config from '../../config/config.js'
import { checkBotIntent, matchBotMention, normalizeBotMention } from '../helpers/intentChecks.js'

const BASE_SYSTEM_PROMPT = `You are {botName}, a helpful AI assistant participating in a community chat. You help community members with questions, discussion, and finding information relevant to the community. You can engage with any topic or inquiry—from casual conversation to technical questions, creative tasks, analysis, debugging, writing, math, and beyond. There are no subject limits.

**Guidelines:**
- Be direct and substantive. Don't hedge unnecessarily.
- Use conversation history for context—remember what's been discussed.
- For factual questions, be accurate and acknowledge uncertainty when it exists.
- For creative or open-ended tasks, engage fully and offer your perspective.
- Match response depth to the question—short questions don't always need long answers.
- You are talking in a shared channel, so keep context of the group conversation in mind.
- The message you are being asked to respond to is labeled **## Question:**

{toolGuidance}Search efficiently: one or two tool calls usually suffice, and never re-run near-identical queries against the same source. For questions answerable from conversation history alone, respond directly without calling any tools.`

export default verify({
  name: 'Community Assistant',
  description:
    'A configurable AI assistant that helps community members with questions and discussion, with access to community-specific tools such as event history and archive search',
  priority: 100,
  maxTokens: 4000,
  defaultTriggers: {
    perMessage: { channels: ['chat'] }
  },
  agentConfig: {
    enablePersonality: config.enableAgentPersonality,
    tools: ['event_history', 'bkc_archive_wiki', 'web_search'] as string[],
    topicIds: [] as string[],
    notifications: [] as string[]
  },
  llmTemplateVars: {
    user: [{ name: 'question', description: 'The user message or question' }]
  },
  defaultLLMTemplates: {
    user: '## Question:\n{question}'
  },
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  defaultConversationHistorySettings: { count: 100, channels: ['chat'] },

  async evaluate(userMessage) {
    const words = userMessage?.body?.trim().split(/\s+/) ?? []
    const modifiedMessage = matchBotMention(words, this.agentConfig.botName)
      ? { ...userMessage, body: normalizeBotMention(userMessage.body, this.agentConfig.botName) }
      : userMessage
    return {
      userMessage: modifiedMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(conversationHistory: ConversationHistory, userMessage) {
    const llm = await this.getLLM()
    if (!(await checkBotIntent(llm, this.agentConfig.botName, userMessage))) {
      return []
    }
    const chatHistory = formatMultiUserConversationHistory(conversationHistory)
    const question = extractMessageText(userMessage).trim()

    const toolNames: string[] = this.agentConfig?.tools || []
    const topicIds: string[] = this.agentConfig?.topicIds || []

    let personalityName: string | null = null
    if (this.agentConfig?.personality !== undefined) {
      personalityName = this.agentConfig.personality
    } else if (config.enableAgentPersonality) {
      personalityName = 'sarcastic-expert'
    }

    const systemPromptBase = BASE_SYSTEM_PROMPT.replace('{botName}', this.agentConfig.botName).replace(
      '{toolGuidance}',
      await buildToolsGuidance(toolNames, { topicIds })
    )
    const systemPrompt = composeSystemPrompt(systemPromptBase, { personalityName })

    const tools: StructuredToolInterface[] = await getTools(toolNames, { topicIds })

    // Build message array: chat history + current question
    // Recursion limit: each tool round-trip costs 2 graph steps; with both event-history
    // and archive tool sets the agent may need to consult several before answering.
    const response = await getAgentStructuredResponse(
      llm,
      tools,
      systemPrompt,
      `## Question:\n${question}`,
      undefined,
      chatHistory,
      30
    )

    const responseChannels = this.conversation.channels.filter((channel) => channel.name === 'chat')
    const parentMessageId = userMessage.parentMessage

    return [
      {
        visible: true,
        message: response,
        messageType: 'text',
        channels: responseChannels,
        parent: parentMessageId
      }
    ]
  },

  async onConversationEvent(evt) {
    if (evt.type !== 'conversationStopped') return []
    const notifications: string[] = this.agentConfig?.notifications || []
    if (!notifications.includes('event_ended')) return []
    const conv = await Conversation.findById(evt.conversationId).select('name summary').lean()
    if (!conv?.summary) return []
    const name = conv.name ?? 'An event'
    const responseChannels = this.conversation.channels.filter((c) => c.name === 'chat')
    return [
      {
        visible: true,
        message: `*${name}* just wrapped up. Here's a summary:\n\n${conv.summary}\n\n*Have questions about the event? Ask me anything.*`,
        messageType: 'text' as const,
        channels: responseChannels
      }
    ]
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
