import { createClaudeFetchFn, buildBedrockInvokeUrl } from '../../../src/agents/helpers/bedrockGateway.js'
import config from '../../../src/config/config.js'

describe('createClaudeFetchFn (Bedrock gateway transport)', () => {
  // The transport posts the native Bedrock InvokeModel request to {baseUrl}/model/{modelId}/invoke
  // with an x-api-key header. These tests pin that contract. The model id is colon-free here so the
  // URL assertion does not depend on how the colon in dated ids is handled.
  const BASE_URL = 'https://bedrock.example.com'
  const API_KEY = 'test-bedrock-key'
  const MODEL_ID = 'us.anthropic.claude-sonnet-4-6'

  // Stash the real values once; each test swaps in known values and afterEach restores them.
  const originalFetch = globalThis.fetch
  const originalBaseUrl = config.llms.bedrock.baseUrl
  const originalKey = config.llms.bedrock.key

  let capturedUrl: string | undefined
  let capturedInit: { body: string; headers: Record<string, string> } | undefined

  beforeEach(() => {
    config.llms.bedrock.baseUrl = BASE_URL
    config.llms.bedrock.key = API_KEY
    capturedUrl = undefined
    capturedInit = undefined

    globalThis.fetch = ((url: string, init: { body: string; headers: Record<string, string> }) => {
      capturedUrl = url
      capturedInit = init
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        text: async () => '{}'
      })
    }) as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    config.llms.bedrock.baseUrl = originalBaseUrl
    config.llms.bedrock.key = originalKey
  })

  const callFetchFn = () => {
    const fetchFn = createClaudeFetchFn(MODEL_ID, 'bedrock')
    return fetchFn('https://ignored.example', {
      body: JSON.stringify({
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hello world' }],
        max_tokens: 100
      })
    })
  }

  it('POSTs to the /model/{modelId}/invoke endpoint', async () => {
    await callFetchFn()
    expect(capturedUrl).toBe(`${BASE_URL}/model/${MODEL_ID}/invoke`)
  })

  it('sends the native Bedrock request body, not a wrapper envelope', async () => {
    await callFetchFn()
    const sentBody = JSON.parse(capturedInit!.body)

    // Native Bedrock fields sit at the top level of the request.
    expect(sentBody.anthropic_version).toBe('bedrock-2023-05-31')
    expect(sentBody.max_tokens).toBe(100)
    expect(Array.isArray(sentBody.messages)).toBe(true)

    // No wrapper keys around the request.
    expect(sentBody).not.toHaveProperty('body')
    expect(sentBody).not.toHaveProperty('modelId')
    expect(sentBody).not.toHaveProperty('accept')
    expect(sentBody).not.toHaveProperty('contentType')
  })

  it('keeps the x-api-key auth header from config', async () => {
    await callFetchFn()
    expect(capturedInit!.headers['x-api-key']).toBe(API_KEY)
  })

  it('retries on 500 and succeeds when a subsequent attempt returns 200', async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      if (calls < 3) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          headers: { get: () => null },
          text: async () => 'transient error'
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        text: async () => '{}'
      })
    }) as unknown as typeof globalThis.fetch

    await expect(callFetchFn()).resolves.toBeDefined()
    expect(calls).toBe(3)
  })

  it('retries on 429 and respects Retry-After header', async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      if (calls === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: { get: (h: string) => (h === 'Retry-After' ? '0' : null) },
          text: async () => 'rate limited'
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        text: async () => '{}'
      })
    }) as unknown as typeof globalThis.fetch

    await expect(callFetchFn()).resolves.toBeDefined()
    expect(calls).toBe(2)
  })

  it('throws after exhausting all retries on persistent 500', async () => {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: () => null },
        text: async () => 'always failing'
      })) as unknown as typeof globalThis.fetch

    await expect(callFetchFn()).rejects.toThrow()
  })

  it('does not retry on 400 bad request', async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: { get: () => null },
        text: async () => 'bad request'
      })
    }) as unknown as typeof globalThis.fetch

    await expect(callFetchFn()).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('routes to invoke-with-response-stream when the incoming URL contains that method', async () => {
    const fetchFn = createClaudeFetchFn(MODEL_ID, 'bedrock')
    await fetchFn(`https://ignored.example/model/${MODEL_ID}/invoke-with-response-stream`, {
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 50 })
    })
    expect(capturedUrl).toBe(`${BASE_URL}/model/${MODEL_ID}/invoke-with-response-stream`)
  })

  it('routes to /invoke for a non-streaming URL', async () => {
    await callFetchFn()
    expect(capturedUrl).toBe(`${BASE_URL}/model/${MODEL_ID}/invoke`)
  })

  it('passes through an event-stream response without consuming the body', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (h: string) => (h === 'content-type' ? 'application/vnd.amazon.eventstream' : null) }
    }
    globalThis.fetch = (() => Promise.resolve(mockResponse)) as unknown as typeof globalThis.fetch

    const fetchFn = createClaudeFetchFn(MODEL_ID, 'bedrock')
    const result = await fetchFn(`https://ignored.example/model/${MODEL_ID}/invoke-with-response-stream`, {
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 50 })
    })

    // The response object should be returned as-is so BedrockChat can decode the stream.
    expect(result).toBe(mockResponse)
  })

  it('refuses an unsafe model id before calling fetch', async () => {
    const fetchFn = createClaudeFetchFn('evil/../path', 'bedrock')
    await expect(
      fetchFn('https://ignored.example', {
        body: JSON.stringify({
          system: 'You are a helpful assistant',
          messages: [{ role: 'user', content: 'Hello world' }],
          max_tokens: 100
        })
      })
    ).rejects.toThrow()
    expect(capturedUrl).toBeUndefined()
  })
})

describe('buildBedrockInvokeUrl', () => {
  const BASE = 'https://bedrock.example.com'

  it('builds the /model/{modelId}/invoke path', () => {
    expect(buildBedrockInvokeUrl(BASE, 'us.anthropic.claude-sonnet-4-6')).toBe(
      `${BASE}/model/us.anthropic.claude-sonnet-4-6/invoke`
    )
  })

  it('builds the invoke-with-response-stream path when method is specified', () => {
    expect(buildBedrockInvokeUrl(BASE, 'us.anthropic.claude-sonnet-4-6', 'invoke-with-response-stream')).toBe(
      `${BASE}/model/us.anthropic.claude-sonnet-4-6/invoke-with-response-stream`
    )
  })

  it('keeps the raw colon in dated model ids', () => {
    expect(buildBedrockInvokeUrl(BASE, 'us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      `${BASE}/model/us.anthropic.claude-haiku-4-5-20251001-v1:0/invoke`
    )
  })

  it('strips a trailing slash from the base url so the path has no double slash', () => {
    expect(buildBedrockInvokeUrl(`${BASE}/`, 'us.anthropic.claude-sonnet-4-6')).toBe(
      `${BASE}/model/us.anthropic.claude-sonnet-4-6/invoke`
    )
  })

  it('rejects model ids that contain URL-structural characters', () => {
    expect(() => buildBedrockInvokeUrl(BASE, 'foo/bar')).toThrow()
    expect(() => buildBedrockInvokeUrl(BASE, 'foo?x=1')).toThrow()
    expect(() => buildBedrockInvokeUrl(BASE, 'foo#frag')).toThrow()
    expect(() => buildBedrockInvokeUrl(BASE, 'foo%2e')).toThrow()
    expect(() => buildBedrockInvokeUrl(BASE, 'has space')).toThrow()
    expect(() => buildBedrockInvokeUrl(BASE, '')).toThrow()
  })
})
