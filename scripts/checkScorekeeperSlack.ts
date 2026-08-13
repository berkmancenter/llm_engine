#!/usr/bin/env node
/**
 * Smoke-tests the Scorekeeper's Slack integration end to end.
 *
 * Resolves the scorekeeper's Slack adapter, fetches real feedback scores
 * from LangSmith for the given conversation, renders the quality report card,
 * and posts it to Slack.
 *
 * Flags:
 *   --conversation=<id>         Required. The conversation that hosts the scorekeeper and Slack adapter.
 *   --target-conversation=<id>  Required. The conversation to fetch LangSmith scores for.
 *   --dry-run                   Fetch scores and render the card, but do not post to Slack.
 *
 * Usage:
 *   NODE_ENV=development node --loader ts-node/esm scripts/checkScorekeeperSlack.ts --conversation=<id> --target-conversation=<id>
 */
/* eslint-disable no-console */

import mongoose from 'mongoose'
import { pathToFileURL } from 'url'
import { WebClient } from '@slack/web-api'
import Conversation from '../src/models/conversation.model.js'
import config from '../src/config/config.js'
import Adapter from '../src/models/adapter.model.js'
import Agent from '../src/models/user.model/agent.model/index.js'
import renderResponseBlocks from '../src/adapters/slack/blocks/index.js'
import { fetchQualityScores } from '../src/agents/scorekeeper/fetchQualityScores.js'
import type { QualityReportData } from '../src/types/index.types.js'

async function main() {
  const conversationId = process.argv.find((a) => a.startsWith('--conversation='))?.split('=')[1]
  const targetConversationId = process.argv.find((a) => a.startsWith('--target-conversation='))?.split('=')[1]
  const dryRun = process.argv.includes('--dry-run')

  if (!conversationId || !targetConversationId) {
    console.error(
      'Usage: node --loader ts-node/esm scripts/checkScorekeeperSlack.ts --conversation=<id> --target-conversation=<id>'
    )
    process.exit(1)
  }

  mongoose.set('strict', true)
  await mongoose.connect(config.mongoose.url, config.mongoose.options)
  console.log('Connected to MongoDB.')

  try {
    const agent = await Agent.findOne({ agentType: 'scorekeeper', conversation: conversationId }).exec()
    if (!agent) {
      throw new Error(`No scorekeeper found for conversation ${conversationId}.`)
    }

    const adapter = await Adapter.findOne({ conversation: conversationId, type: 'slack' }).exec()
    if (!adapter) {
      throw new Error(`No Slack adapter found for conversation ${conversationId}.`)
    }
    const cfg = (adapter.config ?? {}) as Record<string, string>
    if (!cfg.botToken) throw new Error('Slack adapter has no botToken.')
    if (!cfg.channel) throw new Error('Slack adapter has no channel.')

    const targetConversation = await Conversation.findById(targetConversationId).select('name').lean()
    const conversationName = targetConversation?.name ?? targetConversationId

    console.log(`Fetching LangSmith scores for conversation ${conversationName} (${targetConversationId})…`)
    const scores = await fetchQualityScores(targetConversationId)
    if (!scores) {
      throw new Error(
        'No feedback scores found in LangSmith for this conversation. Is tracing enabled and are there scored traces?'
      )
    }
    console.log(
      `Found scores for ${scores.tracesScored} traces across ${
        scores.evaluators.length
      } evaluators. Overall: ${scores.overallMean.toFixed(2)}`
    )

    const renderData: QualityReportData = {
      conversationName,
      conversationId: targetConversationId,
      evaluators: scores.evaluators,
      overallMean: scores.overallMean,
      tracesScored: scores.tracesScored,
      lowScoreTraces: scores.lowScoreTraces,
      totalLowScoreCount: scores.totalLowScoreCount,
      generatedAt: new Date().toISOString()
    }

    const blocks = renderResponseBlocks('qualityReport', renderData)
    if (!blocks?.length) throw new Error('Quality report card renderer returned no blocks.')
    console.log(`Rendered quality report card: ${blocks.length} Block Kit blocks.`)

    if (dryRun) {
      console.log('\n✔ Dry run: scores fetched and card rendered. No Slack call made.')
      return
    }

    const slack = new WebClient(cfg.botToken)
    const result = await slack.chat.postMessage({
      channel: cfg.channel,
      text: `Quality report: overall ${scores.overallMean.toFixed(2)} across ${scores.tracesScored} traces`,
      blocks
    })
    console.log(`\n✔ Quality report card posted to ${cfg.channel} (ts ${result.ts}). Check the channel in Slack.`)
  } finally {
    await mongoose.connection.close()
    console.log('\nConnection closed.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`\n✗ ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    })
}
