import { isCalledUpon, CALL_UPON_PHRASES, CALL_UPON_ACKNOWLEDGMENTS } from '../callUpon.js'

describe('isCalledUpon', () => {
  const botName = 'Berkie'

  test.each(CALL_UPON_PHRASES)('matches "%s" combined with the bot name', (phrase) => {
    expect(isCalledUpon(`ok ${phrase} Berkie`, botName)).toBe(true)
  })

  test('does not match a call-upon phrase with no bot name nearby', () => {
    expect(isCalledUpon('go ahead everyone', botName)).toBe(false)
  })

  test('does not match the bot name with no call-upon phrase', () => {
    expect(isCalledUpon('Berkie, what do you think?', botName)).toBe(false)
  })

  test('is case-insensitive', () => {
    expect(isCalledUpon('GO AHEAD BERKIE', botName)).toBe(true)
  })

  test('tolerates an @ prefix and trailing punctuation on the name', () => {
    expect(isCalledUpon('go ahead @Berkie!', botName)).toBe(true)
    expect(isCalledUpon('your turn, Berkie.', botName)).toBe(true)
  })

  test('fuzzy-matches a close misspelling of the bot name', () => {
    expect(isCalledUpon('go ahead Burkie', botName)).toBe(true)
  })

  test('does not match an unrelated name', () => {
    expect(isCalledUpon('go ahead Waldo', botName)).toBe(false)
  })

  test.each(CALL_UPON_ACKNOWLEDGMENTS)('matches "%s" immediately before the bot name', (ack) => {
    expect(isCalledUpon(`${ack}, Berkie?`, botName)).toBe(true)
  })

  test.each(CALL_UPON_ACKNOWLEDGMENTS)('matches "%s" immediately after the bot name', (ack) => {
    expect(isCalledUpon(`Berkie, ${ack}?`, botName)).toBe(true)
  })

  test('does not match an acknowledgment that is not adjacent to the bot name', () => {
    expect(isCalledUpon('Yes, I think Berkie did a great job summarizing that', botName)).toBe(false)
  })

  test('does not match a bare acknowledgment with no bot name', () => {
    expect(isCalledUpon('Yes, I agree completely', botName)).toBe(false)
  })
})
