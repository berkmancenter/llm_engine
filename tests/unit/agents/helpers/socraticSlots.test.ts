import { validateSocraticSlots, countWordUses } from '../../../../src/agents/helpers/socraticSlots.js'
import { contentWordOverlap } from '../../../../src/agents/helpers/textOverlap.js'

const PASSAGE =
  'Source ID: 0\nTitle: Okonkwo-Reyes, M. (2024). Quota Crowding in Volunteer Forums.\n' +
  "Snippet: Okonkwo-Reyes reports that mandatory posting quotas produce what she terms 'quota crowding'."
const resources = [
  { title: 'Quota Crowding in Volunteer Forums', authors: ['Mira Okonkwo-Reyes'], citation: 'Okonkwo-Reyes, M. (2024).' }
]
const chat = ['A healthy forum is busy', 'healthy means busy', 'so a quota makes sense']
const ctx = { passage: PASSAGE, resources, humanChatLines: chat }
const base = { sourceLabel: 'Okonkwo-Reyes', concept: 'quota crowding', loadedWord: 'healthy' }

describe('validateSocraticSlots', () => {
  it('accepts valid slots', () => {
    expect(validateSocraticSlots(base, ctx)).toEqual({
      ok: true,
      slots: { sourceLabel: 'Okonkwo-Reyes', concept: 'quota crowding', loadedWord: 'healthy' }
    })
  })

  it('matches the concept case-insensitively', () => {
    expect(validateSocraticSlots({ ...base, concept: 'Quota Crowding' }, ctx).ok).toBe(true)
  })

  it.each([
    ['missing', undefined],
    ['not in the passage', 'moderator burnout'],
    ['more than six words', 'mandatory posting quotas produce what she terms'],
    ['digits', '2024'],
    ['a finding verb', 'quotas fell']
  ])('rejects a concept that is %s', (_label, concept) => {
    expect(validateSocraticSlots({ ...base, concept }, ctx).ok).toBe(false)
  })

  it('rejects a concept containing a finding verb even when it is in the passage', () => {
    const passage = `${PASSAGE} Replies fell sharply.`
    expect(validateSocraticSlots({ ...base, concept: 'replies fell' }, { ...ctx, passage }).ok).toBe(false)
  })

  describe('concept versus finding terms', () => {
    const FIXTURE =
      "Okonkwo-Reyes (2024) reports that mandatory posting quotas in volunteer forums produce what she terms 'quota crowding': " +
      'once members must post a minimum number of times per week, the share of substantive replies falls by roughly a third. ' +
      'Communities that dropped quotas and instead recognized thoughtful contributions saw participation recover within two quarters.'
    const fctx = { ...ctx, passage: FIXTURE }
    const ok = (concept: string) => validateSocraticSlots({ ...base, concept }, fctx).ok

    it('still allows the coined term and plain topic terms of the fixture reading', () => {
      expect(ok('quota crowding')).toBe(true)
      expect(ok('posting quotas')).toBe(true)
      expect(ok('substantive replies')).toBe(true)
      expect(ok('volunteer forums')).toBe(true)
    })

    it.each(['dropped quotas', 'quotas hurt', 'lower participation', 'more replies'])(
      'rejects the outcome phrase %s',
      (concept) => {
        expect(ok(concept)).toBe(false)
      }
    )

    it('rejects an unquoted crowd word, which only a quoted coined term may carry', () => {
      const passage = 'Quotas lead to crowding of replies, and replies fall by a third.'
      expect(validateSocraticSlots({ ...base, concept: 'crowding of replies' }, { ...ctx, passage }).ok).toBe(false)
    })

    it('rejects a concept sharing an outcome-ish word with a sentence that reports a quantity', () => {
      const passage = 'Quotas were relaxed. Relaxed forums recovered within two quarters.'
      const r = validateSocraticSlots({ ...base, concept: 'relaxed forums' }, { ...ctx, passage })
      expect(r).toEqual({ ok: false, reason: expect.stringContaining('quantity') })
      expect(validateSocraticSlots({ ...base, concept: 'Quotas were relaxed' }, { ...ctx, passage }).ok).toBe(false)
    })

    it('allows an outcome-ish word when no quantity sentence contains it', () => {
      const passage = 'Moderated forums are common. Replies fell by a third.'
      expect(validateSocraticSlots({ ...base, concept: 'moderated forums' }, { ...ctx, passage }).ok).toBe(true)
    })
  })

  it.each([
    ['author', 'Okonkwo-Reyes'],
    ['title', 'quota crowding in volunteer forums'],
    ['author full name', 'Mira Okonkwo-Reyes']
  ])('accepts a source label matching the %s', (_label, sourceLabel) => {
    expect(validateSocraticSlots({ ...base, sourceLabel }, ctx).ok).toBe(true)
  })

  it.each([
    'Okonkwo-Reyes (2024)',
    'Okonkwo-Reyes, M. (2024). Quota Crowding in Volunteer Forums.',
    'Okonkwo-Reyes (2024). Quota Crowding in Volunteer Forums'
  ])('trims a copied citation down to the source name: %s', (sourceLabel) => {
    expect(validateSocraticSlots({ ...base, sourceLabel }, ctx)).toEqual({
      ok: true,
      slots: expect.objectContaining({ sourceLabel: 'Okonkwo-Reyes' })
    })
  })

  it('accepts a source label that only appears in the passage', () => {
    const r = validateSocraticSlots(
      { ...base, sourceLabel: 'Journal Smith' },
      { ...ctx, resources: [], passage: `${PASSAGE} Journal Smith` }
    )
    expect(r.ok).toBe(true)
  })

  it.each([
    ['missing', undefined],
    ['unknown', 'Ostrom']
  ])('rejects a %s source label', (_l, sourceLabel) => {
    expect(validateSocraticSlots({ ...base, sourceLabel }, ctx).ok).toBe(false)
  })

  it('drops (not rejects) a loaded word used fewer than twice', () => {
    const r = validateSocraticSlots(
      { ...base, loadedWord: 'busy' },
      { ...ctx, humanChatLines: ['busy forum', 'quiet forum'] }
    )
    expect(r).toEqual({ ok: true, slots: expect.objectContaining({ loadedWord: null }) })
  })

  it('keeps a loaded word used twice across lines and nulls an empty one', () => {
    expect(validateSocraticSlots({ ...base, loadedWord: 'Healthy' }, ctx)).toEqual({
      ok: true,
      slots: expect.objectContaining({ loadedWord: 'Healthy' })
    })
    expect(validateSocraticSlots({ ...base, loadedWord: null }, ctx)).toEqual({
      ok: true,
      slots: expect.objectContaining({ loadedWord: null })
    })
  })
})

describe('countWordUses', () => {
  it('counts whole words only', () => {
    expect(countWordUses('fair', ['fair is fair', 'unfair', 'fairness'])).toBe(2)
  })
})

describe('contentWordOverlap', () => {
  it('measures the share of the earlier post that is repeated, ignoring given terms', () => {
    const earlier = 'In Okonkwo-Reyes, what happens to the kind of posts people write once posting is required?'
    expect(contentWordOverlap(earlier, earlier)).toBe(1)
    expect(contentWordOverlap(earlier, 'Is filler activity enough for a lively forum?')).toBeLessThan(0.5)
    expect(contentWordOverlap(earlier, 'Okonkwo-Reyes again?', /okonkwo/)).toBe(0)
  })
})
