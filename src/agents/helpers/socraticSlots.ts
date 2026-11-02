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
  /\b(found|showed|fell|falls?|falling|rose|rises?|rising|recovered|recovers?|recovering|led to|caused|reduces?|reduced|increases?|increased|dropped|declined?|declining|drop|drops|dropped|hurt|hurts|harm|harms|lower|lowers|less|more|crowd|crowds|crowding|crowded)\b/i

/** The words added for the concept slot; a term the passage itself coins in quotes may contain them. */
const OUTCOME_ONLY_WORDS =
  /\b(drop|drops|dropped|hurt|hurts|harm|harms|lower|lowers|less|more|crowd|crowds|crowding|crowded)\b/gi

// A sentence that reports a quantity or comparison: numbers (not bare years), number words, comparatives.
const QUANTITY_SENTENCE =
  /\b(?!(?:19|20)\d\d\b)\d+|%|\b(one|two|three|four|five|six|seven|eight|nine|ten|third|half|quarter|fifth|twice|double|percent|more|less|fewer|higher|lower|better|worse|than)\b/i

// Outcome-ish words: past-participle forms and comparatives. Gerunds are left out because they
// are common in plain terms ("posting quotas").
const OUTCOME_WORD = /^(\w{3,}ed|more|less|fewer|higher|lower|better|worse)$/i

export function escapeRegExp(s: string): string {
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

/** True when the passage itself puts `concept` in quotation marks, i.e. it is a coined term. */
function isQuotedTerm(concept: string, passage: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`["'“‘]${escapeRegExp(concept)}["'”’]`, 'i').test(passage)
}

/**
 * A concept must name the passage's topic, not an outcome. Reject it when it carries an outcome
 * word, or shares an outcome-ish word (verb/adjective form) with a sentence that reports a
 * quantity or comparison. A term the passage coins in quotes is exempt from both extras.
 */
export function conceptLooksLikeFinding(concept: string, passage: string): string | null {
  if (FINDING_VERBS_PATTERN.test(concept.replace(OUTCOME_ONLY_WORDS, ' '))) return 'concept contains a finding verb'
  if (isQuotedTerm(concept, passage)) return null
  if (FINDING_VERBS_PATTERN.test(concept)) return 'concept contains a finding verb'
  // Header lines ("Source ID: 0", "Title: ... (2024)") are metadata, not claims.
  const quantitySentences = passage
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !/^\s*(Source ID|Title):/i.test(sentence) && QUANTITY_SENTENCE.test(sentence))
  const shared = (concept.match(/[\p{L}'-]+/gu) ?? []).find(
    (word) => OUTCOME_WORD.test(word) && quantitySentences.some((sentence) => countWordUses(word, [sentence]) > 0)
  )
  return shared ? 'concept shares a result word with a sentence that reports a quantity' : null
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
  if (!context.passage.toLowerCase().includes(concept.toLowerCase())) {
    return { ok: false, reason: 'concept is not in the retrieved passage' }
  }
  const findingReason = conceptLooksLikeFinding(concept, context.passage)
  if (findingReason) return { ok: false, reason: findingReason }

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
