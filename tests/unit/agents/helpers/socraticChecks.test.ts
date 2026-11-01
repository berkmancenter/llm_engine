import {
  checkSocraticShape,
  renderSocraticTemplate,
  findCopiedNgram
} from '../../../../src/agents/helpers/socraticChecks.js'

const PASSAGE =
  "Okonkwo-Reyes reports that mandatory posting quotas produce what she terms 'quota crowding': once members must post a minimum number of times per week, the share of substantive replies falls by roughly a third."
const slots = { sourceLabel: 'Okonkwo-Reyes', concept: 'quota crowding', loadedWord: null as string | null }
const ctx = (over = {}) => ({
  slots,
  passage: PASSAGE,
  participantNames: ['Curious Badger', 'Badger', 'Fox'],
  recentPosts: [],
  ...over
})
const GOOD = 'How does Okonkwo-Reyes treat quota crowding?'

describe('checkSocraticShape', () => {
  it('passes a clean question', () => {
    expect(checkSocraticShape(GOOD, ctx())).toEqual([])
  })

  it.each([
    ['no question mark', 'Tell me how Okonkwo-Reyes treats quota crowding.'],
    ['two question marks', 'How does Okonkwo-Reyes treat quota crowding? Does it fit?'],
    ['question not last', 'How does Okonkwo-Reyes treat quota crowding? Say more.']
  ])('rejects: %s', (_l, text) => {
    expect(checkSocraticShape(text, ctx()).join()).toContain('exactly one question mark')
  })

  it('rejects more than 40 words', () => {
    const long = `How does Okonkwo-Reyes treat quota crowding ${'and also this '.repeat(14)}together?`
    expect(checkSocraticShape(long, ctx()).join()).toContain('at most 40 words')
  })

  it('requires the source name, accepting a surname for a full name', () => {
    expect(checkSocraticShape('How is quota crowding treated?', ctx()).join()).toContain('name the source')
    const full = ctx({ slots: { ...slots, sourceLabel: 'Mira Okonkwo' } })
    expect(checkSocraticShape('How does Okonkwo treat quota crowding?', full)).toEqual([])
  })

  it('requires the loaded word in double quotes when set', () => {
    const c = ctx({ slots: { ...slots, loadedWord: 'healthy' } })
    expect(checkSocraticShape('Is a healthy forum what Okonkwo-Reyes means by it?', c).join()).toContain('double quotes')
    expect(checkSocraticShape('Is a "healthy" forum what Okonkwo-Reyes would mean by it?', c)).toEqual([])
    expect(checkSocraticShape('Is a “healthy” forum what Okonkwo-Reyes would mean by it?', c)).toEqual([])
  })

  it('rejects a draft pairing the loaded word with the concept, case-insensitively', () => {
    const c = ctx({ slots: { ...slots, loadedWord: 'healthy' } })
    const paired = 'When we say "healthy", would Okonkwo-Reyes mean Quota Crowding by that?'
    expect(checkSocraticShape(paired, c).join()).toContain('do not pair it with any other term')
    // the concept alone is fine when there is no loaded word
    expect(checkSocraticShape(GOOD, ctx())).toEqual([])
  })

  it.each(['he', 'she', 'his', 'her', 'him', 'hers', 'himself', 'herself'])('rejects the pronoun "%s"', (p) => {
    const text = `Would Okonkwo-Reyes say ${p} treats quota crowding as we do?`
    expect(checkSocraticShape(text, ctx()).join()).toContain('refer to the source only by its name')
  })

  it('does not flag pronoun-like substrings or quoted words', () => {
    expect(checkSocraticShape('Where does Okonkwo-Reyes treat quota crowding?', ctx())).toEqual([])
    const c = ctx({ slots: { ...slots, loadedWord: 'her' } })
    expect(checkSocraticShape('When we say "her", would Okonkwo-Reyes mean the same thing by it?', c)).toEqual([])
  })

  it('rejects participant names, including a pseudonym surname', () => {
    expect(checkSocraticShape('Badger, how does Okonkwo-Reyes treat quota crowding?', ctx()).join()).toContain('participant')
    expect(checkSocraticShape('Did Curious Badger read Okonkwo-Reyes on quota crowding?', ctx()).join()).toContain(
      'participant'
    )
  })

  it('rejects analogies', () => {
    expect(checkSocraticShape('Imagine a ship: how does Okonkwo-Reyes treat quota crowding?', ctx()).join()).toContain(
      'analogies'
    )
  })

  it('rejects digits outside the slots but allows digits inside them', () => {
    expect(checkSocraticShape('Does Okonkwo-Reyes say 3 things about quota crowding?', ctx()).join()).toContain('numbers')
    const c = ctx({ slots: { ...slots, sourceLabel: 'Okonkwo-Reyes (2024)' } })
    expect(checkSocraticShape('How does Okonkwo-Reyes (2024) treat quota crowding?', c)).toEqual([])
  })

  it('rejects finding verbs outside the slots', () => {
    expect(checkSocraticShape('Okonkwo-Reyes found something about quota crowding, no?', ctx()).join()).toContain('outcome')
    expect(
      checkSocraticShape('Why did quota crowding make replies drop, per Okonkwo-Reyes, as they fell?', ctx()).join()
    ).toContain('outcome')
  })

  it('rejects the added outcome words outside the slots, but not inside the concept slot', () => {
    for (const word of ['hurt', 'lower', 'more', 'dropped', 'crowded']) {
      expect(checkSocraticShape(`Why would ${word} replies matter per Okonkwo-Reyes?`, ctx()).join()).toContain('outcome')
    }
    expect(checkSocraticShape('How does Okonkwo-Reyes define quota crowding?', ctx())).toEqual([])
  })

  it('rejects a 4-word run copied from the passage but not from the concept slot', () => {
    const copied = 'Does Okonkwo-Reyes mean the share of substantive replies in quota crowding?'
    expect(checkSocraticShape(copied, ctx()).join()).toContain('copy wording')
    expect(findCopiedNgram('quota crowding', PASSAGE, slots)).toBeNull()
  })

  it('rejects a near-repeat of a recent post, ignoring the source name', () => {
    const post = 'How does Okonkwo-Reyes treat quota crowding in our forum?'
    expect(checkSocraticShape(GOOD, ctx({ recentPosts: [post] }))).toEqual(
      expect.arrayContaining([expect.stringContaining('repeats an earlier post')])
    )
    expect(checkSocraticShape(GOOD, ctx({ recentPosts: ['Is anyone here a volunteer moderator themselves?'] }))).toEqual([])
  })
})

describe('quoted words credited to the source', () => {
  const REASON = 'credit the source'
  const lw = ctx({ slots: { ...slots, loadedWord: 'healthy' } })
  it.each([
    'When Okonkwo-Reyes discusses quota crowding, how does that reading use the term "healthy", and would it match what you mean by it?',
    'When you say filler posts count as "activity", how does Okonkwo-Reyes use that term, and does it match what you mean?',
    'How does the source use "healthy" to describe forums?',
    'How does Okonkwo-Reyes define "healthy" in the discussion of quota crowding?'
  ])('rejects: %s', (text) => {
    const c = text.includes('healthy') ? lw : ctx()
    expect(checkSocraticShape(text, c).join()).toContain(REASON)
  })

  it.each([
    'When we say "healthy", would Okonkwo-Reyes mean the same thing by it?',
    'How would Okonkwo-Reyes treat "healthy" in a forum like ours?',
    'Does Okonkwo-Reyes\'s idea of quota crowding apply to what we call "healthy"?',
    'Does Okonkwo-Reyes\u2019s idea of quota crowding fit what we mean by \u201chealthy\u201d?',
    'How does Okonkwo-Reyes use the phrase "quota crowding" in a forum?'
  ])('passes: %s', (text) => {
    const c = text.includes('healthy') ? lw : ctx()
    expect(checkSocraticShape(text, c).join()).not.toContain(REASON)
  })

  it('does not flag a quoted span that occurs in the passage', () => {
    expect(
      checkSocraticShape('How does Okonkwo-Reyes use "substantive replies" in this finding?', ctx()).join()
    ).not.toContain(REASON)
  })
})

describe('one ask per question', () => {
  const REASON = 'ask one thing only'
  const lw = ctx({ slots: { ...slots, loadedWord: 'healthy' } })

  it.each([
    'How does Okonkwo-Reyes treat quota crowding, and does that fit what we are describing?',
    'How does Okonkwo-Reyes treat quota crowding, and where would that show up in our forum?',
    'How does Okonkwo-Reyes treat quota crowding but would that fit our forum?',
    'How does Okonkwo-Reyes treat quota crowding; does that fit our forum?',
    'How does Okonkwo-Reyes treat quota crowding, where would that show up in our forum?',
    'Is quota crowding close to how Okonkwo-Reyes frames it, or does Okonkwo-Reyes mean something else?'
  ])('rejects a compound question: %s', (text) => {
    expect(checkSocraticShape(text, ctx()).join()).toContain(REASON)
  })

  it('rejects a compound question around the loaded word', () => {
    const text = 'When we say "healthy", would Okonkwo-Reyes use it, and does it match what we mean?'
    expect(checkSocraticShape(text, lw).join()).toContain(REASON)
  })

  it.each([
    'How does Okonkwo-Reyes treat quota crowding?',
    'What part does Okonkwo-Reyes give to quota crowding in a forum like ours?',
    'In Okonkwo-Reyes\'s paper, how is quota crowding treated?',
    // a short alternative inside one ask is a single choice
    'Is quota crowding closer to how Okonkwo-Reyes frames it, or something different?'
  ])('accepts a single ask: %s', (text) => {
    expect(checkSocraticShape(text, ctx()).join()).not.toContain(REASON)
  })

  it('accepts a leading "When we say ..." framing clause', () => {
    const text = 'When we say "healthy", would Okonkwo-Reyes mean the same thing by it?'
    expect(checkSocraticShape(text, lw)).toEqual([])
    const alt = 'When we say "healthy", would Okonkwo-Reyes mean the same thing, or something narrower?'
    expect(checkSocraticShape(alt, lw)).toEqual([])
  })

  it('does not count a conjunction inside a slot as a second ask', () => {
    const c = ctx({ slots: { ...slots, concept: 'trust and who decides' } })
    expect(checkSocraticShape('How does Okonkwo-Reyes treat trust and who decides?', c)).toEqual([])
  })
})

describe('renderSocraticTemplate', () => {
  it('uses the loaded word when present', () => {
    expect(renderSocraticTemplate({ ...slots, loadedWord: 'healthy' })).toBe(
      'When we say "healthy", would Okonkwo-Reyes mean the same thing by it?'
    )
  })

  it('falls back to the concept, and quotes a long title as the source', () => {
    expect(renderSocraticTemplate(slots)).toBe(
      "How does Okonkwo-Reyes treat quota crowding?"
    )
    expect(renderSocraticTemplate({ ...slots, sourceLabel: 'Quota Crowding in Volunteer Forums' })).toContain(
      "'Quota Crowding in Volunteer Forums'"
    )
  })

  it('always passes the shape checks', () => {
    for (const loadedWord of [null, 'healthy']) {
      const s = { ...slots, loadedWord }
      expect(checkSocraticShape(renderSocraticTemplate(s), ctx({ slots: s }))).toEqual([])
    }
  })
})
