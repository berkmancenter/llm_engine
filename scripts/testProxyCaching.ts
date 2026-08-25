#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Prompt-caching spike against the Bedrock proxy — bypasses LangChain entirely so the
 * result isolates one question: does the proxy (and the model behind it) honor
 * `cache_control`, independent of the `BedrockChat`/`transformPayloadForClaude` bugs
 * documented in the prompt-caching investigation.
 *
 * Sends two back-to-back requests with an identical, oversized `system` prefix carrying
 * a `cache_control` breakpoint:
 *   - Call 1 should show cache_creation_input_tokens > 0, cache_read_input_tokens === 0
 *   - Call 2 should show cache_read_input_tokens > 0
 *
 * Costs real inference money (a cache write is priced ~1.25x normal input; the padded
 * system prompt is sized to clear the model's minimum cacheable prefix). Run only with
 * explicit go-ahead — see k6/CLAUDE.md for the project's approval norm on paid runs.
 *
 * Usage: node --loader ts-node/esm scripts/testProxyCaching.ts [modelId]
 */
import config from '../src/config/config.js'
import { buildBedrockInvokeUrl } from '../src/agents/helpers/bedrockGateway.js'

// Dominant production model per the caching investigation; highest known min-cacheable-prefix
// (4096 tokens), so a pass here should generalize to every other current Claude model.
const DEFAULT_MODEL = 'us.anthropic.claude-opus-4-6-v1'
const modelId = process.argv[2] || DEFAULT_MODEL

// Padded well past the 4096-token minimum for Opus 4.6. Repeated filler keeps this a plain
// text block; real token count will run a bit under the word count due to tokenization.
const FILLER_SENTENCE =
  'This is stable, unchanging boilerplate used only to pad the system prompt past the ' +
  'minimum cacheable prefix length for this model. '
const STABLE_SYSTEM_TEXT = FILLER_SENTENCE.repeat(500) // ~7-8k tokens

function buildBody() {
  return {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 16, // keep the billed completion trivial; we only care about usage.*
    system: [
      {
        type: 'text',
        text: STABLE_SYSTEM_TEXT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [{ role: 'user', content: 'Reply with the single word: ack' }]
  }
}

async function callOnce(label: string) {
  const url = buildBedrockInvokeUrl(config.llms.bedrock.baseUrl, modelId)
  const body = JSON.stringify(buildBody())

  const start = Date.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.llms.bedrock.key
    },
    body
  })
  const elapsedMs = Date.now() - start

  const text = await response.text()
  if (!response.ok) {
    console.error(`[${label}] HTTP ${response.status} in ${elapsedMs}ms:\n${text}`)
    throw new Error(`${label} failed: ${response.status}`)
  }

  const json = JSON.parse(text)
  const usage = json.usage ?? {}
  console.log(`[${label}] ${elapsedMs}ms`, {
    input_tokens: usage.input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    output_tokens: usage.output_tokens
  })
  return usage
}

async function main() {
  if (!config.llms.bedrock.baseUrl || !config.llms.bedrock.key) {
    console.error('BEDROCK_BASE_URL and BEDROCK_API_KEY must be set to run this script.')
    process.exit(1)
  }

  console.log(`Model: ${modelId}`)
  console.log(`Proxy: ${config.llms.bedrock.baseUrl}`)
  console.log('---')

  const first = await callOnce('call 1 (expect cache WRITE)')
  const second = await callOnce('call 2 (expect cache READ)')

  console.log('---')
  const wrote = (first.cache_creation_input_tokens ?? 0) > 0
  const read = (second.cache_read_input_tokens ?? 0) > 0
  console.log(wrote ? '✓ cache write observed on call 1' : '✗ NO cache write on call 1 — cache_control was not honored')
  console.log(read ? '✓ cache read observed on call 2' : '✗ NO cache read on call 2 — cache_control was not honored')

  if (!wrote || !read) {
    console.log(
      '\nIf both usage blocks otherwise look normal (input_tokens present, no error), the proxy is\n' +
        'likely stripping or not forwarding cache_control — check the HUIT docs / ask HUIT directly.\n' +
        'If the request itself errored, the proxy or model may reject the field outright.'
    )
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
