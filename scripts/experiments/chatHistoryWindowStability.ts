#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Experiment 2 (issue #264, investigation step 3 — "silent invalidators"): does the
 * `messages` array itself survive as a stable, cacheable prefix as a conversation grows?
 *
 * getConversationHistory() (src/agents/helpers/getConversationHistory.ts) takes the last
 * `count` messages via `filteredMessages.slice(Math.max(0, length - count))`. Every call
 * site passes a fixed `count` (10 default, 50/100 for DM/shared history, or an
 * agentConfig-driven size) — this is a FIXED-SIZE SLIDING WINDOW, not a growing,
 * append-only history.
 *
 * Anthropic cache matching is a byte prefix match. While the conversation is shorter than
 * `count`, each new turn only appends — the array is a strict growing prefix of itself, so
 * a cache breakpoint on "history so far" would hit every time. Once the conversation
 * exceeds `count`, every new turn also DROPS the oldest message, which shifts every
 * remaining message down one slot. The message that used to be at array index 0 is gone,
 * so the very first byte of the `messages` array differs from the previous call — any
 * cache breakpoint placed anywhere in that history is invalidated on every single
 * subsequent turn, forever. That's a permanent cache MISS with a 1.25x write premium on
 * every call, i.e. worse than not caching at all — not merely "no benefit."
 *
 * No network/LLM/DB calls. Uses the real getConversationHistory + formatMultiUserConversationHistory
 * functions with synthetic in-memory message objects.
 *
 * Usage: node --loader ts-node/esm scripts/experiments/chatHistoryWindowStability.ts
 */
import getConversationHistory from '../../src/agents/helpers/getConversationHistory.js'
import { formatMultiUserConversationHistory } from '../../src/agents/helpers/llmInputFormatters.js'

function sharedPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMessage(i: number): any {
  return {
    _id: `msg-${i}`,
    fromAgent: i % 4 === 3,
    pseudonym: i % 4 === 3 ? 'EventBot' : `Participant${i % 4}`,
    bodyType: 'text',
    body: `Turn ${i}: some representative conversation content about the talk, roughly this length.`,
    updatedAt: new Date(Date.UTC(2026, 8, 21, 14, 0, i))
  }
}

function messagesAsWireJson(messages: unknown[]): string {
  // Mirrors what actually lands in the Anthropic `messages` array on the wire.
  return JSON.stringify(formatMultiUserConversationHistory({ messages } as never))
}

function compareStep(label: string, allMessages: ReturnType<typeof makeMessage>[], count: number, uptoIndex: number) {
  const beforeSlice = allMessages.slice(0, uptoIndex)
  const afterSlice = allMessages.slice(0, uptoIndex + 1)

  const before = getConversationHistory(beforeSlice, { count })
  const after = getConversationHistory(afterSlice, { count })

  const beforeJson = messagesAsWireJson(before.messages)
  const afterJson = messagesAsWireJson(after.messages)

  const prefixLen = sharedPrefixLength(beforeJson, afterJson)
  const pct = ((prefixLen / beforeJson.length) * 100).toFixed(1)
  console.log(
    `${label}: window=[${before.messages.length} msgs] -> [${after.messages.length} msgs], ` +
      `shared prefix ${prefixLen}/${beforeJson.length} chars (${pct}%)`
  )
  return Number(pct)
}

function main() {
  const count = 50
  const allMessages = Array.from({ length: 80 }, (_, i) => makeMessage(i))

  console.log(`Window size (count): ${count}\n`)

  console.log('--- Regime 1: conversation shorter than the window (pure growth) ---')
  compareStep('turn 10 -> 11', allMessages, count, 10)
  compareStep('turn 20 -> 21', allMessages, count, 20)
  compareStep('turn 49 -> 50', allMessages, count, 49)
  console.log('(expect ~100%: window not yet full, history only ever appends)\n')

  console.log('--- Regime 2: conversation longer than the window (sliding) ---')
  compareStep('turn 50 -> 51 (window just filled)', allMessages, count, 50)
  compareStep('turn 60 -> 61', allMessages, count, 60)
  compareStep('turn 79 -> 80', allMessages, count, 79)
  console.log('(expect ~0%: oldest message drops every turn, shifting the whole array)\n')

  console.log(
    'Conclusion: a cache breakpoint on `messages` is only ever useful for the first `count`\n' +
      "turns of a conversation. Every call site's `count` (10/50/100/agentConfig size) should\n" +
      'be treated as the point past which history-array caching silently reverts to 100% write,\n' +
      '0% read — worse than no marker at all. Either switch to a truncate-from-the-front-only-\n' +
      'once strategy (summarize + freeze older turns instead of sliding every turn), or scope any\n' +
      '`messages` cache_control breakpoint to short/young conversations only.'
  )
}

main()
