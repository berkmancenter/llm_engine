/* eslint-disable security/detect-unsafe-regex */
export interface TimeReference {
  type: 'absolute' | 'relative' | 'range'
  duration?: number
  startTime?: string
  endTime?: string
  time?: string
  direction?: 'first' | 'last'
}

interface Result {
  confidence: number
  timeReference: TimeReference
}

const formatTime = (time) => (time.includes(':') ? time : `${time}:00`)

/**
 * Calculate duration from start time to now in seconds
 * @param {Date} startTime - Start time as Date object
 * @returns {number} Duration in seconds
 */
function calculateDurationFromStart(startTime: Date, currentTime?: Date): number {
  const now = currentTime || new Date()
  const durationMs = now.getTime() - startTime.getTime()
  return Math.max(30, Math.floor(durationMs / 1000)) // Requests should not be smaller than 30 seconds
}

/**
 * Normalize text for better pattern matching
 * @param {string} text - Input text
 * @returns {string} Normalized text
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s:?]/g, ' ')
    .replace(/\s+/g, ' ')
}

/**
 * Check for "just joined" or "from beginning" queries
 * @param {string} originalText - Original text with punctuation
 * @param {string} eventStartTime - Start time of the event in HH:MM format
 * @param {string} currentTime - optional time to use for calculating duration from start
 * @returns {Object} Just joined detection result
 */
function checkJustJoinedRequest(originalText: string, eventStartTime: Date, currentTime?: Date): Result | null {
  const justJoinedPatterns = [
    // Core pattern: Questions about missing content + beginning/joining indicators
    /\b(what\s+(all\s+)?(did\s+i\s+miss|have\s+i\s+missed|happened|was\s+(discussed|covered|said))|catch\s+me\s+up|fill\s+me\s+in|(bring|get)\s+me\s+up\s+to\s+speed|tell\s+me\s+everything|show\s+me\s+everything|give\s+me\s+(everything|summary)|summary|recap)\b.*\b(since\s+)?(beginning|start|started|began|top|joined|came\s+in|got\s+here|arrived|entered|everything|so\s+far)\b/i,

    // Reverse pattern: Beginning/joining indicators + questions about content
    /\b(just\s+)?(joined|came\s+in|got\s+here|arrived|entered|from\s+the\s+(beginning|start|top))\b.*\b(what\s+(did\s+i\s+miss|have\s+i\s+missed|happened)|catch\s+me\s+up|fill\s+me\s+in|summary|recap)\b/i,

    // Simple standalone "everything" requests (no other context needed)
    /^(tell\s+me\s+everything|show\s+me\s+everything|give\s+me\s+everything)$/i,

    // Standalone "from everything" and "from the beginning" requests
    /^from\s+everything$/i,
    /^from\s+the\s+beginning$/i
  ]
  if (justJoinedPatterns.some((pattern) => pattern.test(originalText.trim()))) {
    const duration = calculateDurationFromStart(eventStartTime, currentTime)
    return {
      confidence: 0.9,
      timeReference: {
        type: 'relative',
        duration,
        direction: 'first'
      }
    }
  }

  return null
}

/**
 * Check for recent content requests that imply "last few minutes"
 * @param {string} originalText - Original text with punctuation
 * @returns {Object} Recent request detection result
 */
function checkRecentContentRequest(originalText): Result | null {
  const defaultRecentDuration = 60
  const recentPatterns = [
    // Simple clarification requests - standalone words/phrases + "what was that X"
    /^(wait,?\s+)?(what(\s+was\s+that(\s+(question|statement|remark|comment|thing|part))?)?|huh|come\s+again|pardon(\s+me)?|excuse\s+me|sorry)\??$/i,

    // "What did [subject] [action]" patterns - covers pronouns and speaker (NOT "I miss")
    /^(wait,?\s+)?what\s+did\s+(he|she|they|you|(the\s+)?speaker)\s*(just\s*)?(say|mention)\??$/i,

    // "What did I just miss" - only with temporal qualifiers that indicate recent/immediate context
    /^(wait,?\s+)?what\s+did\s+i\s+just\s+miss\??$/i,

    // "What is [pronoun] talking about" patterns
    /^what\s+is\s+(he|she|they)\s+talking\s+about(\s+now)?\??$/i,

    // "Didn't catch/hear" patterns
    /^(sorry,?\s*)?(didn't|don't)\s+(catch|hear|get)\s+(that|it|you)(\s+(last\s+)?(part|bit|thing))?\??$/i,

    // Repeat requests and "I missed" patterns
    /\b((can|could|would)\s+you\s+(repeat|say\s+that\s+again)|repeat\s+that|say\s+that\s+again)\b|\bi\s+(missed|didn't\s+hear|didn't\s+catch)\s+(that|it|what\s+(he|she|they)\s+said)\b/i
  ]

  if (recentPatterns.some((pattern) => pattern.test(originalText.trim()))) {
    return {
      confidence: 0.8,
      timeReference: {
        type: 'relative',
        duration: defaultRecentDuration,
        direction: 'last'
      }
    }
  }
  return null
}

/**
 * Check for generic catch-up / summary / meta queries without explicit time
 * These should typically map to a recent window (e.g., last couple minutes).
 */
function checkCatchupSummaryRequest(normalizedText: string, eventStartTime?: Date, currentTime?: Date): Result | null {
  const defaultCatchupDuration = 180

  // Remove trailing question marks for matching
  const normalized = normalizedText.replace(/\?+$/, '').trim()

  // Regex-based catch-up/summary patterns over the *normalized* text produced
  // by normalizeText (lowercased, apostrophes removed, extra spaces collapsed).
  const catchupEntireEventSummaryPatterns = [
    // Variants of "catch me up" / "fill me in" / "bring/get me up to speed"
    /\b((can|could|please|pls|plz)\s+)?(you\s+)?(catch\s+me\s+up|fill\s+me\s+in|bring\s+me\s+up\s+to\s+speed|get\s+me\s+up\s+to\s+speed)\b/,

    // Quick recap/summary / TL;DR style requests
    /\b(quick\s+(recap|summary)|tl\s*dr|tldr)\b/,

    // "what's the gist" / "whats the gist of this" style
    /\b((what\s+(is|s)|whats)\s+the\s+gist(\s+of\s+(this|that))?)\b/
  ]

  const entireEventMatch = catchupEntireEventSummaryPatterns.some((pattern) => pattern.test(normalized))
  if (entireEventMatch && eventStartTime) {
    const duration = calculateDurationFromStart(eventStartTime, currentTime)
    return {
      confidence: 0.9,
      timeReference: {
        type: 'relative',
        duration,
        direction: 'first'
      }
    }
  }

  const catchupRecentSummaryPatterns = [
    // "what's/whats/what is happening/going on/up" style colloquial questions
    /\b((what\s+(is|s)|whats)\s+(happening|going\s+on|goin\s+on|up))\b/ // e.g., "what's happening", "whats going on", "what s up"
  ]

  if (catchupRecentSummaryPatterns.some((pattern) => pattern.test(normalized)) || entireEventMatch) {
    return {
      confidence: 0.8,
      timeReference: {
        type: 'relative',
        duration: defaultCatchupDuration,
        direction: 'last'
      }
    }
  }

  // Phrases that should use the entire transcript
  const entireTranscriptCatchupPhrases = new Set([
    'catch me up',
    'what did i miss',
    'on what i missed',
    'what has been said',
    'what happened',
    'what was said',
    'what is this about',
    'what has been discussed',
    'what has been covered',
    'what has been mentioned',
    'what has been announced',
    'what has been noted',
    'what has been summarized',
    'what has been recapped',
    'what has been presented',
    'what has been explained',
    'what has been shown',
    'what has been told',
    'what has been given',
    'what has been brought up',
    'what has been gone over',
    'what has been discussed about',
    "what's been said",
    "what's been discussed",
    "what's been covered",
    "what's been mentioned",
    "what's been announced",
    "what's been noted",
    "what's been summarized",
    "what's been recapped",
    "what's been presented",
    "what's been explained",
    "what's been shown",
    "what's been told",
    "what's been given",
    "what's been brought up",
    "what's been gone over",
    "what's been discussed about",
    // Transcript requests
    'can you send me a transcript so far',
    'send me the transcript so far',
    'can i get the transcript so far',
    'can you send me the transcript',
    'can i get the transcript',
    'send transcript so far',
    'send transcript',
    'get transcript so far',
    'get transcript',
    'transcript so far',
    'transcript up to now',
    'transcript up to this point',
    'transcript so far please',
    'can you send transcript',
    'can you send the transcript',
    'can you send transcript so far',
    'can you send the transcript so far',
    'can i have the transcript so far',
    'can i have the transcript',
    'can i get transcript so far',
    'can i get transcript'
  ])

  // All catch-up/meta/summary phrases (including those for recent window)
  const catchupPhrases = new Set([
    ...entireTranscriptCatchupPhrases,
    "what's happening", // will appear as "what s happening" after normalizeText
    'what is happening',
    'what is going on',
    'what is up',
    'what is being discussed',
    'what is being talked about',
    'what is being said',
    'what is being covered',
    'what is being mentioned',
    'what is being announced',
    'what is being noted',
    'what is being summarized',
    'what is being recapped',
    'what is being presented',
    'what is being explained',
    'what is being shown',
    'what is being told',
    'what is being given',
    'what is being brought up',
    'what is being gone over',
    'what is being discussed about',

    // Ambiguous/colloquial forms from Ambiguous/Colloquial Summary tests
    "what's going on",
    "what's up",
    "what's being discussed",
    "what's being talked about",
    "what's being said",
    "what's being covered",
    "what's being mentioned",
    "what's being announced",
    "what's being noted",
    "what's being summarized",
    "what's being recapped",
    "what's being presented",
    "what's being explained",
    "what's being shown",
    "what's being told",
    "what's being given",
    "what's being brought up",
    "what's being gone over",
    "what's being discussed about"
  ])

  // Because normalizeText removes apostrophes, normalize the catchup phrases similarly
  const normalizedForMatch = normalized.replace(/'/g, ' ').replace(/\s+/g, ' ').trim()

  // Map of normalized representations that correspond to phrases with apostrophes
  const aliasMap: Record<string, string> = {
    "what's happening": 'what s happening',
    "what's going on": 'what s going on',
    "what's up": 'what s up',
    "what's being discussed": 'what s being discussed',
    "what's being talked about": 'what s being talked about',
    "what's being said": 'what s being said',
    "what's being covered": 'what s being covered',
    "what's being mentioned": 'what s being mentioned',
    "what's being announced": 'what s being announced',
    "what's being noted": 'what s being noted',
    "what's being summarized": 'what s being summarized',
    "what's being recapped": 'what s being recapped',
    "what's being presented": 'what s being presented',
    "what's being explained": 'what s being explained',
    "what's being shown": 'what s being shown',
    "what's being told": 'what s being told',
    "what's being given": 'what s being given',
    "what's being brought up": 'what s being brought up',
    "what's being gone over": 'what s being gone over',
    "what's being discussed about": 'what s being discussed about'
  }

  // Build a set of normalized forms for all catchup phrases
  const normalizedCatchupPhrases = new Set<string>()
  catchupPhrases.forEach((phrase) => {
    const base = phrase.toLowerCase().replace(/'/g, ' ').replace(/\s+/g, ' ').trim()
    normalizedCatchupPhrases.add(base)
    if (aliasMap[phrase]) {
      normalizedCatchupPhrases.add(aliasMap[phrase])
    }
  })

  // Build a set of normalized forms for entire transcript phrases
  const normalizedEntireTranscriptCatchupPhrases = new Set<string>()
  entireTranscriptCatchupPhrases.forEach((phrase) => {
    const base = phrase.toLowerCase().replace(/'/g, ' ').replace(/\s+/g, ' ').trim()
    normalizedEntireTranscriptCatchupPhrases.add(base)
    if (aliasMap[phrase]) {
      normalizedEntireTranscriptCatchupPhrases.add(aliasMap[phrase])
    }
  })

  // Check if any catchup phrase is contained in the normalized text
  let matchedEntireTranscriptPhrase = false
  for (const phrase of normalizedEntireTranscriptCatchupPhrases) {
    if (normalizedForMatch.includes(phrase)) {
      matchedEntireTranscriptPhrase = true
      break
    }
  }

  if (matchedEntireTranscriptPhrase && eventStartTime) {
    // Use the entire transcript (from event start)
    const duration = calculateDurationFromStart(eventStartTime, currentTime)
    return {
      confidence: 0.9,
      timeReference: {
        type: 'relative',
        duration,
        direction: 'first'
      }
    }
  }

  let matchedCatchupPhrase = false
  for (const phrase of normalizedCatchupPhrases) {
    if (normalizedForMatch.includes(phrase)) {
      matchedCatchupPhrase = true
      break
    }
  }

  if (matchedCatchupPhrase) {
    return {
      confidence: 0.8,
      timeReference: {
        type: 'relative',
        duration: defaultCatchupDuration,
        direction: 'last'
      }
    }
  }

  return null
}

/**
 * Parse duration words to seconds
 * @param {string} amount - Amount (number or word)
 * @param {string} unit - Time unit
 * @returns {number} Duration in seconds
 */
export function parseDuration(amount: string, unit: string) {
  let seconds = 0

  // Convert amount to number
  const amountMap = {
    few: 3,
    couple: 2,
    several: 5,
    a: 1,
    an: 1,
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90
  }

  const numAmount = amountMap[amount.toLowerCase()] || parseInt(amount, 10) || 0
  const lowerUnit = unit.toLowerCase()

  if (lowerUnit.startsWith('hour') || lowerUnit === 'h' || lowerUnit === 'hr' || lowerUnit === 'hrs') {
    seconds = numAmount * 60 * 60
  } else if (lowerUnit.startsWith('min') || lowerUnit === 'm') {
    seconds = numAmount * 60
  } else if (lowerUnit.startsWith('day')) {
    seconds = numAmount * 24 * 60 * 60
  } else if (lowerUnit.startsWith('week')) {
    seconds = numAmount * 7 * 24 * 60 * 60
  } else if (lowerUnit.startsWith('month')) {
    // Approximate: 30 days per month
    seconds = numAmount * 30 * 24 * 60 * 60
  } else if (lowerUnit.startsWith('year')) {
    // Approximate: 365 days per year
    seconds = numAmount * 365 * 24 * 60 * 60
  } else if (lowerUnit.startsWith('sec') || lowerUnit === 's') {
    seconds = numAmount
  } else {
    // Default: treat as seconds
    seconds = numAmount
  }

  return Math.max(30, seconds) // Requests should not be smaller than 30 seconds
}

function extractTimeReference(text): Result | null {
  // Check for time ranges
  const timeRangeMatch = text.match(
    /\b(between|from)\s+(\d{1,2}(?::\d{2})?)\s*(?:am|pm)?\s+(and|to)\s+(\d{1,2}(?::\d{2})?)\s*(?:am|pm)?\b/i
  )

  if (timeRangeMatch) {
    return {
      timeReference: {
        type: 'range',
        startTime: formatTime(timeRangeMatch[2]),
        endTime: formatTime(timeRangeMatch[4])
      },
      confidence: 0.5
    }
  }
  // Check for specific clock times
  const specificTimeMatch = text.match(
    /\b(at|around|during|before|after|since|from|until)\s*(?:(\d{1,2}:\d{2})(?:\s*(?:am|pm))?|(\d{1,2})(?:\s*(?:am|pm))?)\b(?!\s*(?:to|and|-)*\s*\d)/i
  )
  if (specificTimeMatch) {
    return {
      timeReference: {
        type: 'absolute',
        time: formatTime(specificTimeMatch[2] || specificTimeMatch[3])
      },
      confidence: 0.5
    }
  }

  // Check for duration ranges (last X minutes, past X hours, last 2 days, etc.)
  // For single-letter units (h, m, s), require them to be preceded by a digit
  const durationRangeMatch = text.match(
    /\b(?:(last|past|first|for)\s+)?(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|couple|few|several)\s+)?(minute(?:s)?|hour(?:s)?|second(?:s)?|day(?:s)?|week(?:s)?|month(?:s)?|year(?:s)?|min(?:s)?|sec(?:s)?|hr(?:s)?)(?:\s+(ago|back|earlier|before))?\b/i
  )

  // Also check for single-letter duration units, but only after digits (e.g., "30s", "5m", "2h")
  const singleLetterDurationMatch = !durationRangeMatch
    ? text.match(/\b(?:(last|past|first|for)\s+)?(\d+)\s*([hms])(?:\s+(ago|back|earlier|before))?\b/i)
    : null

  const matchToUse = durationRangeMatch || singleLetterDurationMatch
  if (matchToUse) {
    const duration = parseDuration(matchToUse[2] ?? 'a', matchToUse[3])
    return {
      timeReference: {
        type: 'relative',
        duration,
        direction: matchToUse[1] === 'first' ? 'first' : 'last'
      },
      confidence: 0.4
    }
  }

  return null
}

/**
 * Main detection function - matches questions with specific time references OR recent content requests
 * @param {string} text - The input text to analyze
 * @returns {TimeReference} Detection result with time extraction
 */
export default function detectTimeQuery(text: string, eventStartTime: Date, currentTime?: Date): TimeReference | null {
  const normalizedText = normalizeText(text)

  // Check for "just joined" requests first (these are special cases)
  const justJoinedResult = checkJustJoinedRequest(text, eventStartTime, currentTime)
  if (justJoinedResult) {
    return justJoinedResult.timeReference
  }

  // Check for recent content requests (these are special cases)
  const recentContentResult = checkRecentContentRequest(text)
  if (recentContentResult) {
    return recentContentResult.timeReference
  }

  // Extract any explicit time reference BEFORE checking catchup phrases
  // This ensures "what happened at 2:15pm" gets handled as absolute time, not catchup
  const timeExtractionResult = extractTimeReference(normalizedText)

  // If we found a relative duration (e.g., "last 5 minutes", "3 mins"),
  // treat it as a valid time query even if phrased as a fragment.
  if (timeExtractionResult && timeExtractionResult.timeReference.type === 'relative') {
    return timeExtractionResult.timeReference
  }

  // If we found an absolute time or range, validate it's actually a question with content intent
  if (
    timeExtractionResult &&
    (timeExtractionResult.timeReference.type === 'absolute' || timeExtractionResult.timeReference.type === 'range')
  ) {
    const hasQuestionMark = /\?/.test(text)
    const hasQuestionWords = /\b(what|when|can|could|tell me|did|show me|summarize|explain)\b/i.test(normalizedText)
    const isQuestion = hasQuestionMark || hasQuestionWords

    if (isQuestion) {
      const timeKeywords =
        /\b(happen(ed)?|says?|said|discuss(ed)?|talk(ed)?|cover(ed)?|mention(ed)?|miss(ed)?|announce(ed)?|note(s|d)|summary|summarize|catch\s+me\s+up|fill\s+me\s+in|(bring|get)\s+me\s+up\s+to\s+speed|(go|went) over|present(ed)?)\b/i
      if (timeKeywords.test(normalizedText)) {
        let score = 0.3
        score += timeExtractionResult.confidence!

        const questionStarters = /\b(what|can you|could you|tell me|recap|summarize|show me)\b/i
        if (questionStarters.test(normalizedText)) {
          score += 0.2
        }

        const confidence = Math.min(Math.max(score, 0), 1)
        if (confidence > 0.6) {
          return timeExtractionResult.timeReference
        }
      }
    }
  }

  // Check for catch-up / summary / meta requests without explicit time
  // This comes AFTER absolute time checking to avoid false matches
  const catchupSummaryResult = checkCatchupSummaryRequest(normalizedText, eventStartTime, currentTime)
  if (catchupSummaryResult) {
    return catchupSummaryResult.timeReference
  }

  return null
}
