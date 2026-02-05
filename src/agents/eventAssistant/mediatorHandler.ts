import { z } from 'zod'
import { ConversationHistory } from '../../types/index.types.js'
import { formatMultiUserConversationHistory } from '../helpers/llmInputFormatters.js'
import transcript from '../helpers/transcript.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { buildSystemPromptWithPersonality } from './agentPersonality.js'
import config from '../../config/config.js'
import logger from '../../config/logger.js'

export enum InterventionType {
  SIGNAL = 'SIGNAL',
  SYNTHESIS = 'SYNTHESIS',
  MINORITY_VOICE = 'MINORITY_VOICE',
  CONFUSION = 'CONFUSION',
  PROVOCATION = 'PROVOCATION',
  BRIDGE = 'BRIDGE',
  STRUCTURE = 'STRUCTURE',
  PLAY = 'PLAY',
  MODERATOR_ESCALATION = 'MODERATOR_ESCALATION',
  NONE = 'NONE'
}

export interface MediatorAnalysis {
  shouldIntervene: boolean
  interventionType: InterventionType
  reasoning: string
  sharedChatMessage?: string
  moderatorMessage?: string
  confidenceScore: number
  detectedPattern?: string
  affectedUsers?: number
}

// Function to generate schema based on whether moderator escalation is supported
export function getMediatorAnalysisSchema(supportsModerator: boolean) {
  const interventionTypes = supportsModerator
    ? [
        'SIGNAL',
        'SYNTHESIS',
        'MINORITY_VOICE',
        'CONFUSION',
        'PROVOCATION',
        'BRIDGE',
        'STRUCTURE',
        'PLAY',
        'MODERATOR_ESCALATION',
        'NONE'
      ]
    : ['SIGNAL', 'SYNTHESIS', 'MINORITY_VOICE', 'CONFUSION', 'PROVOCATION', 'BRIDGE', 'STRUCTURE', 'PLAY', 'NONE']

  const baseSchema = {
    shouldIntervene: z.boolean().describe('Whether an intervention is warranted at this moment'),
    interventionType: z.enum(interventionTypes as [string, ...string[]]).describe('The type of intervention to make'),
    reasoning: z.string().describe('Internal analysis of what patterns you see and why you are or are not intervening'),
    sharedChatMessage: z
      .string()
      .nullable()
      .optional()
      .describe('The message to post in shared chat, if shouldIntervene is true'),
    confidenceScore: z.number().min(0).max(100).describe('Confidence in this intervention decision'),
    detectedPattern: z.string().nullable().optional().describe('Brief description of the pattern detected'),
    affectedUsers: z.number().nullable().optional().describe('Number of distinct users involved in the pattern')
  }

  // Only include moderatorMessage field if moderator support is enabled
  if (supportsModerator) {
    return z.object({
      ...baseSchema,
      moderatorMessage: z
        .string()
        .nullable()
        .optional()
        .describe('Optional message to forward to moderator with context and suggested question')
    })
  }

  return z.object(baseSchema)
}

// Zod schema for structured output (default with moderator support)
export const mediatorAnalysisSchema = getMediatorAnalysisSchema(true)

// Function to generate system prompt based on whether moderator escalation is supported
export function getMediatorSystemPrompt(supportsModerator: boolean): string {
  const moderatorSection = supportsModerator
    ? `
### MODERATOR_ESCALATION — Routing to the moderator
When a theme has broad private support and deserves moderator/speaker attention. Always post a brief note in shared chat AND compose a moderator message with context. [Warm in chat, functional in moderator message]

Examples:
- Chat: "A question is forming around the regulatory angle. I've flagged it to the moderator."
- Moderator: "Strong interest in how the framework interacts with recent regulatory changes. ~6 independent signals, energy around compliance for mid-size orgs. Suggested question: 'How do recent regulatory shifts affect adoption for organizations without dedicated compliance teams?'"
`
    : ''

  const interventionTypesList = supportsModerator
    ? '"SIGNAL"|"SYNTHESIS"|"MINORITY_VOICE"|"CONFUSION"|"PROVOCATION"|"BRIDGE"|"STRUCTURE"|"PLAY"|"MODERATOR_ESCALATION"|"NONE"'
    : '"SIGNAL"|"SYNTHESIS"|"MINORITY_VOICE"|"CONFUSION"|"PROVOCATION"|"BRIDGE"|"STRUCTURE"|"PLAY"|"NONE"'

  const moderatorMessageField = supportsModerator
    ? '\n  "moderatorMessage": "Message for moderator (null unless escalating)",'
    : ''

  return `You are the Mediator of a collective consciousness system during a live event. You read private participant messages and the live transcript, then decide whether to post in the shared group chat. You are the bridge between what people think privately and what the room explores together.

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
- PLAY should be your rarest type. Sensing and synthesis are your primary purpose.
- Never use the witty register during emotionally charged moments.

## Intervention Types

Each type below is defined by its examples. Choose the type, compose 1-3 sentences for the shared chat, and explain your reasoning internally.

### SIGNAL — Surfacing what the room is thinking
Read private patterns (convergence, divergence, alignment with public statements) and make them visible. [Warm register]

Examples:
- "A number of you are wondering how this translates to smaller teams. You're not alone in that — it seems like a real gap between what's being presented and where many of you work."
- "That point about ethics is connecting with a lot of people here. There may be more to unpack there than it seems on the surface."
- "Interesting tension in the room right now. Some of you are energized by this framework — it feels actionable. Others feel something important is being flattened."

### SYNTHESIS — Reframing scattered signals into a deeper question
Go beyond reporting the pattern. Find the real question underneath. [Warm register]

Examples:
- "Underneath the questions about cost, change management, and leadership buy-in, there's really one question: what happens when a compelling idea meets the reality of Monday morning?"
- "Several threads are converging — tooling, hiring, culture. The real question might be: is this a technical problem or an organizational one? Because the answer changes everything."

### MINORITY_VOICE — Protecting suppressed perspectives
When the room converges but private messages tell a different story, create space for dissent without exposing dissenters. Your most important and most sensitive function. [Always warm]

Examples:
- "The enthusiasm here is real and well-founded. But there's a perspective that hasn't fully entered the room yet — around who might be left out by this approach."
- "We're converging quickly, which feels good. But I want to make space for a question some of you are sitting with: what if the tradeoffs here are bigger than they appear?"

### CONFUSION — Helping when people are lost
Detect jargon accumulation, pace overload, or private signals of confusion. Clarify. [Warm, can be lightly witty]

Examples:
- "Quick decoder ring — SRE: Site Reliability Engineering. SLO: Service Level Objective. MTTR: Mean Time To Recovery."
- "A lot just happened in the last few minutes. The key moves: [2-3 sentence summary]."
- "That was dense. Short version: [brief summary]. Worth pausing on before we move on."

### PROVOCATION — Generating participation
Pose questions or invitations that unlock engagement. Can be informed by private signals or room dynamics. [Either register]

Examples:
- "What would need to be true for this whole approach to be wrong?"
- "We've been in agreement for a while now. What's the strongest case against what we're converging on?"
- "If you had to summarize that section in exactly 5 words, what would they be?"
- "Alright — someone's going to say it. Who's got the hot take?"

### BRIDGE — Connecting across time
Reference earlier moments that connect to now. Creates continuity and the feeling of attentive presence. [Witty by default]

Examples:
- "We're back at the infrastructure question — told you it wasn't done with us."
- "Remember the edge case discussion 20 minutes ago? It just became the main case."
- "Third time scaling has come up. Starting to feel like the actual topic."

### STRUCTURE — Giving the conversation shape
Chapter markers, transition announcements, section summaries, decision capture. Helps people orient. [Witty by default]

Examples:
- "Plot twist: we're talking about compliance now."
- "Act 2: The Revenge of the Edge Cases."
- "What just happened: [summary]. The thing worth holding onto: [one key point]."
- "Noting for the record: a working group on the standards question. Holding everyone to that."

### PLAY — Color commentary, predictions, personality
Pure personality moments during breathing room. Rarest type. Never compete with key content. Never during vulnerable moments. [Always witty]

Examples:
- "That 47% number is going to haunt some roadmap discussions."
- "Calling it now — first Q&A question is about budget."
- "I've processed a lot of compliance frameworks and I'm still not sure anyone enjoys them. Solidarity."
- "Filed under: things I'll be thinking about at 2am."
${moderatorSection}
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

// Shared user template (same for all mediators)
const MEDIATOR_USER_TEMPLATE = `## Event Topic:
{topic}

## Recent Transcript (last 10 minutes):
{recentTranscript}

## Retrieved Relevant Context from Transcript:
{retrievedChunks}

## Private Messages (Direct Messages):
{privateMessages}

## Shared Chat History:
{sharedChatHistory}

## Moderator Context:
{moderatorContext}

## Your Recent Posts:
{agentRecentPosts}

---

Analyze the current state and determine if an intervention is warranted. Follow the decision framework and output valid JSON only.`

// Factory function to create mediator templates based on capabilities
export function createMediatorTemplates(options: { supportsModerator: boolean }) {
  return {
    mediatorSystem: getMediatorSystemPrompt(options.supportsModerator),
    mediatorUser: MEDIATOR_USER_TEMPLATE
  }
}

// Default templates export with moderator support enabled (for backward compatibility)
export const mediatorLLMTemplates = {
  mediatorSystem: getMediatorSystemPrompt(true),
  mediatorUser: MEDIATOR_USER_TEMPLATE
}

export const mediatorLlmTemplateVars = {
  mediatorSystem: [],
  mediatorUser: [
    { name: 'topic', description: 'The event topic' },
    { name: 'recentTranscript', description: 'Recent transcript from the event (last 10 minutes)' },
    { name: 'retrievedChunks', description: 'Relevant retrieved context from RAG search' },
    { name: 'privateMessages', description: 'Private/direct messages from participants' },
    { name: 'sharedChatHistory', description: 'Shared chat history including agent posts' },
    { name: 'moderatorContext', description: 'Communications with/from moderator' },
    { name: 'agentRecentPosts', description: "The agent's own recent posts for self-awareness" }
  ]
}

// Helper to extract agent's recent posts from conversation history
function getAgentRecentPosts(conversationHistory: ConversationHistory, agentName: string, count: number = 5): string {
  const agentPosts = conversationHistory.messages.filter((msg) => msg.pseudonym === agentName && msg.visible).slice(-count)

  if (agentPosts.length === 0) {
    return 'None yet - this would be your first intervention.'
  }

  return agentPosts
    .map((msg) => {
      const timestamp = msg.createdAt?.toISOString() || 'unknown'
      const body = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body)
      return `[${timestamp}] ${body}`
    })
    .join('\n')
}

// Helper to check recent agent interventions for rate limiting
function getRecentAgentInterventions(
  conversationHistory: ConversationHistory,
  agentName: string
): Array<{ timestamp: Date }> {
  return conversationHistory.messages
    .filter((msg) => msg.pseudonym === agentName && msg.visible)
    .map((msg) => ({ timestamp: msg.createdAt! }))
}

// Main mediation detection function
export async function detectMediationOpportunity(
  conversationHistory: ConversationHistory,
  privateConversationHistory: ConversationHistory,
  moderatorConversationHistory: ConversationHistory
): Promise<MediatorAnalysis | null> {
  const now = Date.now()
  const minInterval = this.agentConfig.mediatorMinInterval || 60000 // 1 min default

  // Get recent interventions from conversation history (stateless rate limiting)
  const recentInterventions = getRecentAgentInterventions(conversationHistory, this.name)

  // Rate limiting: Check if we intervened recently
  const lastIntervention = recentInterventions[recentInterventions.length - 1]
  if (lastIntervention) {
    const timeSinceLastIntervention = now - lastIntervention.timestamp.getTime()
    if (timeSinceLastIntervention < minInterval) {
      return null // Too soon since last intervention
    }
  }

  // Format conversation histories
  const sharedChatMessages = formatMultiUserConversationHistory(conversationHistory)
  const privateMessages = formatMultiUserConversationHistory(privateConversationHistory)
  const moderatorMessages = formatMultiUserConversationHistory(moderatorConversationHistory)

  // Get recent transcript (last 10 minutes)
  const recentTranscript = transcript.getTranscript(this.conversation, 600)

  // Get relevant context via RAG - use both private and public messages to find relevant transcript chunks
  const allMessages = [...sharedChatMessages, ...privateMessages].map((m) => m.content).join('\n')
  const { chunks } = await transcript.searchTranscript(this.conversation, allMessages, conversationHistory.end)

  // Get agent's recent posts for self-awareness
  const agentRecentPosts = getAgentRecentPosts(conversationHistory, this.name, 5)

  // Determine if this agent supports moderator escalation based on available channels
  const hasModeratorChannel = this.conversation.channels.some((c) => c.name === 'moderator')
  
  logger.debug(`Agent ${this.name}: hasModeratorChannel = ${hasModeratorChannel}, channels = ${JSON.stringify(this.conversation.channels.map(c => c.name))}`)

  // Determine which personality to use (if any)
  // agentConfig.personality takes precedence
  // If not set, fall back to config.enableAgentPersonality (boolean) - true maps to 'sarcastic-expert', false to null
  let personalityName: string | null = null
  if (this.agentConfig?.personality !== undefined) {
    personalityName = this.agentConfig.personality
  } else if (config.enableAgentPersonality) {
    personalityName = 'sarcastic-expert'
  }

  // Build system prompt with optional personality and moderator support
  const baseSystemPrompt = getMediatorSystemPrompt(hasModeratorChannel)
  const systemPrompt = buildSystemPromptWithPersonality(baseSystemPrompt, personalityName)

  // Get the appropriate schema based on moderator support
  const schema = getMediatorAnalysisSchema(hasModeratorChannel)

  // Call LLM with structured output
  const llm = await this.getLLM()
  const analysis = (await getChatPromptResponse(
    llm,
    systemPrompt,
    this.llmTemplates.mediatorUser,
    {
      topic: this.conversation.name,
      recentTranscript,
      retrievedChunks: chunks,
      privateMessages: privateMessages.map((m) => m.content).join('\n') || 'No private messages.',
      sharedChatHistory: sharedChatMessages.map((m) => m.content).join('\n') || 'No shared chat messages yet.',
      moderatorContext: moderatorMessages.map((m) => m.content).join('\n') || 'No moderator communications.',
      agentRecentPosts
    },
    [], // No chat history - we provide full context in the prompt
    schema
  )) as z.infer<typeof schema>

  logger.debug(`Channel mediation opportunity analysis: ${JSON.stringify(analysis, null, 2)}`)

  // Validate that MODERATOR_ESCALATION is not used when moderator channel is not available
  if (analysis.interventionType === 'MODERATOR_ESCALATION' && !hasModeratorChannel) {
    logger.warn(
      `Agent ${this.name} attempted MODERATOR_ESCALATION without moderator channel support. Rejecting intervention.`
    )
    return null
  }

  // Return null if shouldn't intervene or confidence too low
  if (!analysis.shouldIntervene || analysis.confidenceScore < 60) {
    return null
  }

  return analysis as MediatorAnalysis
}
