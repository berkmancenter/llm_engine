import isPreEventWindowOpen from '../../../src/services/conversation.service/preEventWindow.js'

describe('isPreEventWindowOpen', () => {
  function withinWindow(overrides: Record<string, unknown> = {}) {
    return {
      scheduledTime: new Date(Date.now() + 5 * 60 * 1000),
      preEventMinutes: 15,
      ...overrides
    }
  }

  test('is open once within preEventMinutes of scheduledTime', () => {
    expect(isPreEventWindowOpen(withinWindow())).toBe(true)
  })

  test('is not open before preEventMinutes of scheduledTime', () => {
    expect(isPreEventWindowOpen(withinWindow({ scheduledTime: new Date(Date.now() + 60 * 60 * 1000) }))).toBe(false)
  })

  test('closes once the conversation has started, even before scheduledTime itself', () => {
    // A manual start (admin "start now", or a moderator resuming a transcript) can set
    // startTime before scheduledTime; the preEvent window is over regardless.
    expect(isPreEventWindowOpen(withinWindow({ startTime: new Date() }))).toBe(false)
  })

  test('is not open once the conversation has ended', () => {
    expect(isPreEventWindowOpen(withinWindow({ endTime: new Date() }))).toBe(false)
  })

  test('is not open for a draft, even if scheduledTime/preEventMinutes would otherwise open it', () => {
    expect(isPreEventWindowOpen(withinWindow({ draft: true }))).toBe(false)
  })

  test('is not open when preEventMinutes is unconfigured', () => {
    expect(isPreEventWindowOpen(withinWindow({ preEventMinutes: undefined }))).toBe(false)
  })

  test('is not open when preEventMinutes is 0, matching openConversationWindow treating it as unconfigured', () => {
    expect(isPreEventWindowOpen(withinWindow({ preEventMinutes: 0 }))).toBe(false)
  })

  test('is not open when preEventMinutes is negative', () => {
    expect(isPreEventWindowOpen(withinWindow({ preEventMinutes: -5 }))).toBe(false)
  })

  test('is not open when scheduledTime is unset', () => {
    expect(isPreEventWindowOpen(withinWindow({ scheduledTime: undefined }))).toBe(false)
  })

  describe('auto-start grace period (failsafe for a stuck/failed autoStart job)', () => {
    test('stays open for a few seconds after scheduledTime with no startTime yet', () => {
      // Normal case: auto-start hasn't set startTime yet, but it's well within the grace period.
      expect(isPreEventWindowOpen(withinWindow({ scheduledTime: new Date(Date.now() - 5 * 1000) }))).toBe(true)
    })

    test('closes once the grace period has elapsed with no startTime set', () => {
      // Abnormal case: autoStart should have set startTime by now and clearly hasn't.
      expect(isPreEventWindowOpen(withinWindow({ scheduledTime: new Date(Date.now() - 60 * 1000) }))).toBe(false)
    })
  })
})
