import { z } from 'zod'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationEvent, ConversationHistory, IChannel, IMessage } from '../../types/index.types.js'
import buildCheckinResponses from './checkinHandler.js'
import renderAgentTemplate from '../helpers/renderAgentTemplate.js'
import access from '../../auth/access.js'

import Message from '../../models/message.model.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { eventAssistantLLMTemplates, eventAssistantLlmTemplateVars, answerQuestion } from './eventQuestionHandler.js'
import { composeSystemPrompt } from '../helpers/promptComposer.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'

import logger from '../../config/logger.js'
import config from '../../config/config.js'
import getDefaultEventAssistantToolNames from './eventAssistantDefaultTools.js'
import generateImageResponse from './imageGenerator.js'
import { parseSlashCommands, hasCommand, extractMessageText, SlashCommand } from '../helpers/slashCommandParser.js'
import generateMindMap from './mindMapGenerator.js'
import handleUnpackRequest, { isUnpackRequest } from './unpackHandler.js'
import { checkBotIntent, matchBotMention, normalizeBotMention } from '../helpers/intentChecks.js'
import { loadGoal } from '../../goals/loader.js'
import { GROUP_CHAT_CHANNELS, isGroupChatMessage, currentGroupChannelName } from '../helpers/groupChatChannel.js'
import { PREGAME_CHANNEL } from '../../conversations/eventAssistant.js'

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

  const systemPrompt = composeSystemPrompt(base, {
    personalityName,
    conversationContext: this.conversation.conversationContext,
    behaviorPolicy: this.conversation.behaviorPolicy,
    channelType: 'dm'
  })

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

const ThreeFactsSchema = z.object({
  facts: z.array(z.string()).length(3),
  invitation: z.string()
})

type ThreeFacts = z.infer<typeof ThreeFactsSchema>

/**
 * Generates three short, interesting facts about the event, posted once to the pregame group
 * channel partway through the preEvent window (see onConversationEvent's conversationWindowCountdown
 * case), drawn only from fields already loaded on the conversation — presenter bios, the event
 * description, and conversationContext (central questions, why-now, known tensions, scope, desired
 * takeaway). conversationContext has no write path anywhere yet (no form, no smart event-setup
 * tool), so the prompt also tells the model to look for the same signals directly in the free-text
 * description when the structured fields are empty — a stopgap until that tooling exists, not a
 * replacement for conversationContext once it does. A plain templated LLM call
 * (getChatPromptResponse), not RAG or tools: unlike live Q&A over an open-ended, growing
 * transcript, this draws from a small, fully-known, bounded set of fields already in memory.
 * Structured via ThreeFactsSchema rather than a formatted text blob, so the frontend can style the
 * facts and invitation independently instead of parsing them back out of prose; getChatPromptResponse
 * already retries once on a malformed structured response. The "invent nothing" constraint applies
 * only to factual content, not to tone or phrasing, which still carries personality in both the
 * facts and the invitation. Called with `this` = agent instance.
 */
async function buildThreeFactsMessage(this): Promise<ThreeFacts | null> {
  const presenters = this.conversation.presenters ?? []
  const personalityName = this.agentConfig?.personality ?? (config.enableAgentPersonality ? 'sarcastic-expert' : null)

  const presenterLines =
    presenters.map((presenter) => `- ${presenter.name}${presenter.bio ? `: ${presenter.bio}` : ''}`).join('\n') ||
    'None listed.'

  const base = `You are an AI assistant helping attendees get oriented before a live event starts. Generate
exactly three short, interesting facts about the event for people currently waiting in the pregame group
chat, plus one short invitation line in the same voice, inviting them to say hello and start chatting
while they wait.

**CRITICAL RULES:**
- The facts must be grounded only in the information provided below — never invent details, names, or
  claims that aren't there. Voice and personality belong in HOW things are said (tone, phrasing, wit), never
  in adding content that isn't actually in the information given.
- If the provided information is thin, favor more general facts that are still true and relevant (about the
  format, the kind of event, or why topics like this matter) rather than inventing specifics to fill the gap.
- When the event context below includes a central question, why this session is happening now, a known
  tension, or what the organizer hopes people leave with, let the facts reflect what's actually at stake —
  not just generic background — but still invent nothing beyond what's given.
- That structured context is often not filled in yet — if it's thin or absent, look for the same kind of
  signal (a central question, why now, a tension, scope, a hoped-for takeaway) directly in the event
  description below instead, and use whatever it actually says. Don't treat "context wasn't provided" as
  license to invent one, and don't assume the description lacks this just because the structured fields do.
- Each fact is one short, punchy sentence, no more than about 15 words. One idea each: don't cram in
  multiple examples, a list of competing theories, or a clause explaining why it matters. Cut qualifiers
  and setup; lead with the interesting part. If a fact needs "boils down to," "which means," or a
  parenthetical aside to fit everything in, it's doing too much and should be split or trimmed instead.
- Don't number them, refer to "the first/second/third fact," or write any lead-in or transition before
  them; they are shown to the room as their own list.
- Address the room generally rather than any one person, since this is posted once for everyone in the
  channel, not sent to a single attendee.
- Use only "they/them" pronouns when referring to any person, including presenters.
- Never use an em dash. Use a comma, period, or parentheses instead.`

  const systemPrompt = composeSystemPrompt(base, {
    personalityName,
    conversationContext: this.conversation.conversationContext,
    behaviorPolicy: this.conversation.behaviorPolicy,
    channelType: 'groupChat'
  })

  const userPrompt = `Event: "${this.conversation.name}"
${this.conversation.description ? `Description: ${this.conversation.description}` : ''}

Presenters:
${presenterLines}`

  const llm = await this.getLLM()
  return getChatPromptResponse(llm, systemPrompt, userPrompt, {}, undefined, ThreeFactsSchema)
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
  eligibleGoals?: string[]
  goalId?: string
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
    perMessage: { directMessages: true, channels: [...GROUP_CHAT_CHANNELS, 'image-gen'], allowMessagesFromAgents: true },
    periodic: { timerPeriod: 180, proactive: true }
  },
  agentConfig: {
    chatIntroMessage: `Welcome! I'm {{agentConfig.botName}}, your AI event assistant. This is a space to chat with other event participants. You can also ask me questions with an @{{agentConfig.botName}} mention. Just remember that everyone can see what you ask me here. Use the {{agentConfig.botName}} tab if you want to talk privately. Have fun!`,
    enablePersonality: config.enableAgentPersonality,
    zoomChatIntroMessage:
      "Welcome! I'm {{agentConfig.botName}}, your AI event assistant. You can ask me questions in the chat with an @{{agentConfig.botName}} mention. Or send me a DM if you want to talk privately.",
    presentationChatIntroMessage:
      "Welcome! I'm {{agentConfig.botName}}, your AI event assistant. This is the event's group chat, shown here for everyone in the room. Join the event on your own device to chat with other participants and ask me questions with an @{{agentConfig.botName}} mention.",
    pregameChatIntroMessage: `Welcome! I'm {{agentConfig.botName}}, your AI event assistant. The event hasn't started yet, think of this as the lobby: a space to chat with other early arrivals before things kick off. Ask me anything about today's session with an @{{agentConfig.botName}} mention, and I'll drop a few fun facts here while we wait. Just remember that everyone can see what you ask me here. Use the private chat tab if you want to talk privately.`,
    tools: getDefaultEventAssistantToolNames(),
    seriesHistory: false, // when true, gives the assistant access to other past events in the same series
    minInterval: 10, // minimum minutes between check-ins per participant
    checkinTranscriptWindow: 3 // transcript window in minutes for private check-in context
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
    // threeFacts has no .text field — it's rendered by the frontend from facts/invitation
    // directly, so an adapter that only forwards plain text (Zoom) needs it flattened here instead.
    translatedMsg.body =
      msg.body?.type === 'threeFacts'
        ? [...msg.body.facts.map((fact: string) => `- ${fact}`), msg.body.invitation].join('\n')
        : msg.body.text
    return translatedMsg
  },
  ragCollectionName: undefined,
  defaultConversationHistorySettings: { count: 100, directMessages: true, channels: [...GROUP_CHAT_CHANNELS] },

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

    if (isUnpackRequest(userMessage)) {
      return {
        userMessage,
        action: AgentMessageActions.CONTRIBUTE,
        userContributionVisible: true,
        suggestion: undefined
      }
    }

    // Parse slash commands using shared parser
    const activeCommands = this.agentConfig?.moderatorSupport
      ? supportedCommands
      : supportedCommands.filter((c) => c.command !== 'mod' && c.command !== 'escalate')
    let modifiedMessage = parseSlashCommands(userMessage, activeCommands)

    /* A client that misses conversation:started (dropped connection, laptop asleep, ...) can
       stay on the pregame view indefinitely and keep posting there after the event has actually
       gone live. Retag those messages to the now-current group channel rather than just
       declining to answer them — otherwise the message (and any reply) would still be saved
       into a channel nobody else, including admins, is looking at anymore. */
    const liveGroupChannel = currentGroupChannelName(this.conversation)
    if (modifiedMessage?.channels?.includes(PREGAME_CHANNEL) && liveGroupChannel !== PREGAME_CHANNEL) {
      modifiedMessage = {
        ...modifiedMessage,
        channels: modifiedMessage.channels.map((channel) => (channel === PREGAME_CHANNEL ? liveGroupChannel : channel))
      }
    }

    if (isGroupChatMessage(modifiedMessage?.channels)) {
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
  async respond(conversationHistory: ConversationHistory, userMessage, options?) {
    // Periodic check-in tick (no userMessage means this was triggered by the periodic job)
    if (!userMessage) {
      return buildCheckinResponses.call(this, conversationHistory)
    }

    // Handle image generation requests from self
    if (userMessage?.channels?.includes('image-gen')) {
      const imageResponse = await generateImageResponse(userMessage, this.conversation)
      return imageResponse ? [imageResponse] : []
    }

    // Even with the switch off, an unpack request must never fall through to the question path
    if (isUnpackRequest(userMessage)) {
      return handleUnpackRequest(this, userMessage)
    }

    // Handle mind map command
    if (hasCommand(userMessage, 'mindmap')) {
      return await generateMindMap(this, userMessage)
    }

    // Message on the group chat (chat or, pre-event, pregame)?
    if (isGroupChatMessage(userMessage?.channels)) {
      const llm = await this.getLLM()
      if (!(await checkBotIntent(llm, this.agentConfig?.botName, userMessage))) {
        return []
      }
      return await answerQuestion.call(this, userMessage, filterModeratorHistory(conversationHistory), options)
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
      ...options,
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
    if (channel.name === PREGAME_CHANNEL) {
      return [
        {
          message: {
            text: renderAgentTemplate(this.agentConfig.pregameChatIntroMessage, this.toObject()),
            type: 'intro'
          },
          messageType: 'json',
          channels: [channel],
          visible: true
        }
      ]
    }
    if (isGroupChatMessage([channel.name])) {
      const templateByAdapter = {
        zoom: this.agentConfig.zoomChatIntroMessage,
        presentation: this.agentConfig.presentationChatIntroMessage
      }
      const templateStr = templateByAdapter[adapterType] ?? this.agentConfig.chatIntroMessage
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

  async onConversationEvent(evt: ConversationEvent) {
    if (evt.conversationId !== this.conversation?._id?.toString()) return []

    if (evt.type === 'conversationWindowCountdown') {
      if (evt.phase !== 'preEvent') return []

      // Re-checked at the read site even though the dispatcher already gated it, the same way
      // conceptCartographer/vibesAnalyst do — least privilege stays visible where the read happens.
      access.assertCanRead(this, { type: 'conversation', id: evt.conversationId }, evt.type)

      const channel = this.conversation.channels?.find((c) => c.name === PREGAME_CHANNEL)
      if (!channel) return []

      const alreadyPosted = await Message.exists({
        conversation: this.conversation._id,
        pseudonymId: this.pseudonyms[0]._id,
        channels: PREGAME_CHANNEL,
        'body.type': 'threeFacts'
      })
      if (alreadyPosted) return []

      try {
        const threeFacts = await buildThreeFactsMessage.call(this)
        if (!threeFacts?.facts?.length) return []
        return [
          {
            message: { type: 'threeFacts', facts: threeFacts.facts, invitation: threeFacts.invitation },
            messageType: 'json',
            channels: [channel],
            visible: true
          }
        ]
      } catch (err) {
        logger.error('[onConversationEvent] LLM call failed for three facts', err)
        return []
      }
    }

    return []
  },

  formatTraceInput(_conversationHistory: ConversationHistory, userMessage: IMessage | undefined) {
    const personality = this.agentConfig?.personality ?? (config.enableAgentPersonality ? 'sarcastic-expert' : null)
    if (!userMessage) {
      return {
        trigger: 'periodic',
        behaviorPolicy: this.conversation.behaviorPolicy,
        goals: (this.conversation.goals ?? []).flatMap((id) => {
          try {
            return [loadGoal(id)]
          } catch {
            return []
          }
        }),
        conversationContext: this.conversation.conversationContext,
        personality
      }
    }
    return {
      question: userMessage?.body,
      behaviorPolicy: this.conversation.behaviorPolicy,
      conversationContext: this.conversation.conversationContext,
      personality
    }
  },

  formatTraceOutput(responses: TraceResponse[]) {
    if (responses.length > 0 && (responses[0]?.message as { type?: string })?.type === 'checkin') {
      return responses.map((r) => {
        const goal = r.goalId
          ? (this.conversation.goals ?? [])
              .flatMap((id) => {
                try {
                  return [loadGoal(id)]
                } catch {
                  return []
                }
              })
              .find((g) => g.id === r.goalId) ?? null
          : null
        return {
          participant: r.participantPseudonym,
          goalId: r.goalId,
          goal,
          confidenceScore: r.confidenceScore,
          detectedPattern: r.detectedPattern,
          reasoning: r.reasoning,
          messageSent: (r.message as { text?: string })?.text,
          context: r.context
        }
      })
    }
    return { message: responses[0]?.message, context: responses[0]?.context }
  },

  getTraceMetadata(conversationHistory: ConversationHistory, userMessage: IMessage | undefined, responses: TraceResponse[]) {
    if (!userMessage) {
      return {
        triggerType: 'periodic',
        topic: this.conversation.name
      }
    }
    return {
      conversationHistory,
      channels: userMessage?.channels,
      promptType: responses[0]?.promptType,
      topic: responses[0]?.topic
    }
  }
})
