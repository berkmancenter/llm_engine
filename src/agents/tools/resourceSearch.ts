import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import rag from '../helpers/rag.js'
import { conversationCollectionName } from '../helpers/backgroundCollection.js'
import Conversation from '../../models/conversation.model.js'
import logger from '../../config/logger.js'

export interface ResourceSearchToolOptions {
  conversationId: string
}

function formatResourceChunk(doc: { metadata: { citation?: string }; pageContent: string }, idx: number): string {
  return `Source ID: ${idx}\nTitle: ${doc.metadata.citation}\nSnippet: ${doc.pageContent}`
}

/**
 * `search_resources`: semantic search over this conversation's own uploaded background
 * reading/resources — the same `background-<conversationId>` Chroma collection
 * eventQuestionHandler.ts reads from for eventAssistant/voiceAssistant, via the same
 * rag.getContextChunksForQuestion helper. Indexing already happens generically for any
 * conversation's `resources` field (see resourceService.updateResources/savePdf); this just
 * adds the retrieval side for communityAssistant, which does all its context-retrieval through
 * tools rather than a bespoke inline RAG call.
 *
 * Complements getBackgroundContextForQuestion below: that function auto-injects passages
 * relevant to the raw user question before generation, so this tool is really for deliberate
 * follow-up — a differently-worded or narrower query once the model knows there's something
 * worth digging into.
 */
export default function createResourceSearchTools(options: ResourceSearchToolOptions) {
  const { conversationId } = options

  const searchResourcesTool = tool(
    async ({ query }) => {
      try {
        const { chunks } = await rag.getContextChunksForQuestion(
          conversationCollectionName(conversationId),
          query,
          formatResourceChunk
        )
        return chunks || 'No matching background material found.'
      } catch (err) {
        // The collection may not exist yet for a conversation with no resources uploaded —
        // degrade gracefully rather than failing the whole agent turn over it.
        logger.warn(`resourceSearch: failed to query background collection for conversation ${conversationId}: ${err}`)
        return 'No matching background material found.'
      }
    },
    {
      name: 'search_resources',
      description:
        "Semantic search over this room's uploaded background reading/resources. Passages relevant to the " +
        "user's raw question are already surfaced in context automatically when they clear a relevance bar — " +
        'use this tool yourself for deliberate follow-up: a reformulated or narrower query once you know ' +
        "there's relevant material, or a later question in the same thread.",
      schema: z.object({
        query: z.string().describe('The topic or question to search the uploaded background material for')
      })
    }
  )

  const tools: StructuredToolInterface[] = [searchResourcesTool]
  return tools
}

/* Lower is better (cosine distance — collections are created with hnsw:space 'cosine', see
   rag.ts). 0.5 was chosen empirically as a conservative "genuinely on-topic" cutoff with
   OpenAI's text-embedding-3 models; revisit if real traffic shows false negatives/positives. */
const RELEVANCE_SCORE_THRESHOLD = 0.5
const MAX_BACKGROUND_CHUNKS = 5

/**
 * Up-front, unconditional lookup keyed on the literal user question — mirrors
 * eventQuestionHandler.ts's always-on background RAG call, but with a relevance-score gate
 * eventQuestionHandler doesn't need (every question in an event conversation is reasonably
 * on-topic; communityAssistant fields far more unrelated chatter, so blind top-k inclusion
 * would pollute context on most turns). Returns '' when nothing clears the bar — including
 * when the conversation has no resources/collection yet — so callers can cheaply omit the
 * section rather than branching on a sentinel.
 */
export async function getBackgroundContextForQuestion(conversationId: string, question: string): Promise<string> {
  try {
    const { chunks } = await rag.getContextChunksForQuestion(
      conversationCollectionName(conversationId),
      question,
      formatResourceChunk,
      undefined,
      MAX_BACKGROUND_CHUNKS,
      undefined,
      undefined,
      RELEVANCE_SCORE_THRESHOLD
    )
    return chunks
  } catch (err) {
    logger.warn(`resourceSearch: failed to query background collection for conversation ${conversationId}: ${err}`)
    return ''
  }
}

const TOPIC_HINT_MAX_CHARS = 200

/**
 * One line of topic signal beyond the bare title: prefers the organizer-authored `description`
 * (short by convention), falling back to a truncated slice of the AI-generated `summary` (see
 * resourceService.summarizePdf) when no description was set. Title alone is often too oblique
 * for the model to match against how someone actually phrases a question.
 */
function topicHint(resource: { description?: string; summary?: string }): string {
  const text = resource.description || resource.summary
  if (!text) return ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > TOPIC_HINT_MAX_CHARS ? `${oneLine.slice(0, TOPIC_HINT_MAX_CHARS)}…` : oneLine
}

/**
 * Lists the room's resource titles/authors/years (plus a short topic hint, when available)
 * directly in the guidance text — mirrors buildEventHistoryToolsPrompt's "Available event
 * series" listing. Without this, the model has no way to judge whether a question is actually
 * in scope for search_resources: "skip it when unrelated" is meaningless if it can't see what's
 * in there in the first place.
 */
export async function buildResourceSearchToolsPrompt(context?: { activeConversationId?: unknown }): Promise<string | null> {
  const conversationId = typeof context?.activeConversationId === 'string' ? context.activeConversationId : undefined
  if (!conversationId) return null

  const conversation = await Conversation.findById(conversationId)
    .select('resources.title resources.authors resources.year resources.description resources.summary')
    .lean()
  const resources = conversation?.resources ?? []
  if (resources.length === 0) return null

  const list = resources
    .map((r) => {
      const byline = [r.authors?.join(', '), r.year].filter(Boolean).join(', ')
      const hint = topicHint(r)
      return `- "${r.title}"${byline ? ` (${byline})` : ''}${hint ? `: ${hint}` : ''}`
    })
    .join('\n')

  return `**Background reading:**
This room has uploaded background resources:
${list}

Passages relevant to the current question are already included above (under "Background Reading")
whenever they clear a relevance bar — you don't need to call a tool just to check. Call
\`search_resources\` yourself for deliberate follow-up: a reformulated or narrower query once you know
there's relevant material, or to dig further into a later question in the same thread.`
}
