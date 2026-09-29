#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * One-off probe: discover the real Bedrock model IDs for Opus 5 and Sonnet 5 on the HUIT
 * gateway this app uses, before hardcoding a guess into getModelChat.ts. An invalid model
 * ID rejects before any inference runs (no tokens billed); a valid one is confirmed with a
 * max_tokens:1 request, so this costs at most a few cents even if several candidates are
 * tried.
 *
 * Usage: node --loader ts-node/esm scripts/experiments/probeOpus5Sonnet5ModelIds.ts
 */
import config from '../../src/config/config.js'
import { buildBedrockInvokeUrl } from '../../src/agents/helpers/bedrockGateway.js'

const CANDIDATES = {
  'Opus 5': ['us.anthropic.claude-opus-5-v1:0', 'us.anthropic.claude-opus-5-v1', 'us.anthropic.claude-opus-5'],
  'Sonnet 5': ['us.anthropic.claude-sonnet-5-v1:0', 'us.anthropic.claude-sonnet-5-v1', 'us.anthropic.claude-sonnet-5']
}

async function tryModelId(modelId: string): Promise<{ ok: boolean; status: number; detail: string }> {
  const url = buildBedrockInvokeUrl(config.llms.bedrock.baseUrl, modelId)
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }]
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.llms.bedrock.key },
    body
  })
  const text = await response.text()
  return { ok: response.ok, status: response.status, detail: text.slice(0, 200) }
}

async function main() {
  if (!config.llms.bedrock.baseUrl || !config.llms.bedrock.key) {
    console.error('BEDROCK_BASE_URL and BEDROCK_API_KEY must be set to run this script.')
    process.exit(1)
  }

  for (const [label, ids] of Object.entries(CANDIDATES)) {
    console.log(`\n=== ${label} ===`)
    for (const id of ids) {
      try {
        const result = await tryModelId(id)
        console.log(`  ${id} -> ${result.ok ? 'OK' : `HTTP ${result.status}`}: ${result.detail}`)
        if (result.ok) break // found a working ID for this label, no need to try the rest
      } catch (err) {
        console.log(`  ${id} -> threw: ${(err as Error).message}`)
      }
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
