import { escapeRegExp, FINDING_VERBS_PATTERN, SocraticSlots } from './socraticSlots.js'
import { contentWordOverlap } from './textOverlap.js'

export const MAX_QUESTION_WORDS = 40
export const MAX_REPEAT_OVERLAP = 0.5
const NGRAM_SIZE = 4

// Analogies and hypotheticals of the writer's own: the goal forbids inventing them.
export const ANALOGY_PATTERN = /\b(imagine|think of a|is (this|that|it) like|as if|suppose|what if|picture a)\b/i

export interface SocraticCheckContext {
  slots: SocraticSlots
  passage: string
  participantNames: string[]
  recentPosts: string[]
}

/** Names the source may be referred to by: the full label, or its surname when it is a short name. */
function sourceNameVariants(label: string): string[] {
  const tokens = label.split(/\s+/).filter(Boolean)
  const variants = [label]
  if (tokens.length >= 2 && tokens.length <= 3) variants.push(tokens[tokens.length - 1])
  return variants.filter((v) => v.replace(/\W/g, '').length >= 3)
}

function normalizeQuotes(s: string): string {
  return s.replace(/[“”„]/g, '"').replace(/[‘’]/g, "'")
}

function removeSlots(text: string, slots: SocraticSlots): string {
  let out = text
  for (const slot of [slots.concept, ...sourceNameVariants(slots.sourceLabel), slots.loadedWord ?? '']) {
    if (!slot) continue
    // eslint-disable-next-line security/detect-non-literal-regexp
    out = out.replace(new RegExp(escapeRegExp(slot), 'gi'), ' | ')
  }
  return out
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}'|-]+/gu) ?? []
}

function passageGrams(passage: string): Set<string> {
  const t = tokenize(passage)
  const grams = new Set<string>()
  for (let i = 0; i + NGRAM_SIZE <= t.length; i++) grams.add(t.slice(i, i + NGRAM_SIZE).join(' '))
  return grams
}

/** Returns the first n-gram of the (slot-stripped) text that is copied from the passage, if any. */
export function findCopiedNgram(text: string, passage: string, slots: SocraticSlots): string | null {
  const t = tokenize(removeSlots(text, slots))
  const grams = passageGrams(passage)
  for (let i = 0; i + NGRAM_SIZE <= t.length; i++) {
    const window = t.slice(i, i + NGRAM_SIZE)
    if (window.includes('|')) continue
    // all-function-word runs ("what do you think") are not copying
    if (window.filter((w) => w.length >= 4).length < 2) continue
    if (grams.has(window.join(' '))) return window.join(' ')
  }
  return null
}

/**
 * Deterministic shape checks for a socratic question. Returns generic, passage-free reasons (they
 * are safe to hand back to the writer, which must never see the passage); empty means it passed.
 */
export function checkSocraticShape(rawText: string, ctx: SocraticCheckContext): string[] {
  const text = normalizeQuotes(rawText.trim())
  const { slots } = ctx
  const reasons: string[] = []

  if ((text.match(/\?/g) ?? []).length !== 1 || !text.endsWith('?')) {
    reasons.push('it must contain exactly one question mark, at the very end')
  }
  if (text.split(/\s+/).filter(Boolean).length > MAX_QUESTION_WORDS) {
    reasons.push(`it must be at most ${MAX_QUESTION_WORDS} words`)
  }
  const lower = text.toLowerCase()
  if (!sourceNameVariants(slots.sourceLabel).some((v) => lower.includes(v.toLowerCase()))) {
    reasons.push(`it must name the source ("${slots.sourceLabel}")`)
  }
  if (slots.loadedWord && !lower.includes(`"${slots.loadedWord.toLowerCase()}"`)) {
    reasons.push(`it must quote the word "${slots.loadedWord}" in double quotes`)
  }
  const nameHit = ctx.participantNames.find(
    // eslint-disable-next-line security/detect-non-literal-regexp
    (n) => n.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, 'iu').test(text)
  )
  if (nameHit) reasons.push('it must not name any participant')
  if (ANALOGY_PATTERN.test(text)) reasons.push('it must not use analogies or hypotheticals')

  const stripped = removeSlots(text, slots)
  if (/\d/.test(stripped)) reasons.push('it must not contain numbers')
  if (FINDING_VERBS_PATTERN.test(stripped)) reasons.push('it must not use verbs that report an outcome')
  if (findCopiedNgram(text, ctx.passage, slots)) reasons.push('it must not copy wording from the source')

  // eslint-disable-next-line security/detect-non-literal-regexp
  const sourceIgnore = new RegExp(
    sourceNameVariants(slots.sourceLabel)
      .flatMap((v) => v.toLowerCase().match(/[a-z'-]{4,}/g) ?? [])
      .map(escapeRegExp)
      .join('|') || '$^',
    'i'
  )
  if (ctx.recentPosts.some((p) => contentWordOverlap(p, text, sourceIgnore) > MAX_REPEAT_OVERLAP)) {
    reasons.push('it repeats an earlier post; ask about something different')
  }
  return reasons
}

function sourcePhrase(label: string): string {
  return label.split(/\s+/).length > 3 ? `'${label}'` : label
}

/** Fallback question built only from validated slots; no model involved. */
export function renderSocraticTemplate(slots: SocraticSlots): string {
  const source = sourcePhrase(slots.sourceLabel)
  return slots.loadedWord
    ? `When we say "${slots.loadedWord}", would ${source} mean the same thing by it?`
    : `How does ${source} treat ${slots.concept}, and does that fit what we're describing?`
}
