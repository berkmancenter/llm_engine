/**
 * Slots the decision call fills in alongside a socratic_probe choice. The message itself is written
 * separately from these slots (see socraticQuestionWriter), so each slot is validated in code before
 * it is trusted.
 */
export interface SocraticSlots {
  sourceLabel: string
  concept: string
  loadedWord: string | null
}

export interface SocraticResourceRef {
  title?: string
  authors?: string[]
  citation?: string
}

export type SocraticSlotResult = { ok: true; slots: SocraticSlots } | { ok: false; reason: string }

export const MAX_CONCEPT_WORDS = 6
const MIN_LOADED_WORD_USES = 2

/** Verbs that report what a study found; they must not appear in the concept slot or the question. */
export const FINDING_VERBS_PATTERN =
  /\b(found|showed|fell|falls?|falling|rose|rises?|rising|recovered|recovers?|recovering|led to|caused|reduces?|reduced|increases?|increased|dropped|declined?|declining)\b/i

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length
}

function clean(value: unknown): string {
  return typeof value === 'string'
    ? value
        .trim()
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .trim()
    : ''
}

/** The decision model often copies a whole citation; keep the part that names the source. */
function normalizeSourceLabel(raw: string): string {
  const noYear = raw
    .replace(/\(\s*\d{4}[a-z]?\s*\)|\b\d{4}[a-z]?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const lead = noYear.split(/,|\.\s/)[0].trim()
  return clean(lead.length >= 3 ? lead : noYear)
}

function sourceMatchesResources(label: string, passage: string, resources: SocraticResourceRef[]): boolean {
  const needle = label.toLowerCase()
  if (needle.length < 3) return false
  if (passage.toLowerCase().includes(needle)) return true
  return resources.some((r) =>
    [r.title, r.citation, ...(r.authors ?? [])].some((candidate) => {
      const hay = candidate?.toLowerCase()
      return Boolean(hay) && hay!.includes(needle)
    })
  )
}

/** Number of whole-word occurrences of `word` across the given chat lines. */
export function countWordUses(word: string, lines: string[]): number {
  // eslint-disable-next-line security/detect-non-literal-regexp
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'giu')
  return lines.reduce((n, line) => n + (line.match(pattern)?.length ?? 0), 0)
}

/**
 * A bad concept or source makes the whole result invalid (the caller stays silent); a loaded word
 * that the group has not actually repeated is simply dropped.
 */
export function validateSocraticSlots(
  raw: { sourceLabel?: unknown; concept?: unknown; loadedWord?: unknown },
  context: { passage: string; resources: SocraticResourceRef[]; humanChatLines: string[] }
): SocraticSlotResult {
  const concept = clean(raw.concept)
  if (!concept) return { ok: false, reason: 'concept missing' }
  if (wordCount(concept) > MAX_CONCEPT_WORDS) return { ok: false, reason: 'concept too long' }
  if (/\d/.test(concept)) return { ok: false, reason: 'concept contains digits' }
  if (FINDING_VERBS_PATTERN.test(concept)) return { ok: false, reason: 'concept contains a finding verb' }
  if (!context.passage.toLowerCase().includes(concept.toLowerCase())) {
    return { ok: false, reason: 'concept is not in the retrieved passage' }
  }

  const sourceLabel = normalizeSourceLabel(clean(raw.sourceLabel))
  if (!sourceLabel) return { ok: false, reason: 'sourceLabel missing' }
  if (!sourceMatchesResources(sourceLabel, context.passage, context.resources)) {
    return { ok: false, reason: 'sourceLabel matches no reading' }
  }

  let loadedWord: string | null = clean(raw.loadedWord) || null
  if (loadedWord && (wordCount(loadedWord) > 3 || /["?]/.test(loadedWord))) loadedWord = null
  if (loadedWord && countWordUses(loadedWord, context.humanChatLines) < MIN_LOADED_WORD_USES) loadedWord = null

  return { ok: true, slots: { sourceLabel, concept, loadedWord } }
}
