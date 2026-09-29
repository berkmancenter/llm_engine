#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Revised "obvious" prefix measurement after the tool-padding research: only include
 * tools that are genuinely always-relevant for this deployment (web_search, and per the
 * user, bkc_archive_wiki), NOT conversation-specific tools (member_bios, semantic scholar,
 * event_history) — binding those unconditionally is the anti-pattern the research flagged
 * (Anthropic's own "writing tools for agents" guidance + Epsilla's tool-search accuracy
 * data: unused/irrelevant tools measurably hurt tool-selection accuracy, not just risk
 * misuse).
 *
 * bkc_archive_wiki's tool factory is gated on `config.bkcArchive.apiUrl` being truthy
 * (module-load-time check) — this worktree's .env has no real value, so a placeholder
 * URL was added (BKC_ARCHIVE_API_URL=https://archive.example.invalid) purely to populate
 * the real, static Zod tool schemas. Nothing calls this URL: schema construction is
 * synchronous and local; the fetch only happens if a tool's `func` actually runs, which
 * this script never does.
 *
 * Zero network calls (stubbed fetch, same technique as toolsPrefixSize.ts / maxObviousPrefixSize.ts).
 *
 * Usage: node --loader ts-node/esm scripts/experiments/bkcArchiveWikiRealSize.ts
 */
import { SystemMessage } from '@langchain/core/messages'
import { createAgent } from 'langchain'
import { getBedrockChat } from '../../src/agents/helpers/getModelChat.js'
import { getTools, buildToolsGuidance } from '../../src/agents/tools/registry.js'
import { buildLLMTemplates } from '../../src/agents/eventAssistant/eventQuestionHandler.js'
import { composeSystemPrompt } from '../../src/agents/helpers/promptComposer.js'
import { buildEventAssistantToolSystemPrompt } from '../../src/agents/eventAssistant/buildEventAssistantToolSystemPrompt.js'

const approxTokens = (s: string) => Math.round(s.length / 4)
const CALIBRATION_RATIO = 1343 / (6183 / 4) // from the live Sonnet 4.6 test, same prompt shape

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

async function measureToolsSchema(toolNames: string[]) {
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
    const tools = await getTools(toolNames)
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
  const toolNamesBound = (parsed.tools ?? []).map((t: { name: string }) => t.name)
  const toolsJson = JSON.stringify(parsed.tools ?? [])
  return { toolNamesBound, chars: toolsJson.length }
}

async function main() {
  console.log('=== bkc_archive_wiki alone ===')
  const bkcOnly = await measureToolsSchema(['bkc_archive_wiki'])
  console.log(`  tools bound: [${bkcOnly.toolNamesBound.join(', ')}]`)
  console.log(
    `  schema size: ${bkcOnly.chars} chars, ~${approxTokens(bkcOnly.chars > 0 ? 'x'.repeat(bkcOnly.chars) : '')} tok`
  )

  const bkcGuidance = await buildToolsGuidance(['bkc_archive_wiki'])
  console.log(`  guidance text: ${bkcGuidance.length} chars, ~${approxTokens(bkcGuidance)} tok`)
  console.log(`  guidance preview: ${JSON.stringify(bkcGuidance.slice(0, 200))}...`)

  console.log('\n=== web_search + bkc_archive_wiki combined (the "genuinely always relevant" set) ===')
  const combined = await measureToolsSchema(['web_search', 'bkc_archive_wiki'])
  console.log(`  tools bound: [${combined.toolNamesBound.join(', ')}]`)
  console.log(
    `  schema size: ${combined.chars} chars, ~${approxTokens(combined.chars > 0 ? 'x'.repeat(combined.chars) : '')} tok`
  )

  console.log('\n=== Full revised "legitimate obvious" system text ===')
  const templates = buildLLMTemplates('EventBot', ['web_search'], undefined)
  const baseSystem = composeSystemPrompt(templates.semanticSystem, {
    behaviorPolicy: REAL_BEHAVIOR_POLICY as never,
    channelType: 'groupChat',
    personalityName: null
  })
  const topic = 'BKC Launch Event: Building the Future of Digital Governance'
  const fullSystem = await buildEventAssistantToolSystemPrompt(baseSystem, topic, '', {
    hasWebSearch: true,
    today: '2026-09-21'
  })
  const combinedSystemText = `${fullSystem}\n\n${bkcGuidance}`
  console.log(`  system text: ${combinedSystemText.length} chars, ~${approxTokens(combinedSystemText)} tok`)

  const totalCharsEquivalent = combinedSystemText.length + combined.chars
  const totalTok4 = approxTokens('x'.repeat(totalCharsEquivalent))
  const totalCalibrated = Math.round(totalTok4 * CALIBRATION_RATIO)

  console.log('\n=== Summary ===')
  console.log(`Total (system text + web_search + bkc_archive_wiki tools), chars/4: ~${totalTok4} tok`)
  console.log(`Calibrated to real tokenizer ratio: ~${totalCalibrated} tok`)
  console.log(`Opus 4.6 minimum: 4096 tok`)
  const gap = 4096 - totalCalibrated
  console.log(
    gap > 0 ? `Still short by ~${gap} tok using only genuinely-relevant tools.` : `Clears the minimum by ~${-gap} tok.`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
