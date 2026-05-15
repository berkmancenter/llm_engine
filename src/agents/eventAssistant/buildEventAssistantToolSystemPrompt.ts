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

export function buildEventAssistantToolSystemPrompt(systemTemplate: string, topic: string, contextString: string) {
  return `${systemTemplate}

${EVENT_ASSISTANT_TOOL_USAGE_RULES}

## Event topic:
${topic}

## Context:
${contextString}`
}
