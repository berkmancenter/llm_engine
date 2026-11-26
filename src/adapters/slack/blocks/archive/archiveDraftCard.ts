import type { KnownBlock } from '@slack/types'

export interface ArchiveDraftCardData {
  title: string
  date: string
  /** The `event-<hash>` slug of the draft in the archive inbox. */
  draftId: string
}

/** Escapes the characters Slack mrkdwn treats as control sequences. */
function escapeMrkdwn(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Plain-text fallback Slack uses for notifications and accessibility. */
export function archiveDraftCardText(data: ArchiveDraftCardData) {
  return `New archive draft ready for curator review: ${truncate(data.title, 200)} (${data.date}), draft ${data.draftId}`
}

/**
 * Renders the curator notice for a newly created archive draft. Identity only:
 * the summary, participants and other draft content stay in the archive inbox.
 */
export default function renderArchiveDraftCard(data: ArchiveDraftCardData): KnownBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'New archive draft ready for review', emoji: true }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Event*\n${escapeMrkdwn(truncate(data.title, 200))}` },
        { type: 'mrkdwn', text: `*Date*\n${escapeMrkdwn(data.date)}` },
        { type: 'mrkdwn', text: `*Draft ID*\n\`${escapeMrkdwn(data.draftId)}\`` }
      ]
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Waiting for curator review in the archive inbox.' }]
    }
  ]
}
