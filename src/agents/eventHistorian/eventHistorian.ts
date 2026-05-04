import { getAgentStructuredResponse } from '../helpers/llmChain.js'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { formatMultiUserConversationHistory } from '../helpers/llmInputFormatters.js'
import { buildSystemPromptWithPersonality } from '../helpers/agentPersonality.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { extractMessageText } from '../helpers/slashCommandParser.js'
import createEventHistoryTools, { TopicRef } from '../tools/eventHistory.js'
import Topic from '../../models/topic.model.js'
import config from '../../config/config.js'

const BASE_SYSTEM_PROMPT = `You are {botName}, a helpful, knowledgeable AI assistant participating in a group chat. You can engage with any topic or inquiry—from casual conversation to technical questions, creative tasks, analysis, debugging, writing, math, and beyond. There are no subject limits.

**Guidelines:**
- Be direct and substantive. Don't hedge unnecessarily.
- Use conversation history for context—remember what's been discussed.
- For factual questions, be accurate and acknowledge uncertainty when it exists.
- For creative or open-ended tasks, engage fully and offer your perspective.
- Match response depth to the question—short questions don't always need long answers.
- You are talking in a shared channel, so keep context of the group conversation in mind.
- The message you are being asked to respond to is labeled **## Question:**

**Event history tools:**
Your primary specialty is answering questions about past events and their transcripts. You have access to tools for this purpose — use them whenever a question touches on past events, speakers, topics discussed, or anything that may be in an event transcript.

- \`get_event_list\`: list events by name/date across all series, with optional date or series filter
- \`search_topic_transcripts\`: semantic search across all event transcripts; results are prefixed with the event name they came from
- \`search_conversation_transcript\`: deep search within a specific event's transcript after identifying it via the above tools

When searching, search across all series unless the question clearly refers to a specific one. Don't require the user to specify a series — use your judgment. Prefer \`search_topic_transcripts\` for broad questions; use \`search_conversation_transcript\` to retrieve specific quotes or details once you know which event to drill into. For questions that are clearly unrelated to past events, respond directly without calling any tools.
{topicContext}`

function buildTopicContext(topics: TopicRef[]): string {
  const lines = topics.map((t) => {
    const desc = t.description ? `: ${t.description}` : ''
    return `- "${t.name}" (id: ${t.id})${desc}`
  })
  return `\n\n**Available event series:**\n${lines.join('\n')}`
}

export default verify({
  name: 'Event Historian',
  description:
    'An AI assistant specialized in answering questions about past events and their transcripts, while also handling any general inquiry',
  priority: 100,
  maxTokens: 4000,
  defaultTriggers: {
    perMessage: { channels: ['historian'] }
  },
  agentConfig: {
    enablePersonality: config.enableAgentPersonality,
    topicIds: [] as string[]
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
  defaultConversationHistorySettings: { count: 100, channels: ['historian'] },

  async evaluate(userMessage) {
    // Only respond when explicitly mentioned with @BotName
    if (!userMessage?.body?.toLowerCase().includes(`@${this.agentConfig.botName}`.toLowerCase())) {
      return {
        userMessage,
        action: AgentMessageActions.OK,
        userContributionVisible: true,
        suggestion: undefined
      }
    }

    return {
      userMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(conversationHistory: ConversationHistory, userMessage) {
    const chatHistory = formatMultiUserConversationHistory(conversationHistory)
    const question = extractMessageText(userMessage).trim()

    // Load topic metadata for system prompt and tools
    const configuredTopicIds: string[] = this.agentConfig?.topicIds || []
    let topicDocs
    if (configuredTopicIds.length > 0) {
      topicDocs = await Topic.find({ _id: { $in: configuredTopicIds } })
        .select('_id name description')
        .lean()
    } else {
      topicDocs = await Topic.find({ private: false, isDeleted: false }).select('_id name description').lean()
    }
    const topics: TopicRef[] = topicDocs.map((t) => ({ id: t._id.toString(), name: t.name, description: t.description }))

    let personalityName: string | null = null
    if (this.agentConfig?.personality !== undefined) {
      personalityName = this.agentConfig.personality
    } else if (config.enableAgentPersonality) {
      personalityName = 'sarcastic-expert'
    }

    const systemPromptBase = BASE_SYSTEM_PROMPT.replace('{botName}', this.agentConfig.botName).replace(
      '{topicContext}',
      buildTopicContext(topics)
    )
    const systemPrompt = buildSystemPromptWithPersonality(systemPromptBase, personalityName)

    const tools = topics.length > 0 ? createEventHistoryTools(topics) : []

    const llm = await this.getLLM()

    // Build message array: chat history + current question
    const response = await getAgentStructuredResponse(
      llm,
      tools,
      systemPrompt,
      `## Question:\n${question}`,
      undefined,
      chatHistory,
      10
    )

    const responseChannels = this.conversation.channels.filter((channel) => channel.name === 'historian')
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
