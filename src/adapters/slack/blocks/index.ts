import type { KnownBlock } from '@slack/types'
import { CuratedVibesData } from '../../../types/index.types.js'
import renderCuratedVibesCard from './vibesAnalyst/curatedCard.js'

/* Maps an agent response's responseKind to the renderer that turns its neutral
   renderData into Slack Block Kit. Add an entry here when an agent introduces a
   new kind of card; individual metrics live inside each renderer, not here. */
const renderers: Record<string, (renderData: unknown) => KnownBlock[]> = {
  curatedVibesSummary: (renderData) => renderCuratedVibesCard(renderData as CuratedVibesData)
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
