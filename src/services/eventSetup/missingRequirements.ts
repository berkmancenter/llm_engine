import { ConversationType } from '../../types/index.types.js'

/**
 * Lists what's still missing before this conversation can run (e.g. a Zoom link, a Topic). Same
 * rules as lifecycle.ts's isConversationDraft check, just broken out by name instead of one
 * true/false, so the email can say exactly what's missing.
 *
 * Its own module, rather than living in (and being imported from) emailSetup.service.ts, so
 * organizerConfirmation.service.ts can use it too without emailSetup.service.ts needing to
 * import back from organizerConfirmation.service.ts for anything else and create a cycle.
 */
const missingRequirements = (
  conversation: { topic?: unknown; properties?: Record<string, unknown> },
  conversationType?: ConversationType
): string[] => {
  const missing: string[] = []
  if (!conversation.topic) missing.push('a series')
  ;(conversationType?.properties ?? []).forEach((property) => {
    if (!property.required) return
    const value = conversation.properties?.[property.name] ?? property.default
    if (value === undefined || value === null || value === '') missing.push(property.label ?? property.name)
  })
  return missing
}

export default missingRequirements
