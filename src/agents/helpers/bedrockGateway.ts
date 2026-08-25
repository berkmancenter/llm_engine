import logger from '../../config/logger.js'
import config from '../../config/config.js'
import { transformPayloadForClaude } from './claudeHandler.js'

/**
 * Bedrock gateway transport.
 *
 * This module owns how we reach a specific Amazon Bedrock endpoint: the request URL and the
 * auth header. It is the one place to change when pointing the app at a different Bedrock
 * provider.
 *
 * The default targets an API-key gateway. It sends the native Bedrock InvokeModel request to
 * `{BEDROCK_BASE_URL}/model/{modelId}/invoke` with an `x-api-key` header, and assumes the
 * gateway signs the upstream AWS request (SigV4) on its side.
 *
 * If you call Amazon Bedrock directly, AWS requires SigV4-signed requests rather than an api
 * key. In that case, set `BEDROCK_BASE_URL` to your endpoint and replace the auth below, or
 * drop this custom fetch and use LangChain's BedrockChat with AWS credentials instead.
 */

// Allowed Bedrock model id characters. Reject anything else (/, ?, #, ...) so a model id
// cannot alter the URL path; the colon in dated ids is valid in a path segment and stays.
const BEDROCK_MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

export type BedrockInvokeMethod = 'invoke' | 'invoke-with-response-stream'

/**
 * Builds the Bedrock InvokeModel URL for a model: `{baseUrl}/model/{modelId}/{method}`.
 *
 * `baseUrl` is everything up to the `/model` segment for your endpoint. The model id
 * is validated against the known Bedrock character set and rejected if invalid. The
 * method defaults to `invoke`; pass `invoke-with-response-stream` for streaming.
 *
 * @throws if the model id contains characters that are not valid in a Bedrock model id.
 */
export function buildBedrockInvokeUrl(
  baseUrl: string,
  modelId: string,
  method: BedrockInvokeMethod = 'invoke'
): string {
  if (!BEDROCK_MODEL_ID_PATTERN.test(modelId)) {
    throw new Error(`Invalid Bedrock model id: "${modelId}"`)
  }
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  return `${normalizedBaseUrl}/model/${modelId}/${method}`
}

const RETRYABLE_STATUS = new Set([429, 500, 502])
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 500

// Create a custom fetch function for Bedrock Claude or legacy LLM
export function createClaudeFetchFn(defaultLLMModel: string, defaultLLMPlatform: string) {
  return async function fetchFn(rawUrl: string | URL | Request, init: Parameters<typeof fetch>[1]) {
    const url = typeof rawUrl === 'string' ? rawUrl : rawUrl.toString()
    let bodyContent: unknown = {}
    if (init?.body) {
      if (
        typeof init.body === 'string' &&
        (init.body.trim().toLowerCase().startsWith('<!doctype') || init.body.trim().toLowerCase().startsWith('<html'))
      ) {
        logger.error('init.body appears to be HTML, not JSON:', init.body)
        throw new Error('init.body is HTML, not JSON')
      }
      try {
        bodyContent = JSON.parse(init.body as string)
      } catch (err) {
        logger.error('init.body is not valid JSON:', init.body)
        throw err
      }
    }

    // Transform payload for Claude if needed
    bodyContent = transformPayloadForClaude(bodyContent, defaultLLMModel, defaultLLMPlatform)

    const bodyString = JSON.stringify(bodyContent)
    const modifiedInit = {
      ...(init || {}),
      body: bodyString,
      headers: {
        'Content-Type': 'application/json',
        // Auth for an api-key gateway. Direct AWS Bedrock would use SigV4 signing instead.
        'x-api-key': config.llms.bedrock.key
      }
    }
    // BedrockChat._streamResponseChunks() builds its own request URL targeting a direct AWS
    // endpoint we don't use and calls this same fetchFn with it — mirror only the method
    // segment ("invoke" vs "invoke-with-response-stream") against our own gateway base URL.
    const isStreaming = url.includes('invoke-with-response-stream')
    const invokeUrl = buildBedrockInvokeUrl(
      config.llms.bedrock.baseUrl,
      defaultLLMModel,
      isStreaming ? 'invoke-with-response-stream' : 'invoke'
    )

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(invokeUrl, modifiedInit)

        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
          const retryAfter = response.headers.get('Retry-After')
          const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : RETRY_BASE_DELAY_MS * 2 ** attempt
          logger.warn(`Bedrock proxy ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES}); retrying in ${delay}ms`)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }

        if (!response.ok) {
          const responseText = await response.text()
          logger.error('Error response from Bedrock proxy:', responseText)
          throw new Error(`Bedrock proxy error: ${response.status} ${response.statusText}\n${responseText}`)
        }

        const contentType = response.headers.get('content-type') || ''
        // AWS event-stream framing for invoke-with-response-stream — BedrockChat decodes the
        // body itself, so pass the response through untouched (don't consume it here).
        if (contentType.includes('application/json') || contentType.includes('application/vnd.amazon.eventstream')) {
          return response
        }
        const responseText = await response.text()
        throw new Error(`Expected JSON from Bedrock proxy, got ${contentType}: ${responseText}`)
      } catch (err) {
        if (attempt < MAX_RETRIES && !(err instanceof Error && err.message.startsWith('Bedrock proxy error'))) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** attempt
          logger.warn(`Bedrock fetch error (attempt ${attempt + 1}/${MAX_RETRIES}); retrying in ${delay}ms`, err)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        logger.error('Error in Bedrock fetchFn:', err)
        throw err
      }
    }

    throw new Error('Bedrock fetch failed after maximum retries')
  }
}
