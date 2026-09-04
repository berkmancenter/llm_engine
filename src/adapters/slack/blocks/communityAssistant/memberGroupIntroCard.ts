import type { KnownBlock } from '@slack/types'

export default function renderMemberGroupIntroCard(renderData: { text: string }): KnownBlock[] {
  return [
    { type: 'divider' },
    {
      type: 'header',
      text: { type: 'plain_text', text: '✦ Member Spotlight', emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: renderData.text }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '✦ community connections' }]
    }
  ]
}
