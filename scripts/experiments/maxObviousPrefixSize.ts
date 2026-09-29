#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * How close does "the obvious" get us to Opus 4.6's 4096-token minimum? "Obvious" =
 * unconditionally including every REAL guidance block and tool this codebase already has
 * registered, instead of gating them behind hasWebSearch/series/conversation-specific
 * config. No new content written, no filler.
 *
 * Measures two separate contributions to the prefix (both render before the volatile
 * per-call content, both count toward the same cumulative minimum-prefix check):
 *   1. `system` text: composeSystemPrompt (real behaviorPolicy) + tool-usage-rules text +
 *      series-history rules + every registered tool's prompt-guidance section.
 *   2. `tools` schema: binding every registered tool (not just the ones a given
 *      conversation happens to have configured).
 *
 * Zero network calls: `tools` binding uses the same stubbed-fetch technique as
 * toolsPrefixSize.ts (captures the real BedrockChat-serialized body, nothing sent to the
 * wire). Uses the real Anthropic tokenizer count from earlier live tests as a chars/4
 * calibration check, not a live call itself.
 *
 * Usage: node --loader ts-node/esm scripts/experiments/maxObviousPrefixSize.ts
 */
import { SystemMessage } from '@langchain/core/messages'
import { createAgent } from 'langchain'
import { getBedrockChat } from '../../src/agents/helpers/getModelChat.js'
import { getTools, listRegisteredTools, buildToolsGuidance } from '../../src/agents/tools/registry.js'
import { buildLLMTemplates } from '../../src/agents/eventAssistant/eventQuestionHandler.js'
import { composeSystemPrompt } from '../../src/agents/helpers/promptComposer.js'
import {
  buildEventAssistantToolSystemPrompt,
  EVENT_ASSISTANT_TOOL_USAGE_RULES
} from '../../src/agents/eventAssistant/buildEventAssistantToolSystemPrompt.js'

const approxTokens = (s: string) => Math.round(s.length / 4)
// Calibration from the live tests so far: real Anthropic tokenizer / chars-estimate ratio
// observed on actual production-shaped text (1343 real tokens for a 6183-char block with
// this same composeSystemPrompt+behaviorPolicy shape earlier => ratio ~0.87).
const CALIBRATION_RATIO = 1343 / (6183 / 4)

const REAL_BEHAVIOR_POLICY = {
  globalPolicy: {
    tone: 'warmSupportive',
    verbosity: 'brief',
    formality: 'semiFormal',
    jargonLevel: 'medium',
    safetyPosture: 'strict'
  },
  channels: {
    dm: { qaBehavior: { answerScope: 'broaderSubjectArea', responseLength: 'short' } },
    groupChat: {
      proactivePolicy: { initiativeLevel: 'moderatelyProactive', minContributionMinutes: 2, socialSensitivity: 'medium' }
    }
  }
}

async function measureSystemText() {
  const templates = buildLLMTemplates('EventBot', ['web_search'], undefined)
  const baseSystem = composeSystemPrompt(templates.semanticSystem, {
    behaviorPolicy: REAL_BEHAVIOR_POLICY as never,
    channelType: 'groupChat',
    personalityName: null
  })
  console.log(`  composeSystemPrompt (base template + real behaviorPolicy): ${approxTokens(baseSystem)} tok`)

  // event_history's guidance builder queries Mongo directly when given topicIds (even an
  // empty array) — skip it here since this measurement has no DB connection; its
  // contribution is separately covered by buildSeriesHistoryRules elsewhere and only
  // applies to series-enabled events anyway, not every conversation.
  const allNames = listRegisteredTools().filter((n) => n !== 'event_history')
  console.log(`  registered tool names (excl. event_history, needs DB): [${allNames.join(', ')}]`)
  const guidance = await buildToolsGuidance(allNames, { activeConversationId: 'fake' })
  console.log(`  buildToolsGuidance(ALL registered tools): ${approxTokens(guidance)} tok`)

  const topic = 'BKC Launch Event: Building the Future of Digital Governance'
  const full = await buildEventAssistantToolSystemPrompt(baseSystem, topic, '', {
    hasWebSearch: true,
    series: { name: 'BKC Launch Series' },
    today: '2026-09-21'
  })
  // buildEventAssistantToolSystemPrompt already folds in EVENT_ASSISTANT_TOOL_USAGE_RULES +
  // series rules + topic; buildToolsGuidance covers the OTHER registered tools it doesn't.
  const combined = `${full}\n\n${guidance}`
  console.log(`  EVENT_ASSISTANT_TOOL_USAGE_RULES alone: ${approxTokens(EVENT_ASSISTANT_TOOL_USAGE_RULES)} tok`)
  console.log(`  full combined system text: ${combined.length} chars, ~${approxTokens(combined)} tok (chars/4)`)
  return combined
}

async function measureToolsSchema() {
  let capturedBody: string | undefined
  const originalFetch = globalThis.fetch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (_url: any, init: any) => {
    capturedBody = init?.body as string
    return new Response(
      JSON.stringify({
        id: 'x',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ack' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  try {
    const llm = await getBedrockChat('us.anthropic.claude-opus-4-6-v1', {})
    // event_history needs a topics context to bind any tools at all (see registry.ts) — give
    // it one fake topic so it's included in this "bind everything" measurement.
    const tools = await getTools(listRegisteredTools(), {
      topics: [{ id: 'fake', name: 'Fake Topic' }],
      activeConversationId: 'fake'
    })
    const agent = createAgent({ model: llm, tools, systemPrompt: new SystemMessage('placeholder') })
    try {
      await agent.invoke({ messages: [{ role: 'user', content: 'hi' }] }, { recursionLimit: 3 })
    } catch (err) {
      if (!capturedBody) throw err
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  const parsed = JSON.parse(capturedBody!)
  const toolNames = (parsed.tools ?? []).map((t: { name: string }) => t.name)
  const toolsJson = JSON.stringify(parsed.tools ?? [])
  console.log(`  tools actually bound: [${toolNames.join(', ')}]`)
  console.log(`  tools schema size: ${toolsJson.length} chars, ~${approxTokens(toolsJson)} tok (chars/4)`)
  return toolsJson.length
}

async function main() {
  console.log('=== system text (guidance/instructions) ===')
  const systemText = await measureSystemText()

  console.log('\n=== tools schema (binding every registered tool) ===')
  const toolsChars = await measureToolsSchema()

  const totalTokChars4 = approxTokens(systemText) + approxTokens(toolsChars > 0 ? 'x'.repeat(toolsChars) : '')
  const totalCalibrated = Math.round(totalTokChars4 * CALIBRATION_RATIO)

  console.log('\n=== Summary ===')
  console.log(`Total (system + tools), chars/4 estimate: ~${totalTokChars4} tok`)
  console.log(`Total, calibrated to real tokenizer ratio (${CALIBRATION_RATIO.toFixed(3)}): ~${totalCalibrated} tok`)
  console.log(`Opus 4.6 minimum: 4096 tok`)
  const gap = 4096 - totalCalibrated
  console.log(gap > 0 ? `Still short by ~${gap} tok after doing "the obvious".` : `Clears the minimum by ~${-gap} tok.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
