#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Real-data rerun of experiments 1 and 2, against 5 real, long production `eventAssistant`
 * conversations (2,315-4,357 messages each) exported READ-ONLY from prod via
 * `llm_engine-infra`'s `scripts/llm-engine-prod-run.sh --mongo-eval` (aggregate/find/findOne
 * only — no writes; see that repo for the export tool). The export script itself is a local,
 * uncommitted scratchpad artifact:
 *   <scratchpad>/prodConversationExport.json
 *
 * Headline finding already visible in the raw export: all 5 conversations have
 * `behaviorPolicy`, `conversationContext`, and `goals` UNSET. The synthetic fixture used in
 * eventAssistantSystemPromptStability.ts (personalityName: null, no behaviorPolicy/goals) was
 * not an underestimate of the stable prefix — it was already representative.
 *
 * No network/LLM calls.
 *
 * Usage: node --loader ts-node/esm scripts/experiments/realConversationStability.ts <path-to-export.json>
 */
import fs from 'node:fs'
import { buildLLMTemplates } from '../../src/agents/eventAssistant/eventQuestionHandler.js'
import { buildEventAssistantToolSystemPrompt } from '../../src/agents/eventAssistant/buildEventAssistantToolSystemPrompt.js'
import { composeSystemPrompt } from '../../src/agents/helpers/promptComposer.js'
import { formatTranscript, formatMultiUserConversationHistory } from '../../src/agents/helpers/llmInputFormatters.js'
import getConversationHistory from '../../src/agents/helpers/getConversationHistory.js'

const approxTokens = (s: string) => Math.round(s.length / 4)

function sharedPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

interface ExportedMessage {
  fromAgent: boolean
  pseudonym: string
  bodyType: string
  body: unknown
  channels?: string[]
  createdAt: string
  updatedAt: string
  source?: { speaker?: string }
}

interface ExportedConversation {
  conversationId: string
  name: string
  conversationType: string
  fullMessageCount: number
  goals?: string[]
  behaviorPolicy?: unknown
  conversationContext?: unknown
  topic?: { name: string; description?: string }
  exportedMessageCount: number
  messages: ExportedMessage[]
}

function messagesAsWireJson(messages: ExportedMessage[]): string {
  return JSON.stringify(formatMultiUserConversationHistory({ messages } as never))
}

async function analyzeSystemPromptStability(conv: ExportedConversation) {
  console.log(`\n=== System prompt stability: "${conv.name}" (${conv.fullMessageCount} total messages) ===`)
  console.log(
    `behaviorPolicy: ${conv.behaviorPolicy === undefined ? 'UNSET' : 'set'}, ` +
      `conversationContext: ${conv.conversationContext === undefined ? 'UNSET' : 'set'}, ` +
      `goals: ${conv.goals === undefined ? 'UNSET' : JSON.stringify(conv.goals)}`
  )

  const templates = buildLLMTemplates('EventBot', ['web_search'], undefined)
  // Matches what these real conversations actually have: no conversationContext/behaviorPolicy,
  // no personality configured at the conversation level.
  const systemTemplate = composeSystemPrompt(templates.semanticSystem, {
    conversationContext: conv.conversationContext as never,
    behaviorPolicy: conv.behaviorPolicy as never,
    channelType: 'groupChat',
    personalityName: null
  })

  // Use two real, adjacent slices of this conversation's actual transcript as the volatile
  // "## Recent Transcript" content for consecutive turns — mirrors transcript.getTranscript's
  // rolling window, using real speaker/timing/content instead of synthetic filler.
  const msgs = conv.messages
  const windowSize = 40
  const stepStart = Math.max(0, Math.floor(msgs.length / 2))
  const windowA = msgs.slice(stepStart, stepStart + windowSize)
  const windowB = msgs.slice(stepStart + 1, stepStart + 1 + windowSize) // one message later

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toTranscriptShape = (m: ExportedMessage): any => ({
    createdAt: new Date(m.createdAt),
    body: typeof m.body === 'string' ? m.body : (m.body as { text?: string })?.text ?? JSON.stringify(m.body),
    source: m.source
  })

  const contextA = `## Recent Transcript:\n${formatTranscript(windowA.map(toTranscriptShape))}`
  const contextB = `## Recent Transcript:\n${formatTranscript(windowB.map(toTranscriptShape))}`

  const topic = conv.topic?.name ?? conv.name

  const promptA = await buildEventAssistantToolSystemPrompt(systemTemplate, topic, contextA, {
    hasWebSearch: true,
    today: '2026-09-21'
  })
  const promptB = await buildEventAssistantToolSystemPrompt(systemTemplate, topic, contextB, {
    hasWebSearch: true,
    today: '2026-09-21'
  })

  const prefixLen = sharedPrefixLength(promptA, promptB)
  const stableTokens = approxTokens(promptA.slice(0, prefixLen))
  console.log(
    `stable prefix: ${prefixLen}/${promptA.length} chars (${((prefixLen / promptA.length) * 100).toFixed(1)}%), ` +
      `~${stableTokens} tokens (chars/4 estimate)`
  )
  return stableTokens
}

function analyzeHistoryWindow(conv: ExportedConversation, count: number) {
  const msgs = conv.messages
  if (msgs.length <= count + 1) {
    console.log(
      `(skipping history-window check for "${conv.name}": only ${msgs.length} messages exported, need > ${count + 1})`
    )
    return
  }
  // Pick a point well past the window size (using only the exported prefix, which is itself
  // just the conversation's first `exportedMessageCount` messages — still real content, real
  // lengths, just not the full 2,000-4,000+ message conversation).
  const idx = Math.min(msgs.length - 2, count + 20)
  const before = getConversationHistory(msgs.slice(0, idx), { count })
  const after = getConversationHistory(msgs.slice(0, idx + 1), { count })
  const beforeJson = messagesAsWireJson(before.messages as never)
  const afterJson = messagesAsWireJson(after.messages as never)
  const prefixLen = sharedPrefixLength(beforeJson, afterJson)
  const pct = ((prefixLen / beforeJson.length) * 100).toFixed(1)
  console.log(
    `history window (count=${count}) at turn ${idx}->${idx + 1}: shared prefix ${prefixLen}/${
      beforeJson.length
    } chars (${pct}%)`
  )
}

async function main() {
  const path = process.argv[2]
  if (!path) {
    console.error('Usage: node --loader ts-node/esm scripts/experiments/realConversationStability.ts <path-to-export.json>')
    process.exit(1)
  }
  const data: ExportedConversation[] = JSON.parse(fs.readFileSync(path, 'utf8'))

  const stableTokenCounts: number[] = []
  for (const conv of data) {
    stableTokenCounts.push(await analyzeSystemPromptStability(conv))
  }

  console.log('\n=== Chat history sliding-window check (real messages, count=50 and count=100) ===')
  for (const conv of data) {
    console.log(`\n"${conv.name}" (${conv.fullMessageCount} total, ${conv.exportedMessageCount} exported):`)
    analyzeHistoryWindow(conv, 50)
    analyzeHistoryWindow(conv, 100)
  }

  const avgStable = Math.round(stableTokenCounts.reduce((a, b) => a + b, 0) / stableTokenCounts.length)
  console.log(`\n=== Summary ===`)
  console.log(`Average real stable system-prompt prefix across ${data.length} real conversations: ~${avgStable} tokens`)
  console.log(`(+ ~360 tokens for the web_search tool schema, measured separately, zero cost)`)
  console.log(`vs. Opus 4.6 minimum cacheable prefix: 4096 tokens`)
  console.log(`vs. Sonnet 4.6 / Opus 4.8 / Sonnet 4.5 minimum: 1024 tokens`)
  console.log(`vs. Opus 5 / Fable 5 / Mythos 5 minimum: 512 tokens`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
