import { PropertyFormat } from '../types/index.types.js'

/*
 * Named validators for a ConfigProperty's optional `format`. A format names a real check rather
 * than a regex, so security-sensitive rules parse the value the way the runtime will instead of
 * pattern-matching a raw string. Both the create path (resolver.validateProperties, which throws)
 * and the draft check (isConversationDraft, which flags for review) run these, so each rule lives
 * in one place and the two paths can never disagree.
 */

/**
 * True when the URL points at a Zoom host: zoom.us or a vanity subdomain like harvard.zoom.us.
 * Parses with the URL constructor so a spoof like https://zoom.us@evil.com resolves to its real
 * host (evil.com) and fails. Anything that isn't a parseable URL is invalid.
 */
export function isZoomUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false
  try {
    const { hostname } = new URL(url)
    return hostname === 'zoom.us' || hostname.endsWith('.zoom.us')
  } catch {
    return false
  }
}

/* Record over PropertyFormat, so adding a format name to the union without a validator here is a
   compile error rather than a silent pass. */
const propertyFormatValidators: Record<PropertyFormat, (value: unknown) => boolean> = {
  zoomUrl: isZoomUrl
}

/** Runs the validator for a property's declared format against a value. */
export function isValidPropertyFormat(format: PropertyFormat, value: unknown): boolean {
  return propertyFormatValidators[format](value)
}
