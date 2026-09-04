import type { KnownBlock } from '@slack/types'
import { AppHomeData, AppHomeFeature } from '../../../../types/index.types.js'

/* Slack rejects a published view carrying more than 100 blocks. Each feature costs one
   block, so the list is capped with room left for the surrounding page furniture. */
const MAX_BLOCKS = 100
const PAGE_FURNITURE_BLOCKS = 12

function featureSection(feature: AppHomeFeature): KnownBlock {
  const lines = [`*${feature.label}*`, feature.description]
  /* Slack's mrkdwn renders "> " as an indented quote, which sets the example questions
     apart from the description without needing a separate block per question. */
  for (const question of feature.starterQuestions) {
    lines.push(`> _${question}_`)
  }
  return { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }
}

function section(text: string): KnownBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } }
}

/**
 * Lays out the Slack App Home page for a community assistant deployment.
 *
 * Pure layout: every string arrives finished from
 * `agents/communityAssistant/appHomeContent.ts`, already filtered to what the
 * deployment has, so a group with nothing in it drops its heading too.
 */
export default function renderAppHomePage(data: AppHomeData): KnownBlock[] {
  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: data.headline, emoji: true } },
    section(data.intro)
  ]

  if (data.features.length > 0) {
    blocks.push({ type: 'divider' }, section(`*${data.featuresHeading}*`))
    for (const feature of data.features.slice(0, MAX_BLOCKS - PAGE_FURNITURE_BLOCKS)) {
      blocks.push(featureSection(feature))
    }
  }

  if (data.notices.length > 0) {
    blocks.push(
      { type: 'divider' },
      section(`*${data.noticesHeading}*`),
      section(data.notices.map((notice) => `• ${notice}`).join('\n'))
    )
  }

  if (data.reachLines.length > 0) {
    blocks.push({ type: 'divider' }, section(`*${data.reachHeading}*`), section(data.reachLines.join('\n\n')))
  }

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: data.footer }] })

  return blocks
}
