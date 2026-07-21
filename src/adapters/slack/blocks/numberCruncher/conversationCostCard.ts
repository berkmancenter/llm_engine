import type { KnownBlock } from '@slack/types'
import type { ConversationCostData } from '../../../../types/index.types.js'

function formatUSD(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/* Slack rejects header plain_text over 150 characters, so long event names are cut
   to fit rather than failing the whole message. */
const HEADER_MAX = 150

/**
 * Renders one stopped conversation's estimated LLM cost into Slack Block Kit:
 * headline combined estimate, a during/after phase breakdown, per-model and
 * per-agent breakdowns (from the combined total), and a footer that keeps the
 * "estimate, not invoice" caveat attached to every card.
 */
export default function renderConversationCostCard(data: ConversationCostData): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `:moneybag: Cost Summary: ${data.topicIsPrivate ? 'Private event' : data.conversationName}`.slice(
          0,
          HEADER_MAX
        ),
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*Estimated LLM cost: ~$${formatUSD(data.total.estimatedCostUSD)}*\n` +
          `${formatCount(data.total.llmCallCount)} LLM calls · ${formatCount(data.total.totalPromptTokens)} prompt + ` +
          `${formatCount(data.total.totalCompletionTokens)} completion tokens`
      }
    }
  ]

  // Phase breakdown: only mention "after it ended" when there was any such spend,
  // so an event with no post-event agent activity doesn't show a confusing $0 line.
  const phaseLines = [
    `• *During the event:* $${formatUSD(data.liveEvent.estimatedCostUSD)} (${data.liveEvent.llmCallCount} calls)`
  ]
  if (data.postEvent.llmCallCount > 0) {
    phaseLines.push(`• *After it ended:* $${formatUSD(data.postEvent.estimatedCostUSD)} (${data.postEvent.llmCallCount} calls)`)
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: phaseLines.join('\n') } })

  // A model with no LangSmith pricing-table entry (e.g. a self-hosted vLLM/Ollama
  // model) reports a real token count but no price — showing "$0.00" for it would
  // read as "this was free" rather than "we don't know", so the caveat and the
  // per-model "cost unknown" label keep that distinction visible.
  if (data.total.hasUnpricedCalls) {
    const unpricedCount = data.total.models.filter((m) => !m.priced).length
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:warning: ${unpricedCount} model${unpricedCount === 1 ? '' : 's'} could not be priced by LangSmith — the actual total is higher than shown.`
      }
    })
  }

  if (data.total.models.length > 0) {
    const rows = data.total.models.map(
      (m) =>
        `• *${m.model}* — ${formatCount(m.promptTokens)} prompt / ${formatCount(m.completionTokens)} completion · ${
          m.priced ? `$${formatUSD(m.estimatedCostUSD)}` : 'cost unknown'
        }`
    )
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*By model*\n${rows.join('\n')}` } })
  }

  if (data.total.agents.length > 0) {
    const rows = data.total.agents.map((a) => `• *${a.agentType}* — ${a.llmCalls} calls · $${formatUSD(a.estimatedCostUSD)}`)
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*By agent*\n${rows.join('\n')}` } })
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
    elements: [{ type: 'mrkdwn', text: `LangSmith estimate — actual provider charges may differ · Checked at ${checkedAt}` }]
  })

  return blocks
}
