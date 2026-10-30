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
const GOOD = 'How does Okonkwo-Reyes treat quota crowding, and does that fit what we are describing?'

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
    expect(checkSocraticShape('Is a healthy forum what Okonkwo-Reyes means in quota crowding?', c).join()).toContain(
      'double quotes'
    )
    expect(checkSocraticShape('Is a "healthy" forum what Okonkwo-Reyes means by quota crowding?', c)).toEqual([])
    expect(checkSocraticShape('Is a “healthy” forum what Okonkwo-Reyes means by quota crowding?', c)).toEqual([])
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

  it('rejects a 4-word run copied from the passage but not from the concept slot', () => {
    const copied = 'Does Okonkwo-Reyes mean the share of substantive replies in quota crowding?'
    expect(checkSocraticShape(copied, ctx()).join()).toContain('copy wording')
    expect(findCopiedNgram('quota crowding', PASSAGE, slots)).toBeNull()
  })

  it('rejects a near-repeat of a recent post, ignoring the source name', () => {
    const post = 'How does Okonkwo-Reyes treat quota crowding, and does it fit our forum?'
    expect(checkSocraticShape(GOOD, ctx({ recentPosts: [post] }))).toEqual(
      expect.arrayContaining([expect.stringContaining('repeats an earlier post')])
    )
    expect(checkSocraticShape(GOOD, ctx({ recentPosts: ['Is anyone here a volunteer moderator themselves?'] }))).toEqual([])
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
      "How does Okonkwo-Reyes treat quota crowding, and does that fit what we're describing?"
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
