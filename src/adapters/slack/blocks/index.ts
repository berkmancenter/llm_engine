import type { KnownBlock } from '@slack/types'
import { CuratedVibesData, BudgetAlertData, ConversationCostData, QualityReportData } from '../../../types/index.types.js'
import renderCuratedVibesCard from './vibesAnalyst/curatedCard.js'
import renderBudgetAlertCard from './numberCruncher/budgetAlertCard.js'
import renderConversationCostCard from './numberCruncher/conversationCostCard.js'
import renderQualityReportCard from './scorekeeper/qualityReportCard.js'
import renderMemberGroupIntroCard from './communityAssistant/memberGroupIntroCard.js'

/* Maps an agent response's responseKind to the renderer that turns its neutral
   renderData into Slack Block Kit. Add an entry here when an agent introduces a
   new kind of card; individual metrics live inside each renderer, not here. */
const renderers: Record<string, (renderData: unknown) => KnownBlock[]> = {
  curatedVibesSummary: (renderData) => renderCuratedVibesCard(renderData as CuratedVibesData),
  budgetAlert: (renderData) => renderBudgetAlertCard(renderData as BudgetAlertData),
  conversationCostSummary: (renderData) => renderConversationCostCard(renderData as ConversationCostData),
  qualityReport: (renderData) => renderQualityReportCard(renderData as QualityReportData),
  memberGroupIntro: (renderData) => renderMemberGroupIntroCard(renderData as { text: string })
}

/**
 * Looks up the renderer for a response's `responseKind` and renders its
 * `renderData` into Slack blocks. Returns undefined when there is no
 * `responseKind` or no renderer is registered for it, so the adapter falls back
 * to the message's plain text.
 */
export default function renderResponseBlocks(responseKind?: string, renderData?: unknown): KnownBlock[] | undefined {
  if (!responseKind) return undefined
  const renderer = renderers[responseKind]
  if (!renderer) return undefined
  return renderer(renderData)
}
