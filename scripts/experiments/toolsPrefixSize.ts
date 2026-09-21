#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Follow-up to liveCacheBreakpointTest.ts: that live test measured `system` in isolation
 * and found the real Opus 4.6 stable prefix (1330 tokens) misses the 4096-token minimum.
 * But `tools` render BEFORE `system` in the actual request, and the minimum-cacheable-prefix
 * check is on the CUMULATIVE bytes up to the breakpoint — so a breakpoint placed after
 * `system` (with tools ahead of it) needs tools+system combined to clear the bar, not
 * system alone. This script measures the real `tools` JSON size for the actual
 * event-assistant tool set, with zero network calls: it stubs global fetch to capture the
 * exact body BedrockChat sends (before our own fetchFn transform even runs) and returns a
 * canned response so nothing hits the wire.
 *
 * Usage: node --loader ts-node/esm scripts/experiments/toolsPrefixSize.ts
 */
import { SystemMessage } from '@langchain/core/messages'
import { createAgent } from 'langchain'
import { getBedrockChat } from '../../src/agents/helpers/getModelChat.js'
import { getTools } from '../../src/agents/tools/registry.js'

async function measureToolsSize(toolNames: string[]) {
  let capturedBody: string | undefined

  const originalFetch = globalThis.fetch
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (_url: any, init: any) => {
    capturedBody = init?.body as string
    return new Response(
      JSON.stringify({
        id: 'msg_fake',
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
      // We only need the captured request body from the first (stubbed) fetch call — ignore
      // any graph error from the canned response not looking like a "real" turn to LangGraph.
      if (!capturedBody) throw err
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  if (!capturedBody) throw new Error('fetch was never called — could not capture request body')
  const parsed = JSON.parse(capturedBody)
  const toolsJson = JSON.stringify(parsed.tools ?? [])
  console.log(`Tools requested: [${toolNames.join(', ')}]`)
  console.log(`Tool names actually bound: [${(parsed.tools ?? []).map((t: { name: string }) => t.name).join(', ')}]`)
  console.log(
    `Serialized tools JSON: ${toolsJson.length} chars (chars/4 estimate: ~${Math.round(toolsJson.length / 4)} tokens)`
  )
  return toolsJson.length
}

async function main() {
  console.log('=== web_search only (Event Assistant default) ===')
  await measureToolsSize(['web_search'])

  console.log('\n=== web_search + event_history (series-history conversations) ===')
  await measureToolsSize(['web_search', 'event_history'])
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
