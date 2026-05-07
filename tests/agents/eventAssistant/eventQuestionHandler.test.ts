import { buildParticipantNamesContext } from '../../../src/agents/eventAssistant/eventQuestionHandler.js'

describe('buildParticipantNamesContext', () => {
  it('returns empty string when conversation has no presenters or moderators specified', () => {
    const conversation = { presenters: [], moderators: [] }
    expect(buildParticipantNamesContext(conversation)).toBe('')
  })

  it('returns empty string when presenters and moderators are undefined', () => {
    const conversation = {}
    expect(buildParticipantNamesContext(conversation)).toBe('')
  })

  it('includes presenter with canonical name', () => {
    const conversation = {
      presenters: [{ name: 'Jonathan Smith', bio: 'Climate researcher.' }],
      moderators: []
    }
    const result = buildParticipantNamesContext(conversation)
    expect(result).toContain('Jonathan Smith')
    expect(result).toContain('Speaker')
    expect(result).toContain('Climate researcher.')
  })

  it('includes also known as when alternateName is set on a presenter', () => {
    const conversation = {
      presenters: [{ name: 'Jonathan Smith', alternateName: 'Jon', bio: 'Climate researcher.' }],
      moderators: []
    }
    const result = buildParticipantNamesContext(conversation)
    expect(result).toContain('Jonathan Smith (also known as "Jon")')
  })

  it('omits also known as when alternateName is not set on a presenter', () => {
    const conversation = {
      presenters: [{ name: 'Jonathan Smith', bio: 'Climate researcher.' }],
      moderators: []
    }
    const result = buildParticipantNamesContext(conversation)
    expect(result).not.toContain('also known as')
  })

  it('includes moderator with canonical name', () => {
    const conversation = {
      presenters: [],
      moderators: [{ name: 'Saoirse O Briain', bio: 'Senior editor.' }]
    }
    const result = buildParticipantNamesContext(conversation)
    expect(result).toContain('Saoirse O Briain')
    expect(result).toContain('Moderator')
    expect(result).toContain('Senior editor.')
  })

  it('includes also known as when alternateName is set on a moderator', () => {
    const conversation = {
      presenters: [],
      moderators: [{ name: 'Saoirse O Briain', alternateName: 'Sorsha', bio: 'Senior editor.' }]
    }
    const result = buildParticipantNamesContext(conversation)
    expect(result).toContain('Saoirse O Briain (also known as "Sorsha")')
  })

  it('skips entries with no name', () => {
    const conversation = {
      presenters: [{ name: '', bio: 'Some bio.' }],
      moderators: []
    }
    expect(buildParticipantNamesContext(conversation)).toBe('')
  })

  it('includes the Event Participants header when there are participants', () => {
    const conversation = {
      presenters: [{ name: 'Jane Doe' }],
      moderators: []
    }
    expect(buildParticipantNamesContext(conversation)).toContain('## Event Participants:')
  })

  it('passes through comma-separated alternate names as a single string', () => {
    const conversation = {
      presenters: [{ name: 'Dr. Priyanka Subramaniam', alternateName: 'Dr. Sub, Priya' }],
      moderators: []
    }
    const result = buildParticipantNamesContext(conversation)
    expect(result).toContain('also known as "Dr. Sub, Priya"')
  })

  it('comma-separated alternate names appear alongside the canonical name', () => {
    const conversation = {
      presenters: [{ name: 'Dr. Priyanka Subramaniam', alternateName: 'Dr. Sub, Priya' }],
      moderators: []
    }
    const result = buildParticipantNamesContext(conversation)
    expect(result).toContain('Dr. Priyanka Subramaniam (also known as "Dr. Sub, Priya")')
  })

  it('comma-separated alternate names work for moderators too', () => {
    const conversation = {
      presenters: [],
      moderators: [{ name: 'Saoirse O Briain', alternateName: 'Sorsha, Sorsha O Brien' }]
    }
    const result = buildParticipantNamesContext(conversation)
    expect(result).toContain('Saoirse O Briain (also known as "Sorsha, Sorsha O Brien")')
  })
})
