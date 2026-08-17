import type { StructuredToolInterface } from '@langchain/core/tools'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory, IMessage } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { extractMessageText } from '../helpers/slashCommandParser.js'
import { matchBotMention, normalizeBotMention } from '../helpers/intentChecks.js'
import { composeSystemPrompt } from '../helpers/promptComposer.js'
import { getAgentStructuredResponse } from '../helpers/llmChain.js'
import { formatMultiUserConversationHistory } from '../helpers/llmInputFormatters.js'
import { getTools } from '../tools/registry.js'
import { TopicRef, buildEventHistoryToolsPrompt } from '../tools/eventHistory.js'
import { bkcArchiveWikiTools, buildArchiveWikiToolsPrompt } from '../tools/bkcArchiveWiki.js'
import Topic from '../../models/topic.model.js'
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import websocketGateway from '../../websockets/websocketGateway.js'

/**
 * Consolidates the old voiceAssistant + eventHistorian split into one agent, exclusively for
 * Berkie/Reachy's own conversation (created directly via agentTypes, not a shared
 * conversationType - see llm_engine_bootstrap/seed.py). That split caused every voice question
 * to get answered twice: llm_engine's message dispatcher never actually enforces
 * defaultTriggers.perMessage.channels (it's inert metadata - see message.service.ts), so both
 * agents independently gated on the SAME message via their own text-based heuristics and both
 * responded. One agent with one gate and every tool means exactly one spoken answer.
 *
 * The system prompt below is written for TEXT-TO-SPEECH, not chat display - no Markdown, no
 * URLs, short answers - since eventQuestionHandler.ts's shared prompts (reused by the web chat)
 * explicitly instruct citing sources with Markdown links, which is unusable read aloud by a
 * robot.
 */

const BASE_SYSTEM_PROMPT = `You are {botName}, a voice assistant physically present at Berkman Klein Center (BKC) events. You answer questions out loud, spoken through a robot's speaker to a live audience - not displayed as text.

**How to speak:**
- Never use Markdown, headers, bullet points, or asterisks - write only plain spoken sentences, exactly as you'd say them out loud.
- Keep answers short: 1-4 sentences for most questions. Only go longer if the question explicitly asks for more detail (e.g. "give me a few sentences about...").
- Never say a URL, link, file path, or ID out loud. When citing a source, name it naturally in the sentence instead (e.g. "according to an article from The Harvard Gazette" or "based on the event's own transcript") - never read out the address or identifier itself.
- Don't narrate what you're about to do ("Let me check that") - search first, then answer once you have the information.
- Match the tone of a knowledgeable person casually answering a question at an event, not a written report.

**Your tools:**
${buildEventHistoryToolsPrompt(true)}
${bkcArchiveWikiTools.length > 0 ? `\n\n${buildArchiveWikiToolsPrompt()}` : ''}

Use event-history search for questions about past BKC events, what was discussed, or who spoke.${
  bkcArchiveWikiTools.length > 0
    ? " Use the archive for BKC's people, projects, and history more broadly - before or beyond what's in event transcripts."
    : ''
} Use web search only for general knowledge outside BKC's own material. Search efficiently: one or two tool calls usually suffice, and never repeat near-identical queries.

Regardless of any citation format mentioned above: never include a URL, link, or raw ID in your spoken answer. Cite sources by name and date only.
{topicContext}`

function buildTopicContext(topics: TopicRef[]): string {
  if (topics.length === 0) return ''
  const lines = topics.map((t) => {
    const desc = t.description ? `: ${t.description}` : ''
    return `- "${t.name}" (id: ${t.id})${desc}`
  })
  return `\n\n**Available event series:**\n${lines.join('\n')}`
}

function matchHeyDirective(text: string, botName: string): { matched: boolean; question: string } {
  // Split and scan all consecutive word pairs for "hey <botName>" anywhere in the message
  const words = text.trim().split(/\s+/)
  if (words.length < 2) return { matched: false, question: '' }

  for (let i = 0; i < words.length - 1; i++) {
    const heyToken = words[i].replace(/[,!.]+$/, '').toLowerCase()

    // "hey" itself is checked for an EXACT match, not a fuzzy one - it's a short, common,
    // unambiguous word Whisper transcribes reliably (unlike the made-up bot name, where fuzzy
    // matching earns its keep). Fuzzy matching "hey" backfired in an earlier design: fuzzball
    // scores the ordinary word "they" at 86 against "hey" (well above any reasonable threshold),
    // so ANY message containing "they"/"their" immediately followed by anything resembling the
    // bot name - including a garbled ASR mistranscription with zero relation to an actual wake
    // attempt - triggered a full response.
    if (heyToken === 'hey' && matchBotMention([words[i + 1]], botName)) {
      const extracted = words
        .slice(i + 2)
        .join(' ')
        .trim()
      const question = extracted.charAt(0).toUpperCase() + extracted.slice(1)
      return { matched: true, question }
    }
  }

  return { matched: false, question: '' }
}

// Returns the extracted question text if the agent should respond, or null otherwise.
// Called from both evaluate (to gate) and respond (to extract the question), since respond runs
// asynchronously in a job with a freshly loaded agent and cannot rely on in-memory state from evaluate.
function extractVoiceQuestion(userMessage, conversationMessages, botName: string) {
  const messageText = extractMessageText(userMessage)
  const { matched, question } = matchHeyDirective(messageText, botName)

  if (matched && question) return question
  if (matched && !question) return null // bare trigger, wait for next message

  // No trigger in current message — check if the previous transcript message was a bare "hey botName"
  const prevTranscriptMessage = [...conversationMessages]
    .reverse()
    .find((msg) => msg.channels?.some((c) => c === 'transcript'))
  if (prevTranscriptMessage) {
    const prevText = extractMessageText(prevTranscriptMessage)
    const prev = matchHeyDirective(prevText, botName)
    if (prev.matched && !prev.question) return messageText
  }

  return null
}

export default verify({
  name: 'Reachy Live Agent',
  description:
    'Listens for voice activations on the transcript channel and answers questions about BKC events, ' +
    'the BKC archive, and general knowledge - spoken aloud through the Reachy robot.',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { channels: ['transcript'] }
  },
  agentConfig: {
    botName: 'Berkie',
    personality: 'sarcastic-expert',
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
  // Include 'chat' alongside 'transcript': this agent's own answers are posted to the chat
  // channel (see the `channels: [chatChannel]` response below), so 'transcript' alone would
  // only ever surface the user's past questions, never Berkie's own past answers - confirmed
  // live: asked to recall something it said minutes earlier, it fabricated a different answer,
  // then denied having said anything at all, because its own prior turns were invisible to it.
  defaultConversationHistorySettings: { count: 20, channels: ['transcript', 'chat'] },
  parseOutput: (msg) => {
    if (msg.bodyType !== 'json' || msg.body?.source !== 'voice') {
      return msg
    }
    const translatedMsg = msg.toObject()
    const sourceMessage = msg.body.sourceMessage as string
    const truncated = sourceMessage.length > 40 ? `${sourceMessage.slice(0, 40)}...` : sourceMessage
    translatedMsg.bodyType = 'text'
    translatedMsg.body = `🔊 "${truncated}"\n${msg.body.text}`
    return translatedMsg
  },

  async evaluate(userMessage) {
    const botName = this.agentConfig.botName as string
    const questionText = extractVoiceQuestion(userMessage, this.conversation.messages as Array<IMessage>, botName)

    if (questionText) {
      logger.debug(`Reachy live trigger matched, question: "${questionText}"`)
      const modifiedMessage = { ...userMessage, body: normalizeBotMention(userMessage.body, botName, false) }
      return {
        userMessage: modifiedMessage,
        action: AgentMessageActions.CONTRIBUTE,
        userContributionVisible: true,
        suggestion: undefined
      }
    }

    const messageText = extractMessageText(userMessage)
    const { matched } = matchHeyDirective(messageText, botName)
    if (matched) {
      logger.debug(`Reachy live trigger matched (bare), waiting for next message`)
      const modifiedMessage = { ...userMessage, body: normalizeBotMention(userMessage.body, botName, false) }
      return {
        userMessage: modifiedMessage,
        action: AgentMessageActions.OK,
        userContributionVisible: true,
        suggestion: undefined
      }
    }

    return { userMessage, action: AgentMessageActions.OK, userContributionVisible: true, suggestion: undefined }
  },

  async respond(conversationHistory: ConversationHistory, userMessage) {
    const chatChannel = this.conversation.channels.find((channel) => channel.name === 'chat')
    if (!chatChannel) return []

    const botName = this.agentConfig.botName as string
    const questionText = extractVoiceQuestion(userMessage, conversationHistory.messages, botName)
    if (!questionText) return []

    logger.debug(`Reachy live agent answering question: "${questionText}"`)

    const llm = await this.getLLM()

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

    const conversationId = this.conversation._id.toString()
    const systemPromptBase = BASE_SYSTEM_PROMPT.replace('{botName}', botName).replace(
      '{topicContext}',
      buildTopicContext(topics)
    )
    const systemPrompt = composeSystemPrompt(systemPromptBase, { personalityName })

    const tools: StructuredToolInterface[] = getTools(['web_search', 'event_history', 'archive_wiki'], {
      topics,
      activeConversationId: conversationId
    })

    const chatHistory = formatMultiUserConversationHistory(conversationHistory)

    const requestId = userMessage.source?.requestId as string | undefined
    const onChunk = requestId
      ? (text: string) => {
          websocketGateway
            .broadcastAnswerChunk(conversationId, ['chat'], { requestId, text, done: false })
            .catch((err) => logger.warn(`Failed to broadcast answer chunk: ${err}`))
        }
      : undefined

    // Recursion limit: each tool round-trip costs 2 graph steps; with web search, event-history,
    // and archive tool sets all available, the agent may need to consult several before answering.
    const responseText = (await getAgentStructuredResponse(
      llm,
      tools,
      systemPrompt,
      `## Question:\n${questionText}`,
      undefined,
      chatHistory,
      35,
      { onChunk }
    )) as string

    if (requestId) {
      await websocketGateway
        .broadcastAnswerChunk(conversationId, ['chat'], { requestId, text: '', done: true })
        .catch((err) => logger.warn(`Failed to broadcast final answer-chunk marker: ${err}`))
    }

    return [
      {
        visible: true,
        messageType: 'json' as const,
        channels: [chatChannel],
        parent: undefined,
        message: {
          text: responseText,
          source: 'voice',
          sourceMessage: questionText,
          sourcePseudonym: userMessage.pseudonym
        }
      }
    ]
  },

  async start() {
    return true
  },

  async stop() {
    return true
  },

  async introduce() {
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
      conversationHistory,
      channels: userMessage?.channels,
      topic: responses[0]?.topic
    }
  }
})
