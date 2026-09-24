#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Experiment 1 (issue #264, investigation steps 2-3): how much of the Event Assistant's
 * TOOL-PATH system prompt is a byte-identical prefix across consecutive turns of the same
 * conversation, under the *current* prompt structure?
 *
 * This is the biggest cost driver in the issue's cost breakdown (eventAssistant, 64% of
 * spend) and the only one where the system prompt itself (not just chat history) mixes
 * volatile content: buildEventAssistantToolSystemPrompt() appends the live
 * transcript/RAG "## Context:" block directly onto the system string, and that string is
 * rendered as a single SystemMessage before the messages array — i.e. before any chat
 * history. If anything volatile appears in that string ahead of "## Context:", the whole
 * prefix — including chat history that follows in `messages` — is unreachable by caching.
 *
 * No network/LLM calls. Pure string-building functions only:
 *   buildLLMTemplates, composeSystemPrompt, buildEventAssistantToolSystemPrompt
 *
 * Usage: node --loader ts-node/esm scripts/experiments/eventAssistantSystemPromptStability.ts
 */
import { buildLLMTemplates } from '../../src/agents/eventAssistant/eventQuestionHandler.js'
import { buildEventAssistantToolSystemPrompt } from '../../src/agents/eventAssistant/buildEventAssistantToolSystemPrompt.js'
import { composeSystemPrompt } from '../../src/agents/helpers/promptComposer.js'

// Rough Claude tokenizer approximation (chars/4) — good enough to compare against the
// per-model minimum-cacheable-prefix table in the issue; not a substitute for real usage
// numbers from a live call.
const approxTokens = (s: string) => Math.round(s.length / 4)

function sharedPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

function report(label: string, stable: string, volatileA: string, volatileB: string) {
  const callA = stable + volatileA
  const callB = stable + volatileB
  const prefixLen = sharedPrefixLength(callA, callB)
  const pct = ((prefixLen / callA.length) * 100).toFixed(1)
  console.log(`\n--- ${label} ---`)
  console.log(`call 1 length: ${callA.length} chars (~${approxTokens(callA)} tokens)`)
  console.log(`call 2 length: ${callB.length} chars (~${approxTokens(callB)} tokens)`)
  console.log(
    `shared byte prefix: ${prefixLen} chars (~${approxTokens(callA.slice(0, prefixLen))} tokens, ${pct}% of call 1)`
  )
  if (prefixLen < callA.length) {
    console.log(`divergence starts at: ${JSON.stringify(callA.slice(Math.max(0, prefixLen - 20), prefixLen + 40))}`)
  }
  return prefixLen
}

// Opus 4.6 has the highest minimum cacheable prefix of any current model (per the issue).
const OPUS_4_6_MIN_CACHEABLE_TOKENS = 4096

async function main() {
  const templates = buildLLMTemplates('EventBot', ['web_search'], undefined)

  const systemTemplate = composeSystemPrompt(templates.semanticSystem, {
    channelType: 'groupChat',
    personalityName: null
  })

  const topic = 'Prompt Caching in Practice: A Lightning Talk'

  // --- Scenario A: same classification outcome both turns, only the live transcript / RAG
  // context differs (the expected steady-state case for a multi-turn Q&A conversation). ---
  const contextA = [
    '## Event Participants\n- Alice Chen (moderator)\n- Bob Okafor (speaker)',
    '## Recent Transcript:\n[14:02:01] Bob: So the key idea is prefix caching...\n[14:02:14] Alice: Can you say more about TTL?',
    '## Relevant Retrieved Context:\nChunk 12: "...ephemeral cache entries expire after 5 minutes of inactivity..."'
  ].join('\n\n')
  const contextB = [
    '## Event Participants\n- Alice Chen (moderator)\n- Bob Okafor (speaker)',
    '## Recent Transcript:\n[14:02:01] Bob: So the key idea is prefix caching...\n[14:02:14] Alice: Can you say more about TTL?\n[14:02:30] Bob: Right, so a 5 minute ephemeral window...',
    '## Relevant Retrieved Context:\nChunk 12: "...ephemeral cache entries expire after 5 minutes of inactivity..."\nChunk 47: "...break-even is 2 requests at the 5-minute TTL..."'
  ].join('\n\n')

  const promptA = await buildEventAssistantToolSystemPrompt(systemTemplate, topic, contextA, {
    hasWebSearch: true,
    today: '2026-09-21'
  })
  const promptB = await buildEventAssistantToolSystemPrompt(systemTemplate, topic, contextB, {
    hasWebSearch: true,
    today: '2026-09-21'
  })

  const stablePrefixLen = report('Scenario A: same classification, transcript/RAG context grows', '', promptA, promptB)
  const stableTokens = approxTokens(promptA.slice(0, stablePrefixLen))
  console.log(
    stableTokens >= OPUS_4_6_MIN_CACHEABLE_TOKENS
      ? `✓ stable prefix (~${stableTokens} tok) clears Opus 4.6's ${OPUS_4_6_MIN_CACHEABLE_TOKENS}-token minimum`
      : `✗ stable prefix (~${stableTokens} tok) is UNDER Opus 4.6's ${OPUS_4_6_MIN_CACHEABLE_TOKENS}-token minimum — ` +
          `a cache_control marker here would write and never be read on this model`
  )

  // --- Scenario B: classification flips between calls (semantic -> timeWindow), which
  // swaps the *base* template text, not just the appended context. ---
  const timeWindowTemplate = composeSystemPrompt(templates.timeWindowSystem, {
    channelType: 'groupChat',
    personalityName: null
  })
  const promptC = await buildEventAssistantToolSystemPrompt(timeWindowTemplate, topic, contextA, {
    hasWebSearch: true,
    today: '2026-09-21'
  })
  report('Scenario B: classification flips semantic -> timeWindow between turns', '', promptA, promptC)
  console.log(
    'Any classification change invalidates the ENTIRE prefix (base template text differs from byte 0),\n' +
      'independent of anything downstream. This is a silent invalidator distinct from the context block.'
  )

  // --- Scenario C: "today" rolls over (series-history rules embed the date). ---
  const promptD = await buildEventAssistantToolSystemPrompt(systemTemplate, topic, contextA, {
    hasWebSearch: true,
    series: { name: 'Weekly Seminar Series' },
    today: '2026-09-21'
  })
  const promptE = await buildEventAssistantToolSystemPrompt(systemTemplate, topic, contextA, {
    hasWebSearch: true,
    series: { name: 'Weekly Seminar Series' },
    today: '2026-09-22'
  })
  report('Scenario C: series-history active, date rolls over mid-conversation', '', promptD, promptE)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
