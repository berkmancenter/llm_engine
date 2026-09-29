#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Experiment 3 (live, costs real inference money — see k6/CLAUDE.md's paid-run norm):
 * validates the sentinel-split cache_control mechanism proposed in the issue #264
 * write-up against the real Bedrock proxy, using the REAL production prompt-building
 * functions (not synthetic filler) so the token counts are honest.
 *
 * Question 1: does the actual stable prefix from buildEventAssistantToolSystemPrompt
 *   (real templates + composeSystemPrompt, same as experiment 1) clear Opus 4.6's
 *   4096-token minimum cacheable prefix, using the real Anthropic tokenizer (not the
 *   chars/4 approximation experiment 1 used)?
 * Question 2: does a `system` array of TWO blocks — [stable w/ cache_control, volatile
 *   w/ no cache_control] — actually cache-write on call 1 and cache-read on call 2 when
 *   only the volatile block changes? This is the mechanism proposed for claudeHandler.ts.
 * Question 3: same question on a model with a lower minimum (sonnet-4.6, 1024 tokens) —
 *   is the real stable prefix big enough there even if it misses Opus 4.6's bar?
 *
 * 4 calls total, max_tokens=16 each. At Opus 4.6 rates ($5/1M in, $25/1M out, 1.25x
 * write premium) on a ~1.5-2K token prefix this is on the order of a few cents total —
 * nowhere near the $20 budget approved for this run.
 *
 * Usage: node --loader ts-node/esm scripts/experiments/liveCacheBreakpointTest.ts
 */
import config from '../../src/config/config.js'
import { buildBedrockInvokeUrl } from '../../src/agents/helpers/bedrockGateway.js'
import { buildLLMTemplates } from '../../src/agents/eventAssistant/eventQuestionHandler.js'
import { buildEventAssistantToolSystemPrompt } from '../../src/agents/eventAssistant/buildEventAssistantToolSystemPrompt.js'
import { composeSystemPrompt } from '../../src/agents/helpers/promptComposer.js'

interface Usage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

function sharedPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

async function callOnce(
  label: string,
  modelId: string,
  systemBlocks: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]
): Promise<Usage> {
  const url = buildBedrockInvokeUrl(config.llms.bedrock.baseUrl, modelId)
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 16,
    system: systemBlocks,
    messages: [{ role: 'user', content: 'Reply with the single word: ack' }]
  })

  const start = Date.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.llms.bedrock.key },
    body
  })
  const elapsedMs = Date.now() - start
  const text = await response.text()
  if (!response.ok) {
    console.error(`[${label}] HTTP ${response.status} in ${elapsedMs}ms:\n${text}`)
    throw new Error(`${label} failed: ${response.status}`)
  }
  const json = JSON.parse(text)
  const usage: Usage = json.usage ?? {}
  console.log(`[${label}] ${elapsedMs}ms`, usage)
  return usage
}

async function buildRealStableAndVolatile() {
  const templates = buildLLMTemplates('EventBot', ['web_search'], undefined)
  const systemTemplate = composeSystemPrompt(templates.semanticSystem, {
    channelType: 'groupChat',
    personalityName: null
  })
  const topic = 'Prompt Caching in Practice: A Lightning Talk'

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

  const prefixLen = sharedPrefixLength(promptA, promptB)
  const stable = promptA.slice(0, prefixLen)
  const volatileA = promptA.slice(prefixLen)
  const volatileB = promptB.slice(prefixLen)
  return { stable, volatileA, volatileB }
}

async function testModel(modelId: string, minCacheableTokens: number, stable: string, volatileA: string, volatileB: string) {
  console.log(`\n=== ${modelId} (published minimum cacheable prefix: ${minCacheableTokens} tokens) ===`)
  console.log(`stable block: ${stable.length} chars (chars/4 estimate: ~${Math.round(stable.length / 4)} tokens)`)

  const call1 = await callOnce(`${modelId} call 1 (expect WRITE)`, modelId, [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: volatileA }
  ])
  const call2 = await callOnce(`${modelId} call 2, same volatile block (expect READ)`, modelId, [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: volatileA }
  ])
  const call3 = await callOnce(`${modelId} call 3, DIFFERENT volatile block (expect READ on stable prefix still)`, modelId, [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: volatileB }
  ])

  const realStableTokens = call1.input_tokens ?? 0 // input_tokens on the write call ~= tokens of everything sent, since nothing was cached yet
  console.log(`Real tokenizer count for full call 1 payload (system+user): ${realStableTokens} tokens`)

  const wrote = (call1.cache_creation_input_tokens ?? 0) > 0
  const read2 = (call2.cache_read_input_tokens ?? 0) > 0
  const read3 = (call3.cache_read_input_tokens ?? 0) > 0
  console.log(wrote ? '✓ cache write on call 1' : "✗ NO cache write on call 1 (prefix likely under this model's minimum)")
  console.log(read2 ? '✓ cache read on call 2 (identical volatile block)' : '✗ NO cache read on call 2')
  console.log(
    read3
      ? '✓ cache read on call 3 (DIFFERENT volatile block) — confirms the 2-block split isolates the stable prefix'
      : '✗ NO cache read on call 3 — the volatile-block change unexpectedly invalidated the stable block too'
  )
  return { wrote, read2, read3 }
}

async function main() {
  if (!config.llms.bedrock.baseUrl || !config.llms.bedrock.key) {
    console.error('BEDROCK_BASE_URL and BEDROCK_API_KEY must be set to run this script.')
    process.exit(1)
  }

  const { stable, volatileA, volatileB } = await buildRealStableAndVolatile()

  // Opus 4.6: dominant production model, highest published minimum (4096).
  // Sonnet 4.6: much lower minimum (1024) — cheap way to see if the same stable prefix
  // clears the bar on a model we could migrate cost-sensitive agents to.
  await testModel('us.anthropic.claude-opus-4-6-v1', 4096, stable, volatileA, volatileB)
  await testModel('us.anthropic.claude-sonnet-4-6', 1024, stable, volatileA, volatileB)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
