import type { StructuredToolInterface } from '@langchain/core/tools'
import type { ConversationGoal } from '../../types/index.types.js'
import { getTools, getToolPromptGuidance } from './registry.js'

export interface ResolveToolsOptions {
  /** Agent-type-level default tool names, computed by the caller (e.g. from Tavily config). */
  defaultTools?: string[]
  /** The agent instance's explicitly configured tools — today's `agentConfig.tools`. */
  configuredTools?: string[]
  /** Goals eligible for this turn; each goal's `tools` entries are merged in. */
  goals?: ConversationGoal[]
  /** One-off, caller-computed runtime-conditional tool names (e.g. `series ? ['event_history'] : []`). */
  extraTools?: string[]
  /** Passed through to tool factories verbatim, alongside the derived `toolConfig` map. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolContext?: Record<string, any>
}

export interface ResolvedTools {
  tools: StructuredToolInterface[]
  toolNames: string[]
  promptGuidance: string
}

/**
 * Merges an agent's tool sources into a final tool list, instantiated tools, and combined
 * prompt guidance. Merge order is default -> configured -> goal-derived -> extra; the first
 * goal (in `goals` order) to reference a given tool wins on conflicting `config`. Every goal
 * that references a tool contributes its `usageNotes` (if any), concatenated in goal order.
 *
 * NOTE: a tool's registered promptGuidance (see registry.ts's registerTool meta param) is
 * written for whatever agent output-shape first registered it — e.g. web_search's guidance
 * assumes a free-text Q&A reply. If a goal grants a tool to an agent with a different output
 * shape (e.g. a structured decision or a private DM), check that the registered guidance
 * still fits; use a goal's tools[].usageNotes to add or override context-specific instructions
 * rather than relying on the static guidance alone.
 */
export function resolveTools(options: ResolveToolsOptions): ResolvedTools {
  const { defaultTools = [], configuredTools = [], goals = [], extraTools = [], toolContext } = options

  const toolConfig: Record<string, Record<string, unknown>> = {}
  const usageNotesByTool: Record<string, string[]> = {}
  const goalToolNames: string[] = []

  for (const goal of goals) {
    for (const ref of goal.tools ?? []) {
      goalToolNames.push(ref.name)
      if (ref.config && !(ref.name in toolConfig)) {
        toolConfig[ref.name] = ref.config
      }
      if (ref.usageNotes) {
        usageNotesByTool[ref.name] = [...(usageNotesByTool[ref.name] ?? []), ref.usageNotes]
      }
    }
  }

  const toolNames = Array.from(new Set([...defaultTools, ...configuredTools, ...goalToolNames, ...extraTools]))

  const tools = toolNames.length > 0 ? getTools(toolNames, { ...toolContext, toolConfig }) : []

  const promptGuidance = toolNames
    .map((name) => {
      const staticGuidance = getToolPromptGuidance(name)
      const notes = usageNotesByTool[name]?.join('\n') ?? ''
      return [staticGuidance, notes].filter(Boolean).join('\n\n')
    })
    .filter(Boolean)
    .join('\n\n')

  return { tools, toolNames, promptGuidance }
}
