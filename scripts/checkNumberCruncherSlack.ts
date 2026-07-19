#!/usr/bin/env node
/**
 * Confirms the Number Cruncher (NC) Slack integration is wired up correctly, without
 * waiting for a real event to stop or for LangSmith to settle. It exercises the exact
 * outbound path a cost card takes: it resolves NC's stored Slack credentials, checks the
 * bot token, renders a sample cost card with the real card renderer, and posts it to NC's
 * channel. If a card lands in Slack, the integration works end to end.
 *
 * What it checks, in order:
 *   1. NC is provisioned — an active `numberCruncher` agent with a Slack adapter exists
 *      (or use --conversation=<id> to point at a specific conversation's Slack adapter).
 *   2. The bot token is valid and identifies the bot (Slack `auth.test`).
 *   3. The bot can post the cost card to its channel (Slack `chat.postMessage` with the
 *      real Block Kit rendered by renderConversationCostCard — the same code the live
 *      card uses), so a bad channel id, a bot not invited to the channel, or a missing
 *      `chat:write` scope all surface here.
 *
 * This does NOT touch LangSmith or compute a real cost — it posts a clearly-labeled
 * sample card. To verify the *cost calculation* path, stop a real event (see SETUP.md,
 * "Cost summaries per event") and watch for the card / the ConversationCost record.
 *
 * Flags:
 *   --conversation=<id>  Use this conversation's Slack adapter instead of auto-finding NC.
 *   --auth-only          Stop after the token check; do not post anything to Slack.
 *   --private            Render the card as a private-topic event (name redacted), to
 *                        confirm the redaction path looks right in Slack.
 *   --dry-run            Resolve credentials and render the card, but make no Slack calls.
 *
 * RUNNING IT:
 *
 *   # Against your dev instance (reads MONGODB_URL from .env)
 *   NODE_ENV=development node --loader ts-node/esm scripts/checkNumberCruncherSlack.ts
 *
 *   # Just confirm the token is valid, post nothing
 *   NODE_ENV=development node --loader ts-node/esm scripts/checkNumberCruncherSlack.ts --auth-only
 *
 *   # Production
 *   NODE_ENV=production node --loader ts-node/esm scripts/checkNumberCruncherSlack.ts
 */
/* eslint-disable no-console */

import mongoose from 'mongoose'
import { pathToFileURL } from 'url'
import { WebClient } from '@slack/web-api'
import config from '../src/config/config.js'
import Adapter from '../src/models/adapter.model.js'
import Agent from '../src/models/user.model/agent.model/index.js'
import renderResponseBlocks from '../src/adapters/slack/blocks/index.js'
import type { ConversationCostData } from '../src/types/index.types.js'

/* A realistic, clearly-labeled sample cost card. The name makes it obvious in the
   channel that this is a setup probe and not a real event's cost. */
function sampleCostData(topicIsPrivate: boolean): ConversationCostData {
  const liveEvent = {
    estimatedCostUSD: 1.12,
    totalPromptTokens: 42000,
    totalCompletionTokens: 8100,
    llmCallCount: 24,
    models: [
      {
        model: 'claude-sonnet-4-5',
        llmCalls: 20,
        promptTokens: 38000,
        completionTokens: 7200,
        estimatedCostUSD: 1.02,
        priced: true
      },
      {
        model: 'claude-haiku-4-5',
        llmCalls: 4,
        promptTokens: 4000,
        completionTokens: 900,
        estimatedCostUSD: 0.1,
        priced: true
      }
    ],
    agents: [
      { agentType: 'eventAssistant', llmCalls: 18, estimatedCostUSD: 0.92 },
      { agentType: 'engagementAgent', llmCalls: 6, estimatedCostUSD: 0.2 }
    ],
    hasUnpricedCalls: false
  }
  const postEvent = {
    estimatedCostUSD: topicIsPrivate ? 0 : 0.35,
    totalPromptTokens: topicIsPrivate ? 0 : 12000,
    totalCompletionTokens: topicIsPrivate ? 0 : 2400,
    llmCallCount: topicIsPrivate ? 0 : 3,
    models: topicIsPrivate
      ? []
      : [
          {
            model: 'claude-sonnet-4-5',
            llmCalls: 3,
            promptTokens: 12000,
            completionTokens: 2400,
            estimatedCostUSD: 0.35,
            priced: true
          }
        ],
    agents: topicIsPrivate ? [] : [{ agentType: 'vibesAnalyst', llmCalls: 3, estimatedCostUSD: 0.35 }],
    hasUnpricedCalls: false
  }
  const total = {
    estimatedCostUSD: liveEvent.estimatedCostUSD + postEvent.estimatedCostUSD,
    totalPromptTokens: liveEvent.totalPromptTokens + postEvent.totalPromptTokens,
    totalCompletionTokens: liveEvent.totalCompletionTokens + postEvent.totalCompletionTokens,
    llmCallCount: liveEvent.llmCallCount + postEvent.llmCallCount,
    models: [...liveEvent.models, ...postEvent.models],
    agents: [...liveEvent.agents, ...postEvent.agents],
    hasUnpricedCalls: false
  }
  return {
    conversationName: 'Slack setup check — sample card (not a real event)',
    checkedAt: new Date().toISOString(),
    total,
    liveEvent,
    postEvent,
    topicIsPrivate
  }
}

/* Turns the common Slack API error codes into an actionable next step, so a failure
   points at the fix (invite the bot, fix the channel id, add a scope) rather than just
   echoing a bare error string. */
function hintForSlackError(error?: string): string | null {
  switch (error) {
    case 'invalid_auth':
    case 'account_inactive':
    case 'token_revoked':
      return 'The bot token is invalid or revoked. Re-copy the Bot User OAuth token (xoxb-...) and re-provision.'
    case 'not_in_channel':
      return 'The bot is not a member of this (public) channel. Invite it: /invite @<bot> in that channel.'
    case 'channel_not_found':
      return (
        'The bot cannot see this channel. If it is private, invite the bot (/invite @<bot>) — a private ' +
        'channel the bot has not joined reads as "not found". Otherwise the channel id is wrong (re-copy it ' +
        "from the channel's About tab), or the channel lives in a different workspace than the bot token."
      )
    case 'missing_scope':
      return 'The bot is missing the chat:write scope. Add it in the Slack app config and reinstall the app.'
    default:
      return null
  }
}

/* Runs a Slack Web API call and, on failure, rethrows with an actionable hint. The
   @slack/web-api client throws a WebAPIPlatformError (rather than returning { ok: false })
   whose `data.error` holds the Slack error code, so the code — and its fix — has to be
   pulled out of the thrown error here, not read off a return value. */
async function callSlack<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const code = (err as { data?: { error?: string } })?.data?.error
    const hint = hintForSlackError(code)
    const detail = code ?? (err instanceof Error ? err.message : String(err))
    throw new Error(`Slack ${label} failed: ${detail}${hint ? `\n  → ${hint}` : ''}`)
  }
}

interface ResolvedTarget {
  conversationId: string
  botToken: string
  channel: string
  workspace?: string
}

/* Resolves the Slack adapter to probe: either the one on --conversation, or the one on
   the active Number Cruncher agent's conversation (the same lookup the conversationCost
   job uses to decide whether NC will handle a card). */
async function resolveTarget(conversationOverride?: string): Promise<ResolvedTarget> {
  let conversationId = conversationOverride

  if (!conversationId) {
    const nc = await Agent.findOne({ agentType: 'numberCruncher', active: true }).exec()
    if (!nc) {
      throw new Error(
        'No active numberCruncher agent found. Provision Number Cruncher first (see SETUP.md), ' +
          'or pass --conversation=<id> to probe a specific conversation.'
      )
    }
    conversationId = nc.conversation.toString()
  }

  const adapter = await Adapter.findOne({ conversation: conversationId, type: 'slack' }).exec()
  if (!adapter) {
    throw new Error(`No Slack adapter found for conversation ${conversationId}.`)
  }
  const cfg = (adapter.config ?? {}) as Record<string, string>
  if (!cfg.botToken) throw new Error(`Slack adapter for ${conversationId} has no botToken in its config.`)
  if (!cfg.channel) throw new Error(`Slack adapter for ${conversationId} has no channel in its config.`)

  return { conversationId, botToken: cfg.botToken, channel: cfg.channel, workspace: cfg.workspace }
}

async function main() {
  const conversationOverride = process.argv.find((a) => a.startsWith('--conversation='))?.split('=')[1]
  const authOnly = process.argv.includes('--auth-only')
  const isPrivate = process.argv.includes('--private')
  const dryRun = process.argv.includes('--dry-run')

  mongoose.set('strict', true)
  await mongoose.connect(config.mongoose.url, config.mongoose.options)
  console.log('Connected to MongoDB.')

  try {
    const target = await resolveTarget(conversationOverride)
    console.log(`Target conversation: ${target.conversationId}`)
    console.log(`Slack channel:       ${target.channel}${target.workspace ? ` (workspace ${target.workspace})` : ''}`)
    console.log(`Bot token:           ${target.botToken.slice(0, 8)}…${target.botToken.slice(-4)}`)

    const data = sampleCostData(isPrivate)
    const blocks = renderResponseBlocks('conversationCostSummary', data)
    if (!blocks?.length) throw new Error('Cost card renderer returned no blocks — the render path is broken.')
    console.log(
      `Rendered sample cost card: ${blocks.length} Block Kit blocks${isPrivate ? ' (private-topic redaction on)' : ''}.`
    )

    if (dryRun) {
      console.log('\n✔ Dry run: credentials resolved and card rendered. No Slack calls made.')
      return
    }

    const slack = new WebClient(target.botToken)

    const auth = await callSlack('auth.test', () => slack.auth.test())
    console.log(`\n✔ Token valid — bot "${auth.user}" (${auth.user_id}) in "${auth.team}" (${auth.url}).`)

    if (authOnly) {
      console.log('\n✔ --auth-only: token check passed. Nothing posted.')
      return
    }

    const fallback = `Number Cruncher Slack setup check: sample cost card (~$${data.total.estimatedCostUSD.toFixed(
      2
    )}). Not a real event.`
    const result = await callSlack('chat.postMessage', () =>
      slack.chat.postMessage({ channel: target.channel, text: fallback, blocks })
    )
    console.log(`\n✔ Sample cost card posted to ${target.channel} (ts ${result.ts}). Check the channel in Slack.`)
    console.log('  If you can see the card, the Number Cruncher Slack integration is working.')
  } finally {
    await mongoose.connection.close()
    console.log('\nConnection closed.')
  }
}

// Only connect and run when invoked directly, so importing this module (e.g. in a test)
// does not open a database connection or exit the process. process.exit is called only
// out here (never in main's finally) so a thrown error still reaches the catch and exits
// non-zero, rather than a finally-block exit(0) masking the failure.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`\n✗ ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    })
}
