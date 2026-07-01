import { Triggers } from '../../types/index.types.js'

/**
 * The vibes analyst posts automatically when a public event stops (its
 * conversation-stopped handler). This per-message trigger additionally lets people
 * summon it in its own channel to recap a past public event on demand. It listens only
 * on its own channel; gating to genuine requests happens in evaluate and respond.
 */
const defaultTriggers: Triggers = {
  perMessage: { channels: ['vibesAnalyst'] }
}

export default defaultTriggers
