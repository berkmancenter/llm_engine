import { z } from 'zod'

/* Shared between lifecycle.ts's stop-time extraction and openThreads.ts's live group-chat
   fallback — kept in its own leaf module (no service-layer imports) so the tool can use the
   same criteria without pulling in lifecycle.ts's whole import graph, which circles back
   through agentService to the agent-type registry and breaks module initialization order. */
export const OPEN_THREADS_EXTRACTION_PROMPT = `
  Identify up to 4 questions or ideas that were genuinely discussed during this conversation and could benefit from further discussion later — not everything that was covered, only things worth revisiting.

  - Each item should be a single, well-formed question or statement that stands alone without needing this conversation's own context (e.g. "What's the actual budget ceiling for the vendor contract?", not "the budget thing from earlier").
  - Only include something that was actually raised and discussed, even briefly — never invent a topic that wasn't part of the conversation.
  - Skip anything that was fully resolved, decided, or answered during the conversation.
  - If nothing meets this bar, return an empty list — do not force a result.
  - The content is made up of a transcript (what speakers said) and participant chat messages. Messages labelled "AI Assistant" are from automated assistants — ignore them entirely.`

export const MAX_OPEN_THREADS = 4
// No .max() here: a schema mismatch fails the whole answer, so extra items are trimmed in code.
export const openThreadsSchema = z.object({
  openThreads: z.array(z.string())
})
