import * as fuzzball from 'fuzzball'

// Bot name fuzzy-match threshold — same as intentChecks.ts
export const BOT_NAME_MATCH_THRESHOLD = 70

// Phrases that signal the moderator is calling on the bot. Matched case-insensitively
// anywhere in the transcript line, in combination with the bot name. These are all
// distinctive enough as multi-word idioms that they're unlikely to occur incidentally.
export const CALL_UPON_PHRASES = [
  'go ahead',
  'your turn',
  'over to you',
  "you're up",
  'take it away',
  'please go',
  'the floor is yours',
  "let's hear from"
]

// Short acknowledgments a moderator uses to call on a raised hand ("Yes, Berkie?") are too
// common elsewhere in ordinary conversation to substring-match anywhere in the line the way
// CALL_UPON_PHRASES does — e.g. "Yes, I think Berkie's summary was great" isn't calling on
// the bot. These only count when immediately adjacent to the bot's name.
export const CALL_UPON_ACKNOWLEDGMENTS = ['yes', 'yeah', 'ok', 'okay', 'alright', 'sure']

const stripWord = (word: string) => word.replace(/^@/, '').replace(/[,!.?]+$/, '')

/**
 * Returns true when a transcript line is calling on the bot by name.
 * Requires the bot name plus either a call-upon phrase anywhere in the line, or a short
 * acknowledgment immediately adjacent to the name (e.g. "yes, Berkie", "Berkie, yes").
 */
export function isCalledUpon(text: string, botName: string): boolean {
  const lower = text.toLowerCase()
  const words = lower.split(/\s+/).map(stripWord)
  const nameIndex = words.findIndex((w) => fuzzball.ratio(w, botName.toLowerCase()) >= BOT_NAME_MATCH_THRESHOLD)
  if (nameIndex === -1) return false

  if (CALL_UPON_PHRASES.some((p) => lower.includes(p))) return true

  return CALL_UPON_ACKNOWLEDGMENTS.includes(words[nameIndex - 1]) || CALL_UPON_ACKNOWLEDGMENTS.includes(words[nameIndex + 1])
}
