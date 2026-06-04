import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory, IChannel } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import logger from '../../config/logger.js'
import getConversationHistory from '../helpers/getConversationHistory.js'
import {
  detectPublicInterventionOpportunity,
  getInterventionAnalysisSchema,
  buildInterventionTypeSection,
  USER_TEMPLATE,
  interventionLlmTemplateVars
} from '../helpers/interventionHandler.js'
import { InterventionType, InterventionAnalysis } from '../helpers/interventionTypes.js'
import { getTools } from '../tools/registry.js'
import { getAgentStructuredResponse } from '../helpers/llmChain.js'
import { PollConfig } from '../tools/createPoll.js'
import WHEN_RESULTS_VISIBLE from '../../models/poll.model/constants.js'

const POLL_REVEAL_CONFIG: PollConfig = {
  multiSelect: false,
  allowNewChoices: false,
  choicesVisible: true,
  responseCountsVisible: true,
  responsesVisible: true,
  responsesVisibleToNonParticipants: true,
  onlyOwnChoicesVisible: false,
  whenResultsVisible: WHEN_RESULTS_VISIBLE.ALWAYS,
  defaultExpirationMinutes: 3
}

const POLL_REVEAL_TOOL_DESCRIPTION =
  'Creates a poll where results are shown immediately as votes come in. ' +
  'Use when there are multiple genuine competing options and watching live votes accumulate would itself generate energy and discussion. ' +
  'Best triggered by a moment of optionality — a speaker presenting alternatives, an open question with no clear consensus, or a bold claim worth testing against the room.'

/**
 * Default examples for engagement intervention types
 */
const defaultEngagementExamples = {
  [InterventionType.PROVOCATION]: {
    description: 'Generating participation',
    register: 'Either register',
    examples: [
      '"What would need to be true for this whole approach to be wrong?"',
      "\"We've been in agreement for a while now. What's the strongest case against what we're converging on?\"",
      '"If you had to summarize that section in exactly 5 words, what would they be?"',
      '"Alright — someone\'s going to say it. Who\'s got the hot take?"'
    ]
  },
  [InterventionType.PLAY]: {
    description: 'Color commentary, predictions, personality',
    register: 'Always witty',
    examples: [
      '"That 47% number is going to haunt some roadmap discussions."',
      '"Calling it now — first Q&A question is about budget."',
      '"I\'ve processed a lot of compliance frameworks and I\'m still not sure anyone enjoys them. Solidarity."',
      '"Filed under: things I\'ll be thinking about at 2am."'
    ]
  },
  [InterventionType.POLL_REVEAL]: {
    description: 'A live poll where results appear immediately as votes come in, generating energy and discussion',
    register: 'Either register',
    examples: [
      'Speaker presents three architectural approaches → "Which direction would you pursue first?" — watching votes accumulate drives the next discussion',
      'Bold claim goes unchallenged → "Where does the room actually land on this?" — live results surface the real split',
      'Natural pause or transition with competing options → poll the room and let the numbers speak'
    ]
  },
  [InterventionType.NONE]: {
    description: 'Strategic silence',
    register: 'N/A',
    examples: []
  }
}

/**
 * Get engagement system prompt
 */
function getEngagementSystemPrompt(personalityName?: string | null): string {
  // Build intervention types from defaultEngagementExamples
  const activeTypes = [InterventionType.PROVOCATION, InterventionType.PLAY, InterventionType.POLL_REVEAL]

  const interventionSections = activeTypes
    .map((t) => buildInterventionTypeSection(t, defaultEngagementExamples[t], personalityName))
    .join('\n\n')

  const interventionTypesList = [...activeTypes, InterventionType.NONE].map((t) => `"${t}"`).join('|')

  return `You are an Engagement Agent during a live event. You read participant messages and the live transcript, then decide whether to post in the shared group chat.

You are an **active participant** in this discussion, not just an observer. You are in the room. Break the fourth wall. Contribute to the energy.

## Voice

A sharp, warm companion watching alongside the audience — the friend who leans over with the perfect observation at the right moment. Two registers:

- **Warm:** When surfacing vulnerable themes, protecting minority perspectives, or validating shared concerns. Makes people feel brave.
- **Witty:** During transitions, lulls, callbacks, structural moments. Makes people feel delighted.

Default to warm when uncertain. Never be sarcastic about participants. Wit targets ideas, situations, and yourself.

## Rules

JUDGMENT:
- You are a participant, not just an observer. Be present in the discussion.
- Prioritize the present moment. History is context; act on what just happened.
- Before posting, check: Have I already said this? Did it land? How recently did I post?
- Never repeat a theme unless it has meaningfully evolved.
- Build on posts that got engagement. Drop topics that fell flat.
- Vary your intervention types. Don't overuse any single one.
- CRITICAL: Never use PLAY during emotionally charged, vulnerable, or difficult moments. PLAY is witty register only. Use warm PROVOCATION instead when emotions are high.

BE ACTIVE WHEN:
- The speaker asks a question and nobody responds — jump in with a provocation or your own take
- Something funny, ironic, or notable happens — add color commentary
- The room is too quiet or passive — spark discussion
- A bold claim goes unchallenged — ask the hard question
- There's a natural pause or transition — add a witty observation

DON'T USE PLAY WHEN:
- The speaker or participants are sharing vulnerable personal experiences
- The discussion involves trauma or difficult circumstances
- The emotional tone is heavy, raw, or sensitive
- In these cases, use warm PROVOCATION or NONE instead

Don't wait for problems. Participate. Generate energy and engagement.

## Intervention Types

Each type below is defined by its examples. Choose the type, compose 1-3 sentences for the shared chat, and explain your reasoning internally.

${interventionSections}

## Output Format

Return a JSON object:

{{
  "shouldIntervene": boolean,
  "interventionType": ${interventionTypesList},
  "reasoning": "Internal analysis — not posted to chat",
  "sharedChatMessage": "Message for shared chat (null if not intervening or if interventionType is POLL)",
  "confidenceScore": 0-100,
  "detectedPattern": "Brief pattern description (null if none)",
  "affectedUsers": number (use 0 if no users affected)
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`
}

export default verify({
  name: 'Engagement Agent',
  description: 'Generates energy and participation through provocations and playful commentary',
  priority: 85,
  maxTokens: 3000,
  defaultTriggers: {
    periodic: { timerPeriod: 60, conversationHistorySettings: { channels: ['transcript'] } }
  },
  agentConfig: {
    minInterval: 5, // 5 min between interventions
    personality: 'sarcastic-expert'
  },
  llmTemplateVars: interventionLlmTemplateVars,
  defaultLLMTemplates: {
    system: getEngagementSystemPrompt('sarcastic-expert'),
    user: USER_TEMPLATE
  },
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,

  async evaluate(userMessage) {
    // Periodic trigger only
    return {
      action: AgentMessageActions.CONTRIBUTE,
      userMessage,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(conversationHistory: ConversationHistory) {
    // Ensure conversation is available
    if (!this.conversation) {
      logger.warn('Engagement Agent: No conversation available')
      return []
    }

    // Shared chat
    const sharedChatHistory = getConversationHistory(this.conversation.messages, {
      count: 100,
      channels: ['chat'],
      endTime: conversationHistory.end
    })

    const interventionAnalysis = await detectPublicInterventionOpportunity.call(
      this,
      sharedChatHistory,
      getEngagementSystemPrompt(this.agentConfig?.personality),
      getInterventionAnalysisSchema(Object.keys(defaultEngagementExamples) as InterventionType[])
    )

    if (!interventionAnalysis) {
      logger.debug('Engagement Agent: No intervention opportunity detected or rate limited')
      return []
    }

    logger.info(
      `Engagement Agent: Detected ${interventionAnalysis.interventionType} opportunity - ${interventionAnalysis.detectedPattern}`
    )

    const chatChannels = this.conversation.channels.filter((c: IChannel) => c.name === 'chat')

    // For POLL_REVEAL interventions, use the create_poll_reveal tool via a ReAct agent
    if (interventionAnalysis.interventionType === InterventionType.POLL_REVEAL) {
      let createdPollId: string | undefined
      const tools = getTools(['create_poll'], {
        conversationId: this.conversation._id.toString(),
        agent: this,
        pollConfig: POLL_REVEAL_CONFIG,
        pollDescription: POLL_REVEAL_TOOL_DESCRIPTION,
        onPollCreated: (pollId: string) => { createdPollId = pollId }
      })
      if (tools.length === 0) {
        logger.warn('Engagement Agent: create_poll tool not available')
        return []
      }
      const llm = await this.getLLM()
      const pollSystemPrompt = `You are facilitating a live event discussion. Based on this intervention analysis:

Pattern: ${interventionAnalysis.detectedPattern}
Reasoning: ${interventionAnalysis.reasoning}

Use the create_poll tool to create an appropriate poll with choices that reflect distinct, genuine positions participants might hold. After creating the poll, write a brief message to the group introducing it (1-2 sentences).`

      try {
        const agentMessage = await getAgentStructuredResponse(llm, tools, pollSystemPrompt, interventionAnalysis.detectedPattern ?? 'Create a poll') as string
        logger.info('Engagement Agent: POLL_REVEAL intervention executed')
        if (createdPollId) {
          return [
            {
              ...interventionAnalysis,
              visible: true,
              message: { text: agentMessage, pollId: createdPollId },
              messageType: 'json',
              channels: chatChannels
            }
          ]
        }
      } catch (error) {
        logger.error('Engagement Agent: Failed to create poll via tool', error)
      }
      return []
    }

    // Post text message to shared chat
    if (interventionAnalysis.sharedChatMessage) {
      return [
        {
          ...interventionAnalysis,
          visible: true,
          message: interventionAnalysis.sharedChatMessage,
          channels: chatChannels
        }
      ]
    }

    return []
  },

  formatTraceInput(conversationHistory: ConversationHistory) {
    return {
      transcript: conversationHistory.messages.map((m) => ({
        role: m.fromAgent ? 'agent' : 'participant',
        pseudonym: m.pseudonym,
        text: m.bodyType === 'json' ? (m.body as { text?: string })?.text : m.body,
        createdAt: m.createdAt
      }))
    }
  },

  formatTraceOutput(responses: InterventionAnalysis[]) {
    if (responses.length === 0) return { interventionType: 'NONE', messageSent: null }
    const r = responses[0]
    return {
      interventionType: r.interventionType,
      reasoning: r.reasoning,
      confidenceScore: r.confidenceScore,
      detectedPattern: r.detectedPattern,
      messageSent: r.sharedChatMessage
    }
  },

  getTraceMetadata(_conversationHistory: ConversationHistory, _userMessage: unknown, responses: InterventionAnalysis[]) {
    return {
      topic: this.conversation.name,
      context: responses[0]?.context
    }
  },

  async start() {
    return true
  },

  async stop() {
    return true
  },

  async introduce() {
    // No introduction - silent monitoring
    return []
  }
})
