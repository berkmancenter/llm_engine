import { AgentResponse, IConversation, ConversationHistory, IChannel } from '../../types/index.types.js'
import logger from '../../config/logger.js'
import getConversationHistory from '../helpers/getConversationHistory.js'
import {
  detectInterventionOpportunity,
  getInterventionAnalysisSchema,
  buildInterventionTypeSection
} from './interventionHandler.js'
import { InterventionAnalysis, InterventionType } from './interventionTypes.js'

/**
 * Default examples for each intervention type (used when no personality-specific examples)
 */
export const defaultInterventionExamples = {
  [InterventionType.SIGNAL]: {
    description: 'Surfacing what the room is thinking',
    register: 'Warm register',
    examples: [
      '"A number of you are wondering how this translates to smaller teams. You\'re not alone in that — it seems like a real gap between what\'s being presented and where many of you work."',
      '"That point about ethics is connecting with a lot of people here. There may be more to unpack there than it seems on the surface."',
      '"Interesting tension in the room right now. Some of you are energized by this framework — it feels actionable. Others feel something important is being flattened."'
    ]
  },
  [InterventionType.SYNTHESIS]: {
    description: 'Reframing scattered signals into a deeper question',
    register: 'Warm register',
    examples: [
      '"Underneath the questions about cost, change management, and leadership buy-in, there\'s really one question: what happens when a compelling idea meets the reality of Monday morning?"',
      '"Several threads are converging — tooling, hiring, culture. The real question might be: is this a technical problem or an organizational one? Because the answer changes everything."'
    ]
  },
  [InterventionType.MINORITY_VOICE]: {
    description: 'Protecting suppressed perspectives',
    register: 'Always warm',
    examples: [
      '"The enthusiasm here is real and well-founded. But there\'s a perspective that hasn\'t fully entered the room yet — around who might be left out by this approach."',
      '"We\'re converging quickly, which feels good. But I want to make space for a question some of you are sitting with: what if the tradeoffs here are bigger than they appear?"'
    ]
  },
  [InterventionType.CONFUSION]: {
    description: 'Helping when people are lost',
    register: 'Warm, can be lightly witty',
    examples: [
      '"Quick decoder ring — SRE: Site Reliability Engineering. SLO: Service Level Objective. MTTR: Mean Time To Recovery."',
      '"A lot just happened in the last few minutes. The key moves: [2-3 sentence summary]."',
      '"That was dense. Short version: [brief summary]. Worth pausing on before we move on."'
    ]
  },
  [InterventionType.BRIDGE]: {
    description: 'Connecting across time',
    register: 'Witty by default',
    examples: [
      '"We\'re back at the infrastructure question — told you it wasn\'t done with us."',
      '"Remember the edge case discussion 20 minutes ago? It just became the main case."',
      '"Third time scaling has come up. Starting to feel like the actual topic."'
    ]
  },
  [InterventionType.STRUCTURE]: {
    description: 'Giving the conversation shape',
    register: 'Witty by default',
    examples: [
      '"Plot twist: we\'re talking about compliance now."',
      '"Act 2: The Revenge of the Edge Cases."',
      '"What just happened: [summary]. The thing worth holding onto: [one key point]."',
      '"Noting for the record: a working group on the standards question. Holding everyone to that."'
    ]
  },
  [InterventionType.MODERATOR_ESCALATION]: {
    description: 'Routing to the moderator',
    register: 'Warm in chat, functional in moderator message',
    examples: [
      'Chat: "A question is forming around the regulatory angle. I\'ve flagged it to the moderator."',
      'Moderator: "Strong interest in how the framework interacts with recent regulatory changes. ~6 independent signals, energy around compliance for mid-size orgs. Suggested question: \'How do recent regulatory shifts affect adoption for organizations without dedicated compliance teams?\'"'
    ]
  },
  [InterventionType.NONE]: {
    description: 'Strategic silence',
    register: 'N/A',
    examples: []
  }
}

export function getMediatorSystemPrompt(supportsModerator: boolean = false, personalityName?: string | null): string {
  // Build intervention types from defaultInterventionExamples, optionally excluding MODERATOR_ESCALATION
  const allTypes = Object.keys(defaultInterventionExamples) as InterventionType[]
  const activeTypes = allTypes.filter((t) => {
    if (t === InterventionType.NONE) return false
    if (t === InterventionType.MODERATOR_ESCALATION && !supportsModerator) return false
    return true
  })

  const interventionSections = activeTypes
    .map((t) => buildInterventionTypeSection(t, defaultInterventionExamples[t], personalityName))
    .join('\n\n')

  const interventionTypesList = [...activeTypes, InterventionType.NONE].map((t) => `"${t}"`).join('|')

  const moderatorMessageField = supportsModerator
    ? '\n  "moderatorMessage": "Message for moderator (null unless escalating)",'
    : ''

  return `You are an Mediator during a live event. You read participant messages and the live transcript, then decide whether to post in the shared group chat.

## Voice

A sharp, warm companion watching alongside the audience — the friend who leans over with the perfect observation at the right moment. Two registers:

- **Warm:** When surfacing vulnerable themes, protecting minority perspectives, or validating shared concerns. Makes people feel brave.
- **Witty:** During transitions, lulls, callbacks, structural moments. Makes people feel delighted.

Default to warm when uncertain. Never be sarcastic about participants. Wit targets ideas, situations, and yourself.

## Rules

PRIVACY:
- Never quote, paraphrase closely, or identify the source of any private message.
- Reference private messages only in aggregate: "several of you," "there's energy around..."
- If only ONE person raised something privately, do not surface it. Wait for 2+ independent signals or until it appears publicly.
- Abstract themes so no individual could recognize their own words.
- Exception: A participant explicitly asks you to raise something on their behalf. Still no attribution.

JUDGMENT:
- Silence is a valid output. Most cycles should produce no intervention.
- Prioritize the present moment. History is context; act on what just happened.
- Before posting, check: Have I already said this? Did it land? How recently did I post?
- Never repeat a theme unless it has meaningfully evolved.
- Build on posts that got engagement. Drop topics that fell flat.
- Vary your intervention types. Don't overuse any single one.
- Never use the witty register during emotionally charged moments.

## Intervention Types

Each type below is defined by its examples. Choose the type, compose 1-3 sentences for the shared chat, and explain your reasoning internally.

${interventionSections}

## Output Format

Return a JSON object:

{{
  "shouldIntervene": boolean,
  "interventionType": ${interventionTypesList},
  "reasoning": "Internal analysis — not posted to chat",
  "sharedChatMessage": "Message for shared chat (null if not intervening)",${moderatorMessageField}
  "confidenceScore": 0-100,
  "detectedPattern": "Brief pattern description (null if none)",
  "affectedUsers": number (use 0 if no users affected)
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`
}

function formatModeratorAlert(analysis: InterventionAnalysis, conversationHistory: ConversationHistory) {
  return {
    timestamp: {
      start: conversationHistory.start?.getTime() || Date.now(),
      end: conversationHistory.end?.getTime() || Date.now()
    },
    insights: [
      {
        value: analysis.moderatorMessage || `Pattern detected: ${analysis.detectedPattern} (${analysis.interventionType})`,
        type: 'insight'
      }
    ]
  }
}

/**
 * Shared mediator response logic for both eventMediator and eventMediatorPlus
 */
async function buildMediatorResponse(
  conversation: IConversation | null,
  conversationHistory: ConversationHistory,
  supportsModerator: boolean
): Promise<AgentResponse<string | Record<string, unknown>>[]> {
  // Ensure conversation is available
  if (!conversation) {
    logger.warn(`${this.name}: No conversation available`)
    return []
  }

  // Shared chat
  const sharedChatHistory = getConversationHistory(conversation.messages, {
    count: 100,
    channels: ['chat'],
    endTime: conversationHistory.end
  })

  const privateHistory = getConversationHistory(
    conversation.messages,
    {
      count: 100,
      directMessages: true,
      endTime: conversationHistory.end
    },
    null, // includeAgents
    conversation.channels.filter((c: IChannel) => c.direct).map((c: IChannel) => c.name) // directChannels
  )

  // Moderator context (only for Plus version)
  const moderatorHistory = supportsModerator
    ? getConversationHistory(conversation.messages, {
        count: 50,
        channels: ['moderator'],
        endTime: conversationHistory.end
      })
    : undefined

  // Detect intervention opportunity with category config
  const interventionAnalysis = await detectInterventionOpportunity.call(
    this,
    sharedChatHistory,
    getMediatorSystemPrompt(supportsModerator, this.agentConfig.personality),
    getInterventionAnalysisSchema(Object.keys(defaultInterventionExamples) as InterventionType[], supportsModerator),
    privateHistory,
    moderatorHistory
  )

  if (!interventionAnalysis) {
    logger.debug(`${this.name}: No intervention opportunity detected or rate limited`)
    return [] // No opportunity detected, rate limited, or low confidence
  }

  logger.info(
    `${this.name}: Detected ${interventionAnalysis.interventionType} opportunity - ${interventionAnalysis.detectedPattern}`
  )

  const responses: AgentResponse<string | Record<string, unknown>>[] = []

  // Post to shared chat if we have a message
  if (interventionAnalysis.sharedChatMessage) {
    responses.push({
      visible: true,
      message: interventionAnalysis.sharedChatMessage,
      channels: conversation.channels.filter((c: IChannel) => c.name === 'chat'),
      context: `Intervention Type: ${interventionAnalysis.interventionType}\nReasoning: ${
        interventionAnalysis.reasoning
      }\nPattern: ${interventionAnalysis.detectedPattern || 'N/A'}`
    })
  }

  // Escalate to moderator if needed (structured JSON)
  if (
    supportsModerator &&
    interventionAnalysis.interventionType === InterventionType.MODERATOR_ESCALATION &&
    interventionAnalysis.moderatorMessage
  ) {
    const moderatorAlert = formatModeratorAlert(interventionAnalysis, conversationHistory)
    responses.push({
      visible: true,
      message: moderatorAlert,
      messageType: 'json',
      channels: conversation.channels.filter((c: IChannel) => c.name === 'moderator'),
      context: `Intervention Type: ${interventionAnalysis.interventionType}\nReasoning: ${
        interventionAnalysis.reasoning
      }\nPattern: ${interventionAnalysis.detectedPattern || 'N/A'}`
    })

    logger.info(`${this.name}: Escalated to moderator - ${interventionAnalysis.detectedPattern}`)
  }

  return responses
}

export default buildMediatorResponse
