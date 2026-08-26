import { matchHeaders, normalizeHeader } from '../../../src/utils/csvHeaderMatcher.js'

describe('normalizeHeader', () => {
  test('trims, lowercases, and collapses punctuation/whitespace', () => {
    expect(normalizeHeader('  First_Name ')).toBe('first name')
    expect(normalizeHeader('E-Mail Address')).toBe('e mail address')
  })
})

describe('matchHeaders', () => {
  test('matches canonical headers exactly after normalizing', () => {
    const { fieldByHeader, unmatchedRequired } = matchHeaders(['First Name', 'Last Name', 'Email', 'Bio', 'Interests'])
    expect(fieldByHeader.get('First Name')).toBe('firstName')
    expect(fieldByHeader.get('Last Name')).toBe('lastName')
    expect(fieldByHeader.get('Email')).toBe('email')
    expect(fieldByHeader.get('Bio')).toBe('bio')
    expect(fieldByHeader.get('Interests')).toBe('interests')
    expect(unmatchedRequired).toEqual([])
  })

  test('matches headers real exports vary in casing, spacing, punctuation, and wording', () => {
    const { fieldByHeader, unmatchedRequired } = matchHeaders([
      'E-mail Address',
      'LAST NAME',
      'First Name ',
      'areas of interest',
      'Biography'
    ])
    expect(fieldByHeader.get('E-mail Address')).toBe('email')
    expect(fieldByHeader.get('LAST NAME')).toBe('lastName')
    expect(fieldByHeader.get('First Name ')).toBe('firstName')
    expect(fieldByHeader.get('areas of interest')).toBe('interests')
    expect(fieldByHeader.get('Biography')).toBe('bio')
    expect(unmatchedRequired).toEqual([])
  })

  test('falls back to fuzzy matching for headers not in the alias list', () => {
    const { fieldByHeader } = matchHeaders(['Emails', 'Given Names', 'Family Names'])
    expect(fieldByHeader.get('Emails')).toBe('email')
    expect(fieldByHeader.get('Given Names')).toBe('firstName')
    expect(fieldByHeader.get('Family Names')).toBe('lastName')
  })

  test('reports required fields it could not identify a column for', () => {
    const { unmatchedRequired } = matchHeaders(['Full Name', 'Contact', 'Notes'])
    expect(unmatchedRequired).toEqual(expect.arrayContaining(['firstName', 'lastName', 'email']))
  })

  test('a header is claimed by at most one field', () => {
    const { fieldByHeader } = matchHeaders(['Email', 'Bio'])
    expect([...fieldByHeader.values()]).toEqual(['email', 'bio'])
    expect(fieldByHeader.size).toBe(2)
  })
})
