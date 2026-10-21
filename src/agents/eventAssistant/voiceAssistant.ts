import removeMarkdown from 'remove-markdown'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory, IMessage } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { eventAssistantLLMTemplates, eventAssistantLlmTemplateVars, answerQuestion } from './eventQuestionHandler.js'
import logger from '../../config/logger.js'
import getDefaultEventAssistantToolNames from './eventAssistantDefaultTools.js'
import { extractVoiceQuestion, evaluateVoiceTrigger, matchAnnouncementTrigger } from '../helpers/voiceDirectives.js'
import websocketGateway from '../../websockets/websocketGateway.js'

function findChannel(conversation, name) {
  return conversation.channels.find((channel) => channel.name === name)
}

/**
 * Resolves the (transcriptChannel, requestId) pair every voice-output streaming path needs.
 * Returns null when there's no transcript channel to stream onto.
 */
function resolveVoiceStreamTarget(conversation, userMessage, conversationId) {
  const transcriptChannel = findChannel(conversation, 'transcript')
  if (!transcriptChannel) return null
  const requestId = (userMessage.source?.requestId as string | undefined) ?? userMessage._id?.toString() ?? conversationId
  return { transcriptChannel, requestId }
}

// Stripped from every transcript-bound/TTS chunk in broadcastChunk below, on top of
// removeMarkdown's own pass. Applied unconditionally rather
// than only to a matched Markdown delimiter pair, so a span split across two separately-
// streamed chunks (e.g. "**bo" then "ld**") still comes out clean with no cross-chunk
// buffering/latency needed — each half just loses its stray symbol on its own.
const STRAY_TTS_SYMBOLS = /[*~#_`]/g

/**
 * One `message:chunk` broadcast, with the same warn-and-swallow failure handling every call
 * site needs. Strips Markdown from the text first — VOICE_OUTPUT_RULES already tells the model
 * not to use it, but that's a prompt instruction, not a guarantee; this is a deterministic
 * backstop so a slip (the model's own habit, or Markdown echoed from a web_search result it's
 * quoting) never reaches TTS. Scoped to this one function since every transcript-bound/TTS text
 * path already funnels through it — the chat-channel message built elsewhere is untouched, since
 * Markdown there renders normally for a reader.
 */
function broadcastChunk(conversationId, channelName, requestId, text, done, errorContext) {
  const spoken = removeMarkdown(text).replace(STRAY_TTS_SYMBOLS, '')
  return websocketGateway
    .broadcastMessageChunk(conversationId, [channelName], { requestId, text: spoken, done })
    .catch((err) => logger.warn(`Voice assistant: failed to broadcast ${errorContext}: ${err}`))
}

/** Attaches the "this is a voice-triggered reply" envelope every chat-channel response needs. */
function wrapVoiceSourceMessage(response, questionText, userMessage, chatChannel) {
  return {
    ...response,
    channels: [chatChannel],
    parent: undefined,
    message: {
      ...response.message,
      source: 'voice',
      sourceMessage: questionText,
      sourcePseudonym: userMessage.pseudonym
    }
  }
}

/**
 * Reads a matched announcement verbatim — no LLM call. When voiceOutput is on, additionally
 * streams the announcement as TTS chunks (one per announcement.segments()-derived segment)
 * before posting it to chat; either way, the chat channel gets the same single message with
 * the raw, unsegmented body.
 */
async function respondWithAnnouncement(announcement, questionText, userMessage, voiceOutput, conversationId, target) {
  if (voiceOutput) {
    if (!target) return []
    const { transcriptChannel, requestId } = target

    try {
      // No automatic transition phrase or pause insertion — organizers write transition
      // wording directly into the announcement's body, relying on Kokoro's natural
      // end-of-sentence cadence between separately-queued clips (see
      // bot-media-server/engineSocket.ts: one chunk = one TTS call = one queued audio clip).
      for (const segment of announcement.segments()) {
        await broadcastChunk(conversationId, transcriptChannel.name, requestId, segment, false, 'announcement chunk')
      }
    } finally {
      await broadcastChunk(conversationId, transcriptChannel.name, requestId, '', true, 'done marker')
    }
  }

  const chatChannel = findChannel(this.conversation, 'chat')
  if (!chatChannel) return []

  return [
    wrapVoiceSourceMessage(
      { visible: true, message: { text: announcement.body }, messageType: 'json' },
      questionText,
      userMessage,
      chatChannel
    )
  ]
}

export default verify({
  name: 'Voice Assistant',
  description:
    'Listens for voice activations on the transcript channel and answers questions about the event in the group chat',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { channels: ['transcript'] }
  },
  agentConfig: {
    tools: getDefaultEventAssistantToolNames(),
    voiceOutput: false
  },
  llmTemplateVars: eventAssistantLlmTemplateVars,
  defaultLLMTemplates: eventAssistantLLMTemplates,
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  defaultConversationHistorySettings: { count: 10, channels: ['transcript'] },
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
    const result = evaluateVoiceTrigger(userMessage, botName, this.conversation.messages as Array<IMessage>)
    if (result.action === AgentMessageActions.CONTRIBUTE) logger.debug(`Voice trigger matched`)
    else if (result.userMessage !== userMessage) logger.debug(`Voice trigger matched (bare), waiting for next message`)
    return result
  },

  async respond(conversationHistory: ConversationHistory, userMessage) {
    const botName = this.agentConfig.botName as string
    const questionText = extractVoiceQuestion(userMessage, conversationHistory.messages, botName)
    if (!questionText) return []

    const conversationId = this.conversation._id.toString()
    const voiceOutput = Boolean(this.agentConfig.voiceOutput)
    const voiceTarget = voiceOutput ? resolveVoiceStreamTarget(this.conversation, userMessage, conversationId) : null

    // Past this point we're committed to producing a real response (LLM-generated or a
    // verbatim announcement read) that will actually stream chunks to bot-media clients.
    if (voiceTarget) {
      websocketGateway
        .broadcastAgentResponding(conversationId, this._id.toString())
        .catch((err) => logger.warn(`Voice assistant: failed to broadcast agent:responding: ${err}`))
    }

    logger.debug(`Voice assistant answering question: "${questionText}"`)
    const questionMessage = { ...userMessage, body: questionText }

    const announcement = matchAnnouncementTrigger(questionText, this.conversation.announcements ?? [])
    if (announcement) {
      return respondWithAnnouncement.call(
        this,
        announcement,
        questionText,
        userMessage,
        voiceOutput,
        conversationId,
        voiceTarget
      )
    }

    if (voiceOutput) {
      // In voice output mode, stream chunks on the transcript channel for clients to consume
      // for TTS, live as they're generated — in addition to (below) posting the same answer
      // to chat once it's done, same as the non-voice path, so there's still a durable,
      // visible chat record of what the bot said.
      if (!voiceTarget) return []
      const { transcriptChannel, requestId } = voiceTarget

      let chunkStreamed = false
      const onChunk = (text: string) => {
        chunkStreamed = true
        broadcastChunk(conversationId, transcriptChannel.name, requestId, text, false, 'chunk')
      }

      let responses
      try {
        // answerQuestion expects chat/DM history; transcript is handled internally via RAG
        responses = await answerQuestion.call(this, questionMessage, { messages: [] }, { voiceOutput, onChunk })

        // Not every path inside answerQuestion streams via onChunk — e.g. the no-tools branch
        // resolves the full answer in one shot with no chunk callback at all. Without this
        // fallback that answer is silently dropped from the transcript/TTS stream (it's still
        // posted to chat below either way). Covers any other future path that resolves without
        // streaming too, with no changes needed there.
        if (!chunkStreamed) {
          const fullText = responses[0]?.message?.text
          if (fullText) {
            await broadcastChunk(conversationId, transcriptChannel.name, requestId, fullText, false, 'fallback chunk')
          }
        }
      } finally {
        // Always send the done marker, even if answerQuestion threw partway through (LLM/tool
        // calls, the RAG lookup) — chunks may already be streaming by then, and a client that's
        // received done:false chunks for this requestId must still learn the stream ended.
        await broadcastChunk(conversationId, transcriptChannel.name, requestId, '', true, 'done marker')
      }

      const voiceChatChannel = findChannel(this.conversation, 'chat')
      if (!voiceChatChannel) return []
      return responses.map((r) => wrapVoiceSourceMessage(r, questionText, userMessage, voiceChatChannel))
    }

    const chatChannel = findChannel(this.conversation, 'chat')
    if (!chatChannel) return []

    // answerQuestion expects chat/DM history; transcript is handled internally via RAG
    const responses = await answerQuestion.call(this, questionMessage, { messages: [] })

    return responses.map((r) => wrapVoiceSourceMessage(r, questionText, userMessage, chatChannel))
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
    return responses[0]?.message.text
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
