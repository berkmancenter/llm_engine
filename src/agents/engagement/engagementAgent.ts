import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import logger from '../../config/logger.js'
import getConversationHistory from '../helpers/getConversationHistory.js'
import {
  detectInterventionOpportunity,
  getInterventionAnalysisSchema,
  buildInterventionTypeSection,
  USER_TEMPLATE,
  interventionLlmTemplateVars
} from '../helpers/interventionHandler.js'
import { InterventionType } from '../helpers/interventionTypes.js'

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
  const activeTypes = [InterventionType.PROVOCATION, InterventionType.PLAY]

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
  "sharedChatMessage": "Message for shared chat (null if not intervening)",
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

    const interventionAnalysis = await detectInterventionOpportunity.call(
      this,
      sharedChatHistory,
      getEngagementSystemPrompt(this.agentConfig?.personality),
      getInterventionAnalysisSchema(Object.keys(defaultEngagementExamples) as InterventionType[], false)
    )

    if (!interventionAnalysis) {
      logger.debug('Engagement Agent: No intervention opportunity detected or rate limited')
      return []
    }

    logger.info(
      `Engagement Agent: Detected ${interventionAnalysis.interventionType} opportunity - ${interventionAnalysis.detectedPattern}`
    )

    // Post to shared chat
    if (interventionAnalysis.sharedChatMessage) {
      return [
        {
          visible: true,
          message: interventionAnalysis.sharedChatMessage,
          channels: this.conversation.channels.filter((c) => c.name === 'chat'),
          context: `Intervention Type: ${interventionAnalysis.interventionType}\nReasoning: ${
            interventionAnalysis.reasoning
          }\nPattern: ${interventionAnalysis.detectedPattern || 'N/A'}`
        }
      ]
    }

    return []
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
