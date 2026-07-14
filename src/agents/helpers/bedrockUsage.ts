import type { ChatResult } from '@langchain/core/outputs'
import type { AIMessage } from '@langchain/core/messages'

/* The community BedrockChat's non-streaming Anthropic path parses the response's
   usage block into generationInfo but never sets the standard usage_metadata field
   on the AIMessage — and LangSmith's token/cost pipeline reads ONLY usage_metadata
   (verified empirically 2026-07-13: probe runs with usage solely in
   response_metadata ingest as 0 tokens). These helpers close that gap without
   forking the vendored class. */

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
}

/**
 * Copies the Anthropic usage block from each generation's generationInfo onto the
 * message's usage_metadata when missing, so LangSmith extracts token counts. An
 * already-set usage_metadata is trusted and left alone.
 */
export function attachUsageMetadata(result: ChatResult): ChatResult {
  for (const generation of result.generations ?? []) {
    const usage = (generation.generationInfo as { usage?: AnthropicUsage } | undefined)?.usage
    const message = generation.message as AIMessage | undefined
    if (!usage || !message || message.usage_metadata) continue
    const inputTokens = usage.input_tokens ?? 0
    const outputTokens = usage.output_tokens ?? 0
    message.usage_metadata = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    }
  }
  return result
}

/**
 * LangSmith prices runs by matching ls_model_name against its pricing table, which
 * knows bare Anthropic names (claude-haiku-4-5-20251001) but not Bedrock
 * inference-profile ids (us.anthropic.claude-haiku-4-5-20251001-v1:0) — verified
 * empirically: identical probe runs were priced with the bare name and left null
 * with the Bedrock id. Strips the region/vendor prefix and version suffix;
 * non-Anthropic ids pass through unchanged.
 */
export function normalizeBedrockModelName(modelId: string): string {
  // Plain string ops instead of regex: eslint's security/detect-unsafe-regex kept
  // flagging even simplified single-quantifier patterns here as ReDoS-prone.
  const parts = modelId.split('.')
  const anthropicIndex = parts.indexOf('anthropic')
  if (anthropicIndex === -1 || anthropicIndex === parts.length - 1) return modelId

  const name = parts.slice(anthropicIndex + 1).join('.')
  const versionIndex = name.lastIndexOf('-v')
  const firstVersionDigit = name[versionIndex + 2]
  if (versionIndex === -1 || !firstVersionDigit || Number.isNaN(Number(firstVersionDigit))) return name
  return name.slice(0, versionIndex)
}
