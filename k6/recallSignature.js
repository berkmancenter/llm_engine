/* eslint-disable no-undef */
import crypto from 'k6/crypto'
import encoding from 'k6/encoding'

const WHSEC_PREFIX = 'whsec_'

/**
 * src/handlers/recall.ts (verifyRequestFromRecall) requires every /webhooks/recall
 * request to carry Svix-style signature headers computed over the *exact* request
 * body string - sign whatever you're about to POST, not a re-serialized copy of it.
 * The secret is the app's RECALL_REALTIME_SECRET (a "whsec_<base64>" value from the
 * target server's .env or app-env secret), not the old RECALL_WEBHOOK_TOKEN query
 * param, which the server has stopped reading entirely.
 */
export function signRecallWebhook(secret, bodyString) {
  if (!secret || !secret.startsWith(WHSEC_PREFIX)) {
    throw new Error(`RECALL_REALTIME_SECRET must start with "${WHSEC_PREFIX}" (got: ${secret})`)
  }
  const keyBytes = encoding.b64decode(secret.slice(WHSEC_PREFIX.length))
  const msgId = `msg_${Date.now()}_${Math.floor(Math.random() * 1e9)}`
  const msgTimestamp = Math.floor(Date.now() / 1000).toString()
  const signature = crypto.hmac('sha256', keyBytes, `${msgId}.${msgTimestamp}.${bodyString}`, 'base64')

  return {
    'webhook-id': msgId,
    'webhook-timestamp': msgTimestamp,
    'webhook-signature': `v1,${signature}`
  }
}
