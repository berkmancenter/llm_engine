import logger from '../../config/logger.js'

/**
 * System instructions for the event assistant when tools (e.g. web_search) are enabled.
 * Exported as a constant so unit tests can lock the decision rule without calling an LLM.
 */
export const EVENT_ASSISTANT_TOOL_USAGE_RULES = `**Tools (web search):**
You have access to \`web_search\` for the public web.

**Default — search first when not certain:** If you cannot **state with certainty** that **every substantive factual claim** in your answer is **directly supported** by the **Context** (recent transcript + retrieved chunks) and the **conversation history** you were given—**not** from training-time memory, knowledge after your cutoff, or guesswork—**you MUST call \`web_search\` at least once before replying**. When you are **uncertain**, **prefer running \`web_search\` over answering without it**; a redundant search is acceptable; **confident guessing or filling gaps from memory is not**.

**Call \`web_search\` when** (non-exhaustive): facts that may have changed after your training cutoff or need "latest" confirmation; statistics, dates, regulations, product or version facts; verifiable claims about the **wider world** the discussion depends on; **incomplete** lists, rosters, or details **mentioned** in the event when the user asks for more than the Context literally contains; anything you would otherwise **infer** without a cited source in Context.

**Do NOT call \`web_search\`** only when you will answer **solely** by summarizing, explaining, or closely paraphrasing what is **explicitly or unambiguously** already in Context + chat, with **no** material reliance on unchecked external facts.

**IMPORTANT — use tools instead of suggesting sources:** Do NOT tell the user to "check" or "look at" external sites or reports without having called \`web_search\` yourself in this turn—run the search and synthesize what you find.

**If you use \`web_search\`:** Keep queries tightly scoped to the missing or uncertain facts. If results are empty or useless, say so briefly, then answer from Context and clearly-labeled general knowledge.`

/** Prepended to the user message on the Event Assistant tool path (see eventQuestionHandler). */
export const EVENT_ASSISTANT_TOOL_USER_MANDATE = `**Tool policy (mandatory):** Unless every substantive factual claim in your reply will be **directly and fully** supported by the Context and recent conversation in this thread—not from training-time memory alone—you **must** call \`web_search\` at least once before answering. If you are **uncertain**, **search first**; prefer a redundant web search over guessing.

`

const SUGGEST_RESOURCES_PATTERN =
  /When information isn't in the context:\n- Provide what you know from general knowledge\.\n- Suggest specific resources or places to find more information \(e\.g\., Bureau of Labor Statistics, industry reports, relevant organizations\)\./

const TOOLS_AWARE_REPLACEMENT = `When information isn't in the context:
- Use your available tools (e.g. web_search) to find the answer before responding.
- If tools return no results, provide what you know from general knowledge.`

const POINT_TOWARD_PATTERN =
  /Always aim to be helpful - provide the information you can and point toward additional resources\./

const POINT_TOWARD_REPLACEMENT =
  'Always aim to be helpful - use your tools to find information the event materials lack, then provide a substantive response.'

export interface EventAssistantToolSystemPromptBuild {
  systemPrompt: string
  replacements: { suggestResources: boolean; pointToward: boolean }
}

export function buildEventAssistantToolSystemPrompt(
  systemTemplate: string,
  topic: string,
  contextString: string
): EventAssistantToolSystemPromptBuild {
  let toolAwareTemplate = systemTemplate.replace(SUGGEST_RESOURCES_PATTERN, TOOLS_AWARE_REPLACEMENT)
  const didReplaceSuggest = toolAwareTemplate !== systemTemplate

  const beforePointToward = toolAwareTemplate
  toolAwareTemplate = toolAwareTemplate.replace(POINT_TOWARD_PATTERN, POINT_TOWARD_REPLACEMENT)
  const didReplacePointToward = toolAwareTemplate !== beforePointToward

  logger.debug(
    `Tool prompt: suggest-resources replacement ${didReplaceSuggest ? 'applied' : 'NOT matched'}, ` +
      `point-toward replacement ${didReplacePointToward ? 'applied' : 'NOT matched'}`
  )

  const systemPrompt = `${toolAwareTemplate}

${EVENT_ASSISTANT_TOOL_USAGE_RULES}

## Event topic:
${topic}

## Context:
${contextString}`

  return {
    systemPrompt,
    replacements: { suggestResources: didReplaceSuggest, pointToward: didReplacePointToward }
  }
}
