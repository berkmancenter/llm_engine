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

/**
 * Builds the Bedrock InvokeModel URL for a model: `{baseUrl}/model/{modelId}/invoke`.
 *
 * `baseUrl` is everything up to the `/model` segment for your endpoint. For Amazon Bedrock
 * that is the bedrock-runtime host; for a gateway it is the gateway base path. The model id
 * goes straight into the path and can come from user-set config, so this validates it against
 * the known Bedrock character set first and rejects anything else. The colon in dated ids
 * (for example ...-v1:0) is valid in a URL path and is kept raw.
 *
 * @throws if the model id contains characters that are not valid in a Bedrock model id.
 */
export function buildBedrockInvokeUrl(baseUrl: string, modelId: string): string {
  if (!BEDROCK_MODEL_ID_PATTERN.test(modelId)) {
    throw new Error(`Invalid Bedrock model id: "${modelId}"`)
  }
  // Drop any trailing slash on the base url so the path does not end up with a double slash.
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  return `${normalizedBaseUrl}/model/${modelId}/invoke`
}

// Create a custom fetch function for Bedrock Claude or legacy LLM
export function createClaudeFetchFn(defaultLLMModel: string, defaultLLMPlatform: string) {
  return async function fetchFn(url: string, init: Parameters<typeof fetch>[1]) {
    const fetchImpl = async () => {
      try {
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

        // Send the native Bedrock InvokeModel request body directly.
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
        // Bedrock routes by model id in the path; buildBedrockInvokeUrl validates the id first.
        const invokeUrl = buildBedrockInvokeUrl(config.llms.bedrock.baseUrl, defaultLLMModel)
        const response = await fetch(invokeUrl, modifiedInit)
        const contentType = response.headers.get('content-type') || ''
        if (!response.ok) {
          const responseText = await response.text()
          logger.error('Error response Text from proxy:', responseText)
          throw new Error(`Bedrock proxy error: ${response.status} ${response.statusText}\n${responseText}`)
        }
        if (contentType.includes('application/json')) {
          return response
        }
        const responseText = await response.text()
        throw new Error(`Expected JSON from Bedrock proxy, got ${contentType}: ${responseText}`)
      } catch (err) {
        logger.error('Error in fetchFn:', err)
        throw err
      }
    }
    return fetchImpl()
  }
}
