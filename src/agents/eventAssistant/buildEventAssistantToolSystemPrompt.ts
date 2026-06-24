/**
 * System instructions for the event assistant when tools (e.g. web_search) are enabled.
 * Exported as a constant so unit tests can lock the decision rule without calling an LLM.
 */
export const EVENT_ASSISTANT_TOOL_USAGE_RULES = `**Tools (web search):**
You have access to \`web_search\` for the public web.

**Default — search first when not certain:** If you cannot **state with certainty** that **every substantive factual claim** in your answer is **directly supported** by the **Context** (recent transcript + retrieved chunks) and the **conversation history** you were given—**not** from training-time memory, knowledge after your cutoff, or guesswork—**you MUST call \`web_search\` at least once before replying**. When you are **uncertain**, **prefer running \`web_search\` over answering without it**; a redundant search is acceptable; **confident guessing or filling gaps from memory is not**.

**Call \`web_search\` when** (non-exhaustive): facts that may have changed after your training cutoff or need "latest" confirmation; statistics, dates, regulations, product or version facts; verifiable claims about the **wider world** the discussion depends on; **incomplete** lists, rosters, or details **mentioned** in the event when the user asks for more than the Context literally contains; anything you would otherwise **infer** without a cited source in Context.

**Do NOT call \`web_search\`** only when you will answer **solely** by summarizing, explaining, or closely paraphrasing what is **explicitly or unambiguously** already in Context + chat, with **no** material reliance on unchecked external facts. **Background Reading chunks in the Context are authoritative sources — treat them the same as transcript context; do not search for information already covered there.**

**IMPORTANT — use tools instead of suggesting sources:** Do NOT tell the user to "check" or "look at" external sites or reports without having called \`web_search\` yourself in this turn—run the search and synthesize what you find.

**If you use \`web_search\`:** Keep queries tightly scoped to the missing or uncertain facts. If results are empty or useless, say so briefly, then answer from Context and clearly-labeled general knowledge.

**Citing web search results (mandatory):** When your response uses information from \`web_search\` results, you MUST attribute it — include the source title and URL inline (e.g. "According to [Title](URL), ...") or as a numbered reference at the end. Never state a fact drawn from search results without citing its source.

**Never narrate your tool decisions in your response.** Do not explain why you did or did not search, or comment on what the context contains. Just answer the question.`

/** Prepended to the user message on the Event Assistant tool path (see eventQuestionHandler). */
export const EVENT_ASSISTANT_TOOL_USER_MANDATE = `**Tool policy (mandatory):** Unless every substantive factual claim in your reply will be **directly and fully** supported by the Context and recent conversation in this thread—not from training-time memory alone—you **must** call \`web_search\` at least once before answering. If you are **uncertain**, **search first**; prefer a redundant web search over guessing. Background Reading in the Context counts as a fully supported source — do not search for what it already covers. Do not narrate your tool decisions in your reply.

`

/**
 * System instructions for the event assistant when the series-history (event_history) tools are
 * enabled. Tells the model it can reach the transcripts of *other past events* in the same series
 * and which tool does what. Exported as a builder so unit tests can lock the wording without an LLM.
 */
export function buildSeriesHistoryRules(seriesName: string, today: string): string {
  return `**Event series history tools:**
This event is part of the "${seriesName}" series. You can search the transcripts of **other past events in this series** to answer questions that reference earlier sessions, recurring speakers, or topics covered before.

Today's date is ${today}.

- \`search_topic_transcripts\`: semantic search across ALL past events' transcripts at once; each result chunk is prefixed with \`[Past Event: name]\`. **Start here for any question about what past sessions covered.** Results labeled \`[Past Event: ...]\` are NEVER from the current session — always from a prior one, even if the name matches the current event.
- \`get_event_list\`: list past events by name and date, sorted most-recent-first. Use this when you need to identify a specific event by name/date, for ordinal references ("2 sessions ago"), or for calendar references ("last week").
- \`search_conversation_transcript\`: deep search within one specific past event's transcript, after identifying it via \`get_event_list\`.

**Workflow for "what was the previous session about?" or similar:**
Call \`search_topic_transcripts\` directly. Use the user's question as your query — do NOT use generic phrases like "main topics discussed". Do NOT call \`get_event_list\` first for content questions — it only lists events, it does not retrieve what was discussed.

**Workflow for ordinal references ("2 sessions ago", "the third-to-last event"):**
Call \`get_event_list\` first. The list is sorted most-recent-first, so the first result is 1 session ago, the second result is 2 sessions ago, etc. Then search that event's transcript.

**Workflow for calendar references ("last week", "the session in March", "last month"):**
Use today's date (${today}) to compute an ISO date range, then call \`get_event_list\` with the appropriate \`since\`/\`until\` params to identify the event(s). Then search their transcripts.

**Important:** These tools already exclude the current event — every result is from a prior session. You do not need to pass a \`topicId\`. The current event's transcript is in your Context below; use these tools only for past events.

**Same-name events:** Past events may share the same name as the current session — they are still distinct prior sessions, identifiable by their ID and date in \`get_event_list\` results.

These transcripts are private to this series and are **not** on the public web — \`web_search\` cannot find them. Use these event-history tools for anything about past sessions, and reserve \`web_search\` for facts about the wider world.`
}

export interface EventAssistantToolPromptOptions {
  /** Whether web_search is among the active tools — gates the web-search-specific usage rules. */
  hasWebSearch?: boolean
  /** When present, the assistant has series-history tools scoped to this series. */
  series?: { name: string }
  /** ISO date string for today (e.g. "2026-06-22") — lets the LLM resolve calendar references like "last week". */
  today?: string
}

/**
 * Appended to the web_search user mandate when the series-history tools are ALSO active. The web
 * mandate is absolute ("you MUST call web_search"); without this carve-out it crowds out the series
 * tools for prior-event questions, sending the model to the public web for content that lives only in
 * the private series transcripts. Scoped to the both-tools case so web search is untouched otherwise.
 */
export const EVENT_ASSISTANT_SERIES_HISTORY_USER_CARVEOUT = `**Series-history exception:** Questions about prior events in this series — earlier sessions, past speakers, or what was discussed before — are answered from the event-history tools, NOT \`web_search\` (that content is private to this series and not on the public web). Use the event-history tools for those; reserve \`web_search\` for facts about the wider world.

`

export function buildEventAssistantToolSystemPrompt(
  systemTemplate: string,
  topic: string,
  contextString: string,
  options: EventAssistantToolPromptOptions = {}
) {
  const { hasWebSearch = true, series, today = new Date().toISOString().slice(0, 10) } = options
  const ruleBlocks = [hasWebSearch ? EVENT_ASSISTANT_TOOL_USAGE_RULES : '', series ? buildSeriesHistoryRules(series.name, today) : '']
    .filter(Boolean)
    .join('\n\n')

  return `${systemTemplate}${ruleBlocks ? `\n\n${ruleBlocks}` : ''}

## Event topic:
${topic}

## Context:
${contextString}`
}
