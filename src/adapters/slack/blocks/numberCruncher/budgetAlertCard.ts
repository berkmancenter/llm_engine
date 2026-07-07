import type { KnownBlock } from '@slack/types'
import type { BudgetAlert, BudgetAlertData } from '../../../../types/index.types.js'

function formatAmount(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function buildProgressBar(percent: number): string {
  const filled = Math.round(percent / 10)
  const empty = 10 - filled
  return '█'.repeat(filled) + '░'.repeat(empty)
}

function buildAlertRow(alert: BudgetAlert): string {
  const bar = buildProgressBar(alert.percentUsed)
  return `*${alert.label}*\n${bar} ${Math.round(alert.percentUsed)}% used ($${formatAmount(alert.used)} / $${formatAmount(
    alert.limit
  )})`
}

/**
 * Renders a budget alert into Slack Block Kit blocks. Each alert gets its own
 * section with a simple text progress bar showing percent used vs. the threshold.
 * Only budgets that exceeded the configured threshold are included — callers
 * filter before passing data here.
 */
export default function renderBudgetAlertCard(data: BudgetAlertData): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':warning: Budget Alert', emoji: true }
    }
  ]

  for (const alert of data.alerts) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: buildAlertRow(alert) }
    })
  }

  blocks.push({ type: 'divider' })

  const checkedAt = new Date(data.checkedAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  })
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Checked at ${checkedAt}` }]
  })

  return blocks
}
