import * as fuzzball from 'fuzzball'

export type CanonicalField = 'firstName' | 'lastName' | 'email' | 'bio' | 'interests'

/* Higher than the >=70 threshold used elsewhere in this codebase (e.g.
   src/services/webhook.service.ts): that convention matches full names/usernames, which
   are long enough that unrelated strings rarely score that high. Header labels are much
   shorter, so short/generic ones collide more easily — "Family Name" vs "Full Name"
   scores 70 despite being different columns — and misrouting a whole column silently
   produces wrong data, unlike a missed moderator-name match. */
const FUZZY_MATCH_THRESHOLD = 80

// Alias labels per canonical field, already normalized the way normalizeHeader() would
// normalize an incoming header. Real exports vary in wording as well as casing/spacing
// ("E-mail Address", "first_name", "Areas of Interest"), so each field lists the common
// phrasings seen in practice; anything that still doesn't match falls through to a fuzzy
// comparison against these same labels.
// Deliberately no short abbreviations here ("fname", "lname"): short strings score high
// against unrelated short strings under fuzzy matching (e.g. "fname" vs "Full Name" scores
// above threshold), so they'd risk mismatching an unrelated column. A genuine "fname"/"lname"
// header still matches "firstname"/"lastname" above via the fuzzy fallback on its own.
const FIELD_ALIASES: Record<CanonicalField, string[]> = {
  firstName: ['first name', 'firstname', 'given name'],
  lastName: ['last name', 'lastname', 'surname', 'family name'],
  email: ['email', 'email address', 'e mail', 'e mail address'],
  bio: ['bio', 'biography', 'about'],
  interests: ['interests', 'interest', 'areas of interest', 'topics']
}

// Required to build a member record; bio/interests are optional and stored empty if unmapped.
const REQUIRED_FIELDS: CanonicalField[] = ['firstName', 'lastName', 'email']

// Trim/lowercase/collapse punctuation-and-whitespace so "First Name ", "first_name", and
// "FIRST-NAME" all normalize to the same string before matching against FIELD_ALIASES.
export const normalizeHeader = (header: string): string =>
  header
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

export interface HeaderMatchResult {
  // raw header text -> canonical field it maps to
  fieldByHeader: Map<string, CanonicalField>
  unmatchedRequired: CanonicalField[]
}

// Maps a CSV's raw header row to canonical fields: exact alias match first (after
// normalizing), then a fuzzy fallback for headers whose wording doesn't hit an alias
// exactly. A canonical field claims at most one header (the best-scoring one), and a
// header claimed by one field can't also match another.
export const matchHeaders = (rawHeaders: string[]): HeaderMatchResult => {
  const headers = rawHeaders.map((raw) => ({ raw, normalized: normalizeHeader(raw) }))
  const fieldByHeader = new Map<string, CanonicalField>()
  const claimed = new Set<string>()
  const canonicalFields = Object.keys(FIELD_ALIASES) as CanonicalField[]

  canonicalFields.forEach((field) => {
    const hit = headers.find((h) => !claimed.has(h.raw) && FIELD_ALIASES[field].includes(h.normalized))
    if (hit) {
      fieldByHeader.set(hit.raw, field)
      claimed.add(hit.raw)
    }
  })

  canonicalFields
    .filter((field) => ![...fieldByHeader.values()].includes(field))
    .forEach((field) => {
      let best: { raw: string; score: number } | undefined
      headers
        .filter((h) => !claimed.has(h.raw))
        .forEach((h) => {
          const score = Math.max(...FIELD_ALIASES[field].map((alias) => fuzzball.ratio(h.normalized, alias)))
          if (score >= FUZZY_MATCH_THRESHOLD && (!best || score > best.score)) {
            best = { raw: h.raw, score }
          }
        })
      if (best) {
        fieldByHeader.set(best.raw, field)
        claimed.add(best.raw)
      }
    })

  const matchedFields = new Set(fieldByHeader.values())
  const unmatchedRequired = REQUIRED_FIELDS.filter((field) => !matchedFields.has(field))

  return { fieldByHeader, unmatchedRequired }
}
