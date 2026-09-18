import { checkStatement, quotedSpans, piiPatternIn } from '../../../../src/services/conceptGraph/quoteSafety.js'

/* The Chatham House guarantee in test form. These are pure functions over text — no Mongo,
   no model — because this is the layer that has to hold deterministically. */

const SOURCE = [
  'I think the trust registry only matters if verifiers actually bother to check it before they accept anything',
  'My colleague Dana ran into this exact problem last quarter',
  'You can reach me at rosa.klein@example.org if you want the deck'
]

const safety = {
  sourceTexts: SOURCE,
  knownIdentities: ['Bold Aardvark', 'Rosa Klein', 'Dr. Amara Osei']
}

describe('quoted span detection', () => {
  it('finds straight and curly quoted spans', () => {
    expect(quotedSpans('They said "the registry is the point" and moved on')).toContain('the registry is the point')
    expect(quotedSpans('They said “the registry is the point”')).toContain('the registry is the point')
  })

  it('does not treat an apostrophe as an opening quote', () => {
    /* Otherwise a contraction swallows the rest of the sentence and an unquoted lift
       downstream looks safely quoted. */
    expect(quotedSpans("It doesn't matter who said it")).toHaveLength(0)
  })
})

describe('verbatim lifting', () => {
  it('rejects a long verbatim run with no quotation marks', () => {
    const statement = 'The trust registry only matters if verifiers actually bother to check it before they accept anything.'

    const violations = checkStatement(statement, safety)

    expect(violations.map((v) => v.kind)).toContain('unquoted-verbatim')
  })

  it('accepts the same words inside quotation marks', () => {
    const statement =
      'Participants pushed back, arguing "the trust registry only matters if verifiers actually bother to check it before they accept anything".'

    expect(checkStatement(statement, safety)).toEqual([])
  })

  it('accepts a genuine paraphrase of the same idea', () => {
    const statement = 'A registry is only worth maintaining if the parties relying on it actually consult it.'

    expect(checkStatement(statement, safety)).toEqual([])
  })

  it('does not fire on ordinary shared phrasing shorter than a lifted clause', () => {
    expect(checkStatement('We need to think about this differently.', safety)).toEqual([])
  })
})

describe('identities', () => {
  it('rejects a statement naming someone the conversation knows, quoted or not', () => {
    expect(checkStatement('Rosa Klein argued the registry was redundant.', safety).map((v) => v.kind)).toContain(
      'names-participant'
    )
    expect(checkStatement('One line stuck: "Rosa Klein is right about the registry".', safety).length).toBeGreaterThan(0)
  })

  it('rejects a pseudonym as readily as a real name', () => {
    expect(checkStatement('Bold Aardvark raised revocation.', safety).map((v) => v.kind)).toContain('names-participant')
  })

  it('matches on whole words, so a short name does not fire inside another word', () => {
    expect(checkStatement('The same problem came up again.', { sourceTexts: [], knownIdentities: ['Sam'] })).toEqual([])
  })
})

describe('identifier patterns inside quotations', () => {
  it.each([
    ['an email address', 'They wrote "you can reach me at rosa.klein@example.org for the deck".'],
    ['a phone number', 'Someone offered "just call 555 018 2244 and ask for the desk".'],
    ['a social handle', 'The line was "follow @registrywonk for the thread".'],
    ['a URL', 'They shared "see https://internal.example.org/deck for details".']
  ])('rejects a quotation containing %s', (_label, statement) => {
    const violations = checkStatement(statement, { sourceTexts: [], knownIdentities: [] })

    expect(violations.map((v) => v.kind)).toContain('pii-in-quote')
  })

  it('recognises identifiers directly', () => {
    expect(piiPatternIn('rosa.klein@example.org')).toBe('email address')
    expect(piiPatternIn('nothing identifying here')).toBeNull()
  })

  it('does not mistake a year or a small count for a phone number', () => {
    expect(piiPatternIn('by 2026 there were 12 registries')).toBeNull()
  })

  it('leaves an unquoted paraphrase of the same idea alone', () => {
    /* The rule is about republishing identifying detail, not about mentioning that contact
       details were exchanged. */
    expect(checkStatement('Contact details were swapped so the deck could be shared.', safety)).toEqual([])
  })
})

describe('empty input', () => {
  it('treats an empty statement as nothing to check', () => {
    expect(checkStatement('', safety)).toEqual([])
    expect(checkStatement('   ', safety)).toEqual([])
  })
})
