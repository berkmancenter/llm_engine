/**
 * Update the botToken on the active Slack adapter, after validating it with Slack.
 * The token is read from the NEW_SLACK_BOT_TOKEN env var so it never appears in
 * shell history args or chat. Also re-resolves botUserId from the new token.
 *
 * Run:
 *   NEW_SLACK_BOT_TOKEN='xoxb-...' NODE_ENV=development \
 *     node --loader ts-node/esm scripts/updateSlackToken.ts
 */
/* eslint-disable no-console */
import mongoose from 'mongoose'
import { WebClient } from '@slack/web-api'
import config from '../src/config/config.js'
import { Adapter } from '../src/models/index.js'

const newToken = process.env.NEW_SLACK_BOT_TOKEN
if (!newToken) {
  console.error('Set NEW_SLACK_BOT_TOKEN to the working xoxb- token and re-run.')
  process.exit(1)
}

// Validate BEFORE writing anything.
let authResult: { ok?: boolean; user_id?: string; team?: string; error?: string }
try {
  authResult = await new WebClient(newToken).auth.test()
} catch (e) {
  console.error(`Token rejected by Slack: ${(e as Error).message}. Nothing changed.`)
  process.exit(1)
}
if (!authResult.ok || !authResult.user_id) {
  console.error(`Token invalid (error=${authResult.error}). Nothing changed.`)
  process.exit(1)
}
console.log(`Token OK — bot user ${authResult.user_id} on team ${authResult.team}.`)

await mongoose.connect(config.mongoose.url)
const adapter = await Adapter.findOne({ type: 'slack', active: true })
if (!adapter) {
  console.error('No active Slack adapter found. Nothing changed.')
  await mongoose.disconnect()
  process.exit(1)
}

adapter.config.botToken = newToken
adapter.config.botUserId = authResult.user_id
adapter.markModified('config')
await adapter.save()
console.log(`Updated adapter ${adapter._id}: botToken replaced, botUserId=${authResult.user_id}.`)

await mongoose.disconnect()
