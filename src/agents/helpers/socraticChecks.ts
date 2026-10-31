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

// Gendered pronouns: the writer has not read the source and cannot know which one is right.
const SOURCE_PRONOUNS = /\b(he|she|his|her|hers|him|himself|herself)\b/i

function removeQuoted(text: string): string {
  return text.replace(/"[^"]*"/g, ' ')
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

const SOURCE_NOUNS = 'source|reading|study|author|authors|paper|text|article|she|he|they'
// Present/past attributing verbs (and phrasal ones) that credit a subject with using a word.
const ATTRIBUTING_VERBS =
  'us(?:e|es|ed|ing)|defin(?:e|es|ed|ing)|describ(?:e|es|ed|ing)|discuss(?:es|ed|ing)?|treat(?:s|ed|ing)?|' +
  'say|says|said|saying|call(?:s|ed|ing)?|mean|means|meant|refer(?:s|red|ring)? to|characteri[sz](?:e|es|ed|ing)|' +
  'label(?:s|led|ed|ing)?|frame[sd]?|framing|interpret(?:s|ed|ing)?|regard(?:s|ed|ing)?|view(?:s|ed|ing)?|' +
  'consider(?:s|ed|ing)?|understand(?:s|ing)?|understood|employ(?:s|ed|ing)?|writ(?:e|es|ing)|wrote|' +
  'talk(?:s|ed|ing)? about|speak(?:s|ing)? of|spoke of'
const MODALS = /\b(would|could|might|may|can|should|will)\b/i
const WORD_ANAPHORA = /\b(that|this|the|such a|those|these) (term|word|phrase|label|wording|terms|words)\b/i

function sourceRefPattern(label: string): string {
  const names = sourceNameVariants(label).map(escapeRegExp)
  return `(?:${[...names, `(?:the |this |that |their )?(?:${SOURCE_NOUNS})(?:'s)?`].join('|')})`
}

function normalizeForQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Double-quoted spans of the draft that are not in the passage and sit in a clause where the source
 * is the subject of a present/past attributing verb (or the next clause says "that term" about it).
 * Such a draft credits the source with the group's own words; a modal ("would mean") is a question
 * about what the source would do and is allowed.
 */
export function findQuotedWordCreditedToSource(text: string, passage: string, label: string): string | null {
  const normPassage = ` ${normalizeForQuote(passage)} `
  const clauses = text.split(/[,;:]|\s+(?:and|but|while|whereas)\s+/i)
  // eslint-disable-next-line security/detect-non-literal-regexp
  const credit = new RegExp(
    `(?<![\\p{L}\\p{N}])${sourceRefPattern(
      label
    )}(?![\\p{L}\\p{N}])((?:\\s+[\\p{L}'-]+){0,3}?)\\s+(?:${ATTRIBUTING_VERBS})(?![\\p{L}\\p{N}])`,
    'iu'
  )
  let lastForeignQuote: string | null = null
  for (const clause of clauses) {
    const quotes = [...clause.matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((q) => normalizeForQuote(q) && !normPassage.includes(` ${normalizeForQuote(q)} `))
    const m = credit.exec(clause)
    // a modal before the verb makes it hypothetical; the clause may start with it ("would X mean")
    const credited = m !== null && !MODALS.test(clause.slice(0, m.index + m[0].length))
    if (credited && quotes.length > 0) return quotes[0]
    if (credited && lastForeignQuote && WORD_ANAPHORA.test(clause)) return lastForeignQuote
    if (quotes.length > 0) [lastForeignQuote] = quotes
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
  // Setting the group's word against a reading term smuggles in a presupposition about the reading.
  if (slots.loadedWord && lower.includes(slots.loadedWord.toLowerCase()) && lower.includes(slots.concept.toLowerCase())) {
    reasons.push('ask only about the quoted word; do not pair it with any other term')
  }
  if (SOURCE_PRONOUNS.test(removeQuoted(text))) {
    reasons.push('refer to the source only by its name; do not use he, she, his, her or him')
  }
  if (ANALOGY_PATTERN.test(text)) reasons.push('it must not use analogies or hypotheticals')

  if (findQuotedWordCreditedToSource(text, ctx.passage, slots.sourceLabel)) {
    reasons.push('do not credit the source with words from the room; ask whether the source would use that word')
  }

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
