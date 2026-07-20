import type { StructuredToolInterface } from '@langchain/core/tools'
import { getAgentStructuredResponse } from '../helpers/llmChain.js'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { formatMultiUserConversationHistory } from '../helpers/llmInputFormatters.js'
import { composeSystemPrompt } from '../helpers/promptComposer.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { extractMessageText } from '../helpers/slashCommandParser.js'
import createEventHistoryTools, { TopicRef, buildEventHistoryToolsPrompt } from '../tools/eventHistory.js'
import createArchiveTools, { saveEventToArchive } from '../tools/archive.js'
import Topic from '../../models/topic.model.js'
import Conversation from '../../models/conversation.model.js'
import config from '../../config/config.js'
import { checkBotIntent, matchBotMention, normalizeBotMention } from '../helpers/intentChecks.js'
import logger from '../../config/logger.js'
import access from '../../auth/access.js'

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

${buildEventHistoryToolsPrompt()}

When searching, search across all series unless the question clearly refers to a specific one. Don't require the user to specify a series — use your judgment. Prefer \`search_topic_transcripts\` for broad questions; use \`search_conversation_transcript\` to retrieve specific quotes or details once you know which event to drill into. For questions that are clearly unrelated to past events, respond directly without calling any tools.

You are in a live chat — respond promptly. Gather just enough to answer well: one or two searches usually suffice, and never re-run near-identical queries against the same source. Answer as soon as you have the substance.
{archiveContext}{topicContext}`

function buildArchiveContext(apiMode: boolean): string {
  const searchDescription = apiMode
    ? 'keyword search across all archive content — use for questions about what the archive holds (talks, writings, coverage of a subject); prefer concrete names and terms over paraphrases'
    : 'semantic search across all archive content — use for questions about what the archive holds (talks, writings, coverage of a subject)'
  return `

**Archive tools:**
You also have access to the BKC archive — a curated collection of video transcripts, articles, newsletters, and bookmarked items, organized by a wiki of topic, people, org, and timeline pages.

- \`search_archive\`: ${searchDescription}
- \`list_archive_wiki_pages\`: list the curated wiki pages — use to route a thematic question (a topic, person, organization, or era) to the right page
- \`read_archive_wiki_page\`: read one wiki page; its wiki-links carry archive item ids
- \`get_archive_item\`: fetch one item's metadata plus full source material (transcript or article text) by id

For direct content questions, go straight to \`search_archive\`. For thematic or survey questions ("what does the archive have on X", questions about a person/org/era), route through the wiki: \`list_archive_wiki_pages\` → \`read_archive_wiki_page\` → \`get_archive_item\` for the sources you need. Cite items by title, date, and URL. Event transcripts (the tools above) and the archive are different bodies of material — talks, videos, interviews, articles, and newsletters usually live in the archive. Budget your tool calls: if an event-history search returns nothing relevant, switch to \`search_archive\` instead of retrying variations of the same search.`
}

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

    const archiveEnabled = !!(config.archiveApiUrl || config.archivePath)

    const systemPromptBase = BASE_SYSTEM_PROMPT.replace('{botName}', this.agentConfig.botName)
      .replace('{archiveContext}', archiveEnabled ? buildArchiveContext(!!config.archiveApiUrl) : '')
      .replace('{topicContext}', buildTopicContext(topics))
    const systemPrompt = composeSystemPrompt(systemPromptBase, { personalityName })

    const tools: StructuredToolInterface[] = topics.length > 0 ? createEventHistoryTools(topics) : []
    if (archiveEnabled) {
      tools.push(
        ...createArchiveTools({
          archivePath: config.archivePath,
          apiUrl: config.archiveApiUrl,
          apiToken: config.archiveApiToken
        })
      )
    }

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

  async onConversationEvent(evt) {
    if (evt.type !== 'conversationStopped') return []
    const conv = await Conversation.findById(evt.conversationId)
      .select('name summary startTime platforms presenters topic')
      .populate({ path: 'topic', select: 'private' })
      .lean()
    if (!conv?.summary) return []
    const name = conv.name ?? 'An event'
    const { summary } = conv

    if (config.archiveApiUrl) {
      const topic = conv.topic as { _id?: { toString(): string }; private?: boolean } | undefined
      // Fire-and-forget: the archive push-back is a best-effort side effect that
      // shouldn't delay the wrap-up message below on the archive API's latency.
      // Re-check read access here even though the dispatcher already gated it, so least
      // privilege stays explicit at the read site (mirrors vibesAnalyst.onConversationEvent).
      // Fail closed: anything but an explicit `private: false` counts as private, so an
      // unpopulated or deleted topic is never auto-filed.
      ;(async () => {
        try {
          access.assertCanRead(this, {
            type: 'conversation',
            id: evt.conversationId,
            topicId: topic?._id?.toString(),
            topicIsPrivate: topic?.private !== false
          })
        } catch (err) {
          logger.debug(`Skipping archive push-back for "${name}": ${err.message}`)
          return
        }
        const result = await saveEventToArchive(config.archiveApiUrl, config.archiveApiToken, {
          title: name,
          markdown: summary,
          date: conv.startTime ? new Date(conv.startTime).toISOString().slice(0, 10) : undefined,
          source: conv.platforms?.[0],
          participants: conv.presenters?.map((p) => p.name)
        })
        if (result.ok) {
          logger.info(`Filed "${name}" to the archive inbox: ${result.path}`)
        } else {
          logger.warn(`Failed to file "${name}" to the archive: ${result.message}`)
        }
      })().catch((err) => logger.warn(`Archive push-back errored for "${name}": ${err.message}`))
    }

    const responseChannels = this.conversation.channels.filter((c) => c.name === 'historian')
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
