import type { KnownBlock } from '@slack/types'
import { AppHomeData, AppHomeFeature } from '../../../../types/index.types.js'

/* Slack rejects a published view carrying more than 100 blocks, and a feature costs two of
   them once its questions are buttons, so the list is capped with room left for the
   surrounding page furniture. */
const MAX_BLOCKS = 100
const PAGE_FURNITURE_BLOCKS = 12
const BLOCKS_PER_CLICKABLE_FEATURE = 2
/* Slack rejects button text over 75 characters. The label is clipped to fit; the button's
   value keeps the whole question, so the assistant still answers what was asked. */
const MAX_BUTTON_TEXT = 75

function featureSection(feature: AppHomeFeature, questionsAreClickable: boolean): KnownBlock {
  const lines = [`*${feature.label}*`, feature.description]
  if (!questionsAreClickable) {
    /* Slack's mrkdwn renders "> " as an indented quote, which sets the example questions
       apart from the description without needing a separate block per question. */
    for (const question of feature.starterQuestions) {
      lines.push(`> _${question}_`)
    }
  }
  return { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }
}

function clip(question: string): string {
  return question.length <= MAX_BUTTON_TEXT ? question : `${question.slice(0, MAX_BUTTON_TEXT - 1)}…`
}

function questionButtons(feature: AppHomeFeature): KnownBlock {
  return {
    type: 'actions',
    elements: feature.starterQuestions.map((question, index) => ({
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: clip(question), emoji: true },
      /* The click handler feeds this value back in as if the reader had typed it, so it
         has to be the question itself rather than an identifier. */
      value: question,
      action_id: `app_home_starter_${feature.key}_${index}`
    }))
  }
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
    const featureBudget = Math.floor((MAX_BLOCKS - PAGE_FURNITURE_BLOCKS) / BLOCKS_PER_CLICKABLE_FEATURE)
    blocks.push({ type: 'divider' }, section(`*${data.featuresHeading}*`))
    for (const feature of data.features.slice(0, featureBudget)) {
      blocks.push(featureSection(feature, data.questionsAreClickable))
      if (data.questionsAreClickable && feature.starterQuestions.length > 0) {
        blocks.push(questionButtons(feature))
      }
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
    // Replace the raw channel ID token with Slack's mrkdwn channel link (<#C123> renders as the channel name).
    const reachLines = data.channelId
      ? data.reachLines.map((line) => line.replace(data.channelId!, `<#${data.channelId}>`))
      : data.reachLines
    blocks.push({ type: 'divider' }, section(`*${data.reachHeading}*`), section(reachLines.join('\n\n')))
  }

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: data.footer }] })

  return blocks
}
