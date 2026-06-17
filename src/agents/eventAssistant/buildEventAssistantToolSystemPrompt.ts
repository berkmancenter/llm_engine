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
export function buildSeriesHistoryRules(seriesName: string): string {
  return `**Event series history tools:**
This event is part of the "${seriesName}" series. You can search the transcripts of **other past events in this series** to answer questions that reference earlier sessions, recurring speakers, or topics covered before — use them whenever a question touches on the series' history rather than only the current event.

- \`get_event_list\`: list the other events in this series by name and date
- \`search_topic_transcripts\`: semantic search across the other events' transcripts; each result is prefixed with the event name it came from
- \`search_conversation_transcript\`: deep search within a specific past event's transcript after identifying it via the tools above

Prefer \`search_topic_transcripts\` for broad questions; use \`search_conversation_transcript\` for specific quotes once you know which past event to drill into. You do not need to pass a \`topicId\` — these tools are already scoped to this series. These tools cover only *other* events — the current event's own transcript is already in your Context below. For questions answerable from the current event or general knowledge, respond without calling them.

These transcripts are private to this series and are **not** on the public web, so \`web_search\` cannot answer questions about earlier sessions, past speakers, or what was discussed before — use these event-history tools for anything about the series' past, and reserve \`web_search\` for facts about the wider world.`
}

export interface EventAssistantToolPromptOptions {
  /** Whether web_search is among the active tools — gates the web-search-specific usage rules. */
  hasWebSearch?: boolean
  /** When present, the assistant has series-history tools scoped to this series. */
  series?: { name: string }
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
  const { hasWebSearch = true, series } = options
  const ruleBlocks = [hasWebSearch ? EVENT_ASSISTANT_TOOL_USAGE_RULES : '', series ? buildSeriesHistoryRules(series.name) : '']
    .filter(Boolean)
    .join('\n\n')

  return `${systemTemplate}${ruleBlocks ? `\n\n${ruleBlocks}` : ''}

## Event topic:
${topic}

## Context:
${contextString}`
}
