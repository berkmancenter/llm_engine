import { Triggers } from '../../types/index.types.js'

/**
 * No automatic chat triggers yet. The vibes analyst reacts only to the
 * conversation-stopped event (wired in a later phase), so it stays silent to
 * chat for now. Per-message Q&A triggers arrive in Phase 5.
 */
const defaultTriggers: Triggers = {}

export default defaultTriggers
