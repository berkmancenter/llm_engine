import { buildEventHistoryToolsPrompt } from '../tools/eventHistory.js'
import { WEB_SEARCH_USAGE_GUIDANCE } from '../tools/webSearch.js'

/**
 * System instructions for the event assistant when tools (e.g. web_search) are enabled.
 * Re-exported under this name so existing tests locking the wording keep working; the
 * canonical text now lives with the tool it describes, in webSearch.ts.
 */
export const EVENT_ASSISTANT_TOOL_USAGE_RULES = WEB_SEARCH_USAGE_GUIDANCE

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

${buildEventHistoryToolsPrompt(true /* hasActiveConversation */)}

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
  const ruleBlocks = [
    hasWebSearch ? EVENT_ASSISTANT_TOOL_USAGE_RULES : '',
    series ? buildSeriesHistoryRules(series.name, today) : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  return `${systemTemplate}${ruleBlocks ? `\n\n${ruleBlocks}` : ''}

## Event topic:
${topic}

## Context:
${contextString}`
}
