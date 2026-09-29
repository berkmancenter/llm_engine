#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Live validation (issue #264) of the "cross-participant cache sharing" claim: for a
 * fan-out conversation like BKC Launch event (378 DM channels, one per participant, all
 * sharing the same event-level system prompt), does ONE participant's call warm a cache
 * entry that a DIFFERENT participant's call — with no shared identifier, just the same
 * stable prefix bytes — can read? The Anthropic API has no session/user concept, so this
 * should be true by construction, but "should be" isn't "measured".
 *
 * Two sub-tests:
 *   1. Sonnet 4.6, using the REAL current stable prefix (~1850 tokens: real behaviorPolicy
 *      from a real conversation + web_search tool) — already known to clear its 1024-token
 *      minimum. Two different simulated participants' DM turns.
 *   2. Opus 4.6, using a GROWN stable prefix (adds real, production tool-guidance text for
 *      every registered tool, not filler) to test whether that closes the gap to Opus 4.6's
 *      4096-token minimum, and whether cross-participant sharing still holds there.
 *
 * Estimated cost: 4 calls, ~2-4.5K tokens each, max_tokens=16. Comfortably under $0.10.
 *
 * Usage: node --loader ts-node/esm scripts/experiments/crossParticipantCacheTest.ts
 */
import config from '../../src/config/config.js'
import { buildBedrockInvokeUrl } from '../../src/agents/helpers/bedrockGateway.js'
import { buildLLMTemplates } from '../../src/agents/eventAssistant/eventQuestionHandler.js'
import { composeSystemPrompt } from '../../src/agents/helpers/promptComposer.js'
import { buildToolsGuidance } from '../../src/agents/tools/registry.js'
import { EVENT_ASSISTANT_TOOL_USAGE_RULES } from '../../src/agents/eventAssistant/buildEventAssistantToolSystemPrompt.js'

interface Usage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

async function callOnce(
  label: string,
  modelId: string,
  systemBlocks: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[],
  userContent: string
): Promise<Usage> {
  const url = buildBedrockInvokeUrl(config.llms.bedrock.baseUrl, modelId)
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 16,
    system: systemBlocks,
    messages: [{ role: 'user', content: userContent }]
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

const REAL_BEHAVIOR_POLICY = {
  globalPolicy: {
    tone: 'warmSupportive',
    verbosity: 'brief',
    formality: 'semiFormal',
    jargonLevel: 'medium',
    safetyPosture: 'strict'
  },
  channels: {
    dm: {
      qaBehavior: { answerScope: 'broaderSubjectArea', responseLength: 'short' },
      proactivePolicy: { initiativeLevel: 'lightlyProactive', minContributionMinutes: 10, socialSensitivity: 'medium' }
    },
    groupChat: {
      proactivePolicy: { initiativeLevel: 'moderatelyProactive', minContributionMinutes: 2, socialSensitivity: 'medium' }
    }
  }
}

async function buildStableBlocks() {
  const templates = buildLLMTemplates('EventBot', ['web_search'], undefined)
  const baseSystem = composeSystemPrompt(templates.semanticSystem, {
    behaviorPolicy: REAL_BEHAVIOR_POLICY as never,
    channelType: 'dm',
    personalityName: null
  })
  const topic = 'BKC Launch Event: Building the Future of Digital Governance'

  // "Current shape" stable block — what production sends today.
  const currentStable = `${baseSystem}\n\n${EVENT_ASSISTANT_TOOL_USAGE_RULES}\n\n## Event topic:\n${topic}`

  // "Grown" stable block — adds REAL production tool-guidance text for every registered
  // tool (not filler), on the theory that an event assistant should describe its full
  // capability set consistently regardless of which subset is bound this turn.
  const allToolsGuidance = await buildToolsGuidance(['web_search', 'bkc_archive_wiki', 'member_bios'])
  const grownStable = `${currentStable}\n\n${allToolsGuidance}`

  return { currentStable, grownStable }
}

async function main() {
  if (!config.llms.bedrock.baseUrl || !config.llms.bedrock.key) {
    console.error('BEDROCK_BASE_URL and BEDROCK_API_KEY must be set to run this script.')
    process.exit(1)
  }

  const { currentStable, grownStable } = await buildStableBlocks()
  console.log(`currentStable: ${currentStable.length} chars (~${Math.round(currentStable.length / 4)} tok)`)
  console.log(`grownStable:   ${grownStable.length} chars (~${Math.round(grownStable.length / 4)} tok)`)

  // Two DIFFERENT simulated participants' DM turns — no shared identifier at all beyond
  // the identical stable event-level prefix. This is the whole point: nothing in the
  // request ties them together except byte-identical leading content.
  const participantAContent =
    '## Question from Dr. Sarah Kim (Faculty):\nWhat governance frameworks were discussed for open-source AI models?'
  const participantBContent =
    '## Question from Prof. James Liu (Faculty):\nCan you summarize what the second panelist said about liability?'

  console.log('\n=== Sonnet 4.6, CURRENT stable prefix (~1850 tok, real behaviorPolicy) ===')
  await callOnce(
    'sonnet participant A (expect WRITE)',
    'us.anthropic.claude-sonnet-4-6',
    [{ type: 'text', text: currentStable, cache_control: { type: 'ephemeral' } }],
    participantAContent
  )
  await callOnce(
    'sonnet participant B, DIFFERENT participant (expect READ)',
    'us.anthropic.claude-sonnet-4-6',
    [{ type: 'text', text: currentStable, cache_control: { type: 'ephemeral' } }],
    participantBContent
  )

  console.log('\n=== Opus 4.6, GROWN stable prefix (adds real all-tools guidance) ===')
  await callOnce(
    'opus participant A (expect WRITE if >=4096 tok)',
    'us.anthropic.claude-opus-4-6-v1',
    [{ type: 'text', text: grownStable, cache_control: { type: 'ephemeral' } }],
    participantAContent
  )
  await callOnce(
    'opus participant B, DIFFERENT participant (expect READ)',
    'us.anthropic.claude-opus-4-6-v1',
    [{ type: 'text', text: grownStable, cache_control: { type: 'ephemeral' } }],
    participantBContent
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
