/*
 * Enforces the Chatham House Rule on a generated link statement before it is written into
 * an artifact that outlives the event: what was said may be used, but nothing may reveal
 * the identity or affiliation of anyone who took part.
 *
 * The prompt asks the model for this. This module is the backstop, because a prompt
 * instruction is a request and this is a privacy guarantee — the difference matters once
 * the output is persisted, versioned, and readable by anyone holding the artifact passcode.
 *
 * The rules, in the order they are checked:
 *
 *   1. Anything lifted verbatim from the record must sit inside quotation marks. An
 *      unmarked verbatim span reads as the summarizer's own words when it is really a
 *      participant's, which is exactly the confusion quotation marks exist to prevent.
 *   2. A quoted span must carry no identifying detail. If it does, the statement has to be
 *      rephrased rather than quoted.
 *   3. No statement, quoted or not, may name someone this conversation knows. A name in
 *      prose attributes just as effectively as a provenance field does.
 *
 * This is the exact half of the check. It matches a closed list — the pseudonyms, reserved
 * real names, presenters and moderators the conversation recorded — and catches identifier
 * patterns. It cannot recognise a name the system never recorded, or an affiliation that
 * identifies someone in a small room; nameScreen.ts covers that with a model, and the two
 * run together.
 *
 * Fail closed: a statement that trips any rule is dropped rather than published. Dropping
 * costs one sentence; publishing a name cannot be undone once an artifact version exists,
 * because versions are immutable.
 */

/* Long enough that ordinary shared phrasing ("we need to think about") does not read as a
   quotation, short enough to catch a lifted clause. Tuned against the false-positive side:
   a missed short quote is a style problem, a false positive silently deletes real content. */
const VERBATIM_SHINGLE_WORDS = 8

/*
 * Straight and curly quotation pairs, since transcripts and models produce both. Written as
 * literals rather than built from a delimiter list: a constructed RegExp would be one more
 * place to get escaping wrong, for no gain over four fixed patterns.
 *
 * The same-character pairs require a space inside the run, which is what stops the
 * apostrophe in "doesn't" from opening a quotation that swallows the rest of the sentence —
 * and with it, an unquoted lift that would then look safely quoted.
 */
const QUOTE_PATTERNS: RegExp[] = [/"([^"\n]*\s[^"\n]*)"/g, /'([^'\n]*\s[^'\n]*)'/g, /“([^”\n]+)”/g, /‘([^’\n]+)’/g]

const LONG_DIGIT_RUN = /(?<!\d)\d{7,}(?!\d)/

/*
 * Closes up separators sitting *between* two digits, so "555 018-2244" becomes one run
 * while "2024 - 2025" stays two.
 *
 * Done as a replace plus a flat quantifier rather than one regex over the raw text: the
 * natural pattern for this — a repeated optional-separator digit group — nests quantifiers
 * and backtracks catastrophically on a long digit string, and this runs over transcript
 * text that a participant can paste anything into.
 */
const compactDigitGroups = (text: string) => text.replace(/(?<=\d)[\s().-](?=\d)/g, '')

/*
 * The identifiers that can be matched precisely. Deliberately limited to those: names,
 * employers and locations are not reliably matchable, which is why the known-identity list
 * below and the model screen alongside it do that half of the work.
 */
const PII_CHECKS: { name: string; test: (text: string) => boolean }[] = [
  { name: 'email address', test: (t) => /[\w.+-]+@[\w-]+\.[\w.-]+/.test(t) },
  /* Seven or more digits once separators are closed up: phone, account and card numbers.
     Bounded by non-digits so a year or a small count does not trip it. */
  { name: 'phone or account number', test: (t) => LONG_DIGIT_RUN.test(compactDigitGroups(t)) },
  { name: 'social handle', test: (t) => /(?:^|\s)@[A-Za-z0-9_]{2,}/.test(t) },
  { name: 'URL', test: (t) => /https?:\/\/\S+/i.test(t) },
  {
    name: 'street address',
    test: (t) => /\b\d{1,5}\s+[A-Z][a-z]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr)\b/.test(t)
  }
]

export type ViolationKind = 'unquoted-verbatim' | 'pii-in-quote' | 'names-participant'

export interface StatementViolation {
  kind: ViolationKind
  detail: string
}

export interface StatementCheckInput {
  /* Verbatim text of every message the graph was built from. */
  sourceTexts: string[]
  /* Every name this conversation knows: participant pseudonyms, real names reserved in
     RealNameRegistry, and the presenters and moderators on the conversation record. Under
     the Chatham House Rule none of them may be revealed, however the event billed them. */
  knownIdentities: string[]
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const words = (text: string) => normalize(text).split(' ').filter(Boolean)

/** Every `size`-word run in the text, normalized, for overlap comparison. */
const shingles = (text: string, size: number): Set<string> => {
  const tokens = words(text)
  const out = new Set<string>()
  for (let i = 0; i + size <= tokens.length; i += 1) out.add(tokens.slice(i, i + size).join(' '))
  return out
}

/** The spans of a statement that sit inside quotation marks. See QUOTE_PATTERNS. */
export const quotedSpans = (statement: string): string[] => {
  const spans: string[] = []
  for (const pattern of QUOTE_PATTERNS) for (const match of statement.matchAll(pattern)) spans.push(match[1])
  return spans
}

/** The first shingle the statement shares with a source outside any quotation, if any. */
const verbatimOutsideQuotes = (statement: string, sourceTexts: string[]): string | null => {
  const statementShingles = shingles(statement, VERBATIM_SHINGLE_WORDS)
  if (statementShingles.size === 0) return null

  const quotedShingles = new Set<string>()
  for (const span of quotedSpans(statement)) {
    for (const shingle of shingles(span, VERBATIM_SHINGLE_WORDS)) quotedShingles.add(shingle)
  }

  for (const source of sourceTexts) {
    const sourceShingles = shingles(source, VERBATIM_SHINGLE_WORDS)
    if (sourceShingles.size === 0) continue
    for (const shingle of statementShingles) {
      if (sourceShingles.has(shingle) && !quotedShingles.has(shingle)) return shingle
    }
  }
  return null
}

/** The first identifier pattern the text matches, if any. */
export const piiPatternIn = (text: string): string | null => {
  for (const { name, test } of PII_CHECKS) if (test(text)) return name
  return null
}

/* Word-boundary match on the normalized forms, so "Bold Aardvark" is caught inside a
   sentence but "Sam" does not fire on "same". A very short identity is skipped: matching it
   would delete far more real content than it protects. */
const identityIn = (text: string, knownIdentities: string[]): string | null => {
  const haystack = ` ${normalize(text)} `
  for (const identity of knownIdentities) {
    const needle = normalize(identity)
    if (needle.length < 3) continue
    if (haystack.includes(` ${needle} `)) return identity
  }
  return null
}

/**
 * Checks one generated statement against all three rules.
 *
 * @returns every violation found, empty when the statement is safe to publish.
 */
export const checkStatement = (statement: string, { sourceTexts, knownIdentities }: StatementCheckInput) => {
  const violations: StatementViolation[] = []
  if (!statement?.trim()) return violations

  const lifted = verbatimOutsideQuotes(statement, sourceTexts)
  if (lifted) {
    violations.push({ kind: 'unquoted-verbatim', detail: `lifted without quotation marks: "${lifted}"` })
  }

  for (const span of quotedSpans(statement)) {
    const pattern = piiPatternIn(span)
    if (pattern) violations.push({ kind: 'pii-in-quote', detail: `quotation contains a ${pattern}` })
    const named = identityIn(span, knownIdentities)
    if (named) violations.push({ kind: 'pii-in-quote', detail: `quotation names ${named}` })
  }

  const named = identityIn(statement, knownIdentities)
  if (named) violations.push({ kind: 'names-participant', detail: `statement names ${named}` })

  return violations
}

export default { checkStatement, quotedSpans, piiPatternIn, VERBATIM_SHINGLE_WORDS }
