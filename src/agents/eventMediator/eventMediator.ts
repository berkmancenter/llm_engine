import verify from '../helpers/verify.js'
import { AgentMessageActions, AgentResponse, ConversationHistory, IChannel } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import {
  USER_TEMPLATE,
  interventionLlmTemplateVars,
  detectInterventionOpportunity,
  getInterventionAnalysisSchema,
  buildInterventionTypeSection
} from '../helpers/interventionHandler.js'
import { InterventionType } from '../helpers/interventionTypes.js'
import getConversationHistory from '../helpers/getConversationHistory.js'
import logger from '../../config/logger.js'

const defaultInterventionExamples = {
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
  [InterventionType.NONE]: {
    description: 'Strategic silence',
    register: 'N/A',
    examples: []
  }
}

function getMediatorSystemPrompt(personalityName?: string | null): string {
  const allTypes = Object.keys(defaultInterventionExamples) as InterventionType[]
  const activeTypes = allTypes.filter((t) => t !== InterventionType.NONE)

  const interventionSections = activeTypes
    .map((t) => buildInterventionTypeSection(t, defaultInterventionExamples[t], personalityName))
    .join('\n\n')

  const interventionTypesList = [...activeTypes, InterventionType.NONE].map((t) => `"${t}"`).join('|')

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
  "sharedChatMessage": "Message for shared chat (null if not intervening)",
  "confidenceScore": 0-100,
  "detectedPattern": "Brief pattern description (null if none)",
  "affectedUsers": number (use 0 if no users affected)
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`
}

export default verify({
  name: 'Event Mediator',
  description:
    'Makes strategic interventions in shared chat based on configurable intervention categories: collective consciousness, engagement, and facilitation',
  priority: 85,
  maxTokens: 3000,
  // uses 67 seconds for now to prevent overlap with Engagement Agent (timer set to 60 seconds) - can be adjusted as needed
  defaultTriggers: {
    periodic: { timerPeriod: 67, conversationHistorySettings: { channels: ['transcript'] } }
  },
  agentConfig: {
    minInterval: 2, // 2 min between interventions
    personality: 'sarcastic-expert' // Use sarcastic-expert personality (set to null for no personality)
  },
  llmTemplateVars: interventionLlmTemplateVars,
  defaultLLMTemplates: {
    system: getMediatorSystemPrompt('sarcastic-expert'),
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

  async respond(conversationHistory: ConversationHistory): Promise<AgentResponse<string | Record<string, unknown>>[]> {
    if (!this.conversation) {
      logger.warn(`${this.name}: No conversation available`)
      return []
    }

    const sharedChatHistory = getConversationHistory(this.conversation.messages, {
      count: 100,
      channels: ['chat'],
      endTime: conversationHistory.end
    })

    const privateHistory = getConversationHistory(
      this.conversation.messages,
      {
        count: 100,
        directMessages: true,
        endTime: conversationHistory.end
      },
      null,
      this.conversation.channels.filter((c: IChannel) => c.direct).map((c: IChannel) => c.name)
    )

    const interventionAnalysis = await detectInterventionOpportunity.call(
      this,
      sharedChatHistory,
      getMediatorSystemPrompt(this.agentConfig.personality),
      getInterventionAnalysisSchema(Object.keys(defaultInterventionExamples) as InterventionType[]),
      privateHistory
    )

    if (!interventionAnalysis) {
      logger.debug(`${this.name}: No intervention opportunity detected or rate limited`)
      return []
    }

    logger.info(
      `${this.name}: Detected ${interventionAnalysis.interventionType} opportunity - ${interventionAnalysis.detectedPattern}`
    )

    const responses: AgentResponse<string | Record<string, unknown>>[] = []

    if (interventionAnalysis.sharedChatMessage) {
      responses.push({
        visible: true,
        message: interventionAnalysis.sharedChatMessage,
        channels: this.conversation.channels.filter((c: IChannel) => c.name === 'chat'),
        context: `Intervention Type: ${interventionAnalysis.interventionType}\nReasoning: ${
          interventionAnalysis.reasoning
        }\nPattern: ${interventionAnalysis.detectedPattern || 'N/A'}`
      })
    }

    return responses
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
