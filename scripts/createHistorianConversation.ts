/**
 * Create (and start) an eventHistorian conversation in the current MONGODB_URL database,
 * wired to Slack. Slack config (channel/workspace/token/botUserId) is copied from the
 * active Slack adapter in a previous database (default: llm_engine on the same host),
 * or overridden via env vars:
 *
 *   SLACK_CHANNEL, SLACK_WORKSPACE, NEW_SLACK_BOT_TOKEN, SLACK_BOT_USER_ID
 *
 * The agent's topicIds is left empty so it searches ALL public topics.
 * Aborts if an active Slack adapter already exists for the same channel+workspace.
 *
 * Run:
 *   NODE_ENV=development node --loader ts-node/esm scripts/createHistorianConversation.ts
 */
/* eslint-disable no-console */
import mongoose from 'mongoose'
import { WebClient } from '@slack/web-api'
import config from '../src/config/config.js'
import { Adapter, Conversation, Topic, User } from '../src/models/index.js'
import conversationService from '../src/services/conversation.service/index.js'
import websocketGateway from '../src/websockets/websocketGateway.js'

// No websocket server exists in a standalone script; broadcasts would throw.
websocketGateway.broadcast = async () => {}

const SOURCE_DB_URL = process.env.SOURCE_DB_URL || 'mongodb://127.0.0.1:27017/llm_engine'

async function getSlackConfig() {
  const fromEnv = {
    channel: process.env.SLACK_CHANNEL,
    workspace: process.env.SLACK_WORKSPACE,
    botToken: process.env.NEW_SLACK_BOT_TOKEN,
    botUserId: process.env.SLACK_BOT_USER_ID
  }
  if (fromEnv.channel && fromEnv.workspace && fromEnv.botToken) return fromEnv

  console.log(`Copying Slack config from active adapter in ${SOURCE_DB_URL} ...`)
  const source = await mongoose.createConnection(SOURCE_DB_URL).asPromise()
  const adapter = await source.collection('adapters').findOne({ type: 'slack', active: true })
  await source.close()
  if (!adapter?.config?.botToken) {
    throw new Error('No active Slack adapter with a botToken found in source DB; set SLACK_* env vars instead.')
  }
  return {
    channel: fromEnv.channel || adapter.config.channel,
    workspace: fromEnv.workspace || adapter.config.workspace,
    botToken: fromEnv.botToken || adapter.config.botToken,
    botUserId: fromEnv.botUserId || adapter.config.botUserId
  }
}

await mongoose.connect(config.mongoose.url)
console.log(`Connected to ${config.mongoose.url}`)

const slack = await getSlackConfig()

// Validate the token BEFORE creating anything.
const auth = await new WebClient(slack.botToken).auth.test()
if (!auth.ok || !auth.user_id) {
  console.error(`Slack token invalid (error=${auth.error}). Nothing created.`)
  process.exit(1)
}
console.log(`Slack token OK — bot user ${auth.user_id} on team ${auth.team} (workspace ${slack.workspace})`)
slack.botUserId = auth.user_id

const existing = await Adapter.findOne({
  type: 'slack',
  'config.channel': slack.channel,
  'config.workspace': slack.workspace,
  active: true
})
if (existing) {
  console.error(
    `An active Slack adapter already exists for channel ${slack.channel} in workspace ${slack.workspace} ` +
      `(adapter ${existing._id}, conversation ${existing.conversation}). Deactivate it first. Nothing created.`
  )
  process.exit(1)
}

const owner = await User.findOne({ role: 'admin', username: { $exists: true } }).sort({ createdAt: 1 })
if (!owner) throw new Error('No admin user found to own the conversation.')

const topic = await Topic.findOne({ name: 'BKC Events', isDeleted: false })
if (!topic) throw new Error('Topic "BKC Events" not found.')

console.log(`Owner: ${owner.username} (${owner._id}) — container topic: ${topic.name} (${topic._id})`)

// A previous run may have created the conversation but died before starting it
// (e.g. on the websocket broadcast). Start that one instead of creating a twin.
const stranded = await Conversation.findOne({
  conversationType: 'eventHistorian',
  active: false,
  'properties.slackChannel': slack.channel,
  'properties.slackWorkspace': slack.workspace
}).sort({ createdAt: -1 })
if (stranded) {
  console.log(`Found inactive historian conversation ${stranded._id} — starting it instead of creating a new one.`)
  await conversationService.startConversation(stranded._id.toString(), owner)
  // NOTE: don't use .lean() here — the model's post-findOne hook calls doc.populate()
  const started = await Conversation.findById(stranded._id)
  console.log(`Started conversation ${started!._id} ("${started!.name}") active=${started!.active}`)
  await mongoose.disconnect()
  process.exit(0)
}

const conversation = await conversationService.createConversationFromType(
  {
    type: 'eventHistorian',
    name: 'BKC Historian (Slack)',
    topicId: topic._id.toString(),
    platforms: ['slack'],
    properties: {
      slackChannel: slack.channel,
      slackWorkspace: slack.workspace,
      slackBotToken: slack.botToken,
      slackBotUserId: slack.botUserId,
      botName: config.conversationBotName
      // topicIds intentionally omitted -> historian searches all public topics
    }
  },
  owner
)

console.log(`Created + started conversation ${conversation._id} ("${conversation.name}")`)
console.log(`  active=${conversation.active} adapters=${conversation.adapters.length} agents=${conversation.agents.length}`)

await mongoose.disconnect()
process.exit(0)
