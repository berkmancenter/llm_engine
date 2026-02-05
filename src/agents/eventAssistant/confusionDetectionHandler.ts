import { z } from 'zod'
import { ConversationHistory } from '../../types/index.types.js'
import { formatMultiUserConversationHistory } from '../helpers/llmInputFormatters.js'
import transcript from '../helpers/transcript.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'

export interface ConfusionDetectionResult {
  confusionDetected: boolean
  confusionType: 'event-logistics' | 'content-clarification' | 'speaker-expertise' | 'off-topic' | 'none'
  confusionTopic: string
  canResolveDirectly: boolean
  suggestedResponse?: string
  requiresEscalation: boolean
  confidenceScore: number
  affectedUsers: number
  context?: string
}

// LLM Templates
export const confusionDetectionLLMTemplates = {
  confusionDetectionSystem: `You are analyzing a live event chat to detect genuine confusion among participants.

**Your task**: Determine if recent chat messages indicate confusion that warrants assistant intervention.

**Confusion Indicators**:
- Questions about concepts/terms the speaker just mentioned
- Multiple users asking similar clarifying questions
- Explicit confusion statements ("I'm lost", "I don't understand", "what does X mean?")
- Repeated questions about the same topic
- Requests for repetition or clarification

**NOT Confusion**:
- General discussion or commentary
- Rhetorical questions
- Questions about future content ("will you cover X?")
- Off-topic chatter
- Single vague "what?" or "huh?" without context

**Context Sources**:
- Recent chat messages (last 10-20 messages)
- Recent transcript (what speaker said in last 5 minutes)
- Relevant results of RAG search from transcript

**Confusion Types**:
- **event-logistics**: Questions about event mechanics (start time, Q&A process, where to find resources)
- **content-clarification**: Questions about content that can be answered from transcript/context
- **speaker-expertise**: Questions requiring speaker's opinion, expertise, or decision
- **off-topic**: Confusion about unrelated topics
- **none**: No confusion detected

**Output Rules**:
  1. Output **must strictly follow this JSON schema** (all fields present, correct types):
     json
     {
       "confusionDetected": true|false,
       "confusionType": "event-logistics"|"content-clarification"|"speaker-expertise"|"off-topic"|"none",
       "confusionTopic": "brief description of the confusion point",
       "canResolveDirectly": true|false,
       "suggestedResponse": "optional, only if canResolveDirectly=true",
       "requiresEscalation": true|false,
       "confidenceScore": number between 0 and 100,
       "affectedUsers": number of distinct confused users
     }
  2. **All fields are required**, except suggestedResponse which is optional.
  3. confusionDetected must be true if any genuine confusion is detected; otherwise false.
  4. confusionType must match one of the defined enums.
  5. confusionTopic must be a short, specific description of the confusion.
  6. canResolveDirectly true only if the agent can provide a definitive response.
  7. suggestedResponse should be concise, helpful, natural tone, only if canResolveDirectly=true.
  8. requiresEscalation must be true if multiple participants confused or speaker expertise is required.
  9. confidenceScore must reflect certainty (0=very uncertain, 100=very certain).
  10. affectedUsers must reflect the count of distinct user pseudonyms showing confusion.
  11. Do **not** add any extra fields, comments, or explanations outside this JSON structure.
  12. Return **valid JSON only**, parsable without errors.

  **Important**: Strictly enforce schema compliance. Every response must be a single JSON object with the required fields. Do not respond in natural language outside of suggestedResponse.`,

  confusionDetectionUser: `## Event topic:
{topic}

## Recent transcript (last 5 minutes):
{recentTranscript}

## Retrieved context (if relevant):
{retrievedChunks}

Analyze the chat conversation history for confusion. If no genuine confusion exists, set confusionDetected to false.`
}

export const confusionDetectionLlmTemplateVars = {
  confusionDetectionSystem: [],
  confusionDetectionUser: [
    { name: 'topic', description: 'The event topic' },
    { name: 'recentTranscript', description: 'Recent transcript excerpts' },
    { name: 'retrievedChunks', description: 'Relevant retrieved context' }
  ]
}

// Zod schema for structured output
export const confusionDetectionSchema = z.object({
  confusionDetected: z.boolean(),
  confusionType: z.enum(['event-logistics', 'content-clarification', 'speaker-expertise', 'off-topic', 'none']),
  confusionTopic: z.string().describe('Brief description of confusion point'),
  canResolveDirectly: z.boolean(),
  suggestedResponse: z.string().optional(),
  requiresEscalation: z.boolean(),
  confidenceScore: z.number().min(0).max(100),
  affectedUsers: z.number().describe('Number of distinct users showing confusion')
})

// Helper to check recent agent interventions in conversation history
function getRecentAgentInterventions(
  conversationHistory: ConversationHistory,
  agentName: string
): Array<{ timestamp: Date }> {
  return conversationHistory.messages
    .filter((msg) => msg.pseudonym === agentName && msg.body)
    .map((msg) => ({ timestamp: msg.createdAt! }))
}

// Main detection function (stateless - uses conversation history for rate limiting and deduplication)
export async function detectConfusion(conversationHistory: ConversationHistory): Promise<ConfusionDetectionResult | null> {
  const now = Date.now()
  const minInterval = this.agentConfig.confusionDetectionInterval || 300000 // 5 min default

  // Get recent interventions from conversation history (stateless!)
  const recentInterventions = getRecentAgentInterventions(conversationHistory, this.name)

  // Rate limiting: Check if we intervened recently
  const lastIntervention = recentInterventions[recentInterventions.length - 1]
  if (lastIntervention) {
    const timeSinceLastIntervention = now - lastIntervention.timestamp.getTime()
    if (timeSinceLastIntervention < minInterval) {
      return null // Too soon since last intervention
    }
  }

  // LLM semantic analysis
  const chatMessages = formatMultiUserConversationHistory(conversationHistory)
  const recentTranscript = transcript.getTranscript(this.conversation, 300) // last 5 min

  // Get relevant context via RAG
  const chatText = chatMessages.map((m) => m.content).join('\n')
  const { chunks } = await transcript.searchTranscript(this.conversation, chatText, conversationHistory.end)

  const llm = await this.getLLM()
  const analysis = (await getChatPromptResponse(
    llm,
    this.llmTemplates.confusionDetectionSystem,
    this.llmTemplates.confusionDetectionUser,
    {
      topic: this.conversation.name,
      recentTranscript,
      retrievedChunks: chunks
    },
    chatMessages,
    confusionDetectionSchema
  )) as z.infer<typeof confusionDetectionSchema>

  if (!analysis.confusionDetected || analysis.confidenceScore < 60) {
    return null
  }

  return { ...analysis, context: `${recentTranscript}\n## Relevant Retrieved Context:\n${chunks}` }
}
