import detectTimeQuery from '../../src/utils/detectTimeQuery'

// These tests are segmented so each group aligns with a specific helper/branch
// inside src/utils/detectTimeQuery.ts. Each test case is annotated with which
// part of the detectTimeQuery module it is intended to exercise.

describe('Detect Time Query Tests', () => {
  const startTime = new Date('2023-10-01T12:00:00Z')

  // Time range handling in extractTimeReference (timeRangeMatch)
  describe('Time Range Queries (timeRangeMatch)', () => {
    it('detects a range between two explicit HH:MM times', () => {
      // tests extractTimeReference: timeRangeMatch (explicit HH:MM range)
      const timeRef = detectTimeQuery('What did they discuss between 2:00 and 2:30?', startTime)
      expect(timeRef).not.toBeNull()
      expect(timeRef!.type).toEqual('range')
      expect(timeRef?.startTime).toEqual('2:00')
      expect(timeRef?.endTime).toEqual('2:30')
    })

    it('detects a range from HH:MM to HH:MM with am/pm', () => {
      // tests extractTimeReference: timeRangeMatch (HH:MM with am/pm)
      const timeRef2 = detectTimeQuery('What was mentioned from 1:15 to 1:45 PM?', startTime)
      expect(timeRef2).not.toBeNull()
      expect(timeRef2!.type).toEqual('range')
      expect(timeRef2?.startTime).toEqual('1:15')
      expect(timeRef2?.endTime).toEqual('1:45')
    })

    it('normalizes hour-only bounds to :00', () => {
      // tests extractTimeReference: timeRangeMatch hour-only normalization via formatTime
      const timeRef3 = detectTimeQuery('What did he say between 2 and 3?', startTime)
      expect(timeRef3).not.toBeNull()
      expect(timeRef3!.type).toEqual('range')
      expect(timeRef3?.startTime).toEqual('2:00')
      expect(timeRef3?.endTime).toEqual('3:00')
    })
  })

  // Absolute time handling in extractTimeReference (specificTimeMatch)
  describe('Absolute Time Queries (specificTimeMatch)', () => {
    it('detects an "at HH:MM" query', () => {
      // tests extractTimeReference: specificTimeMatch with explicit HH:MM
      const timeRef = detectTimeQuery('What did he say at 10:30?', startTime)
      expect(timeRef).not.toBeNull()
      expect(timeRef!.type).toEqual('absolute')
      expect(timeRef?.time).toEqual('10:30')
    })

    it('detects an "at HH:MM am/pm" query', () => {
      // tests extractTimeReference: specificTimeMatch with HH:MM am/pm
      const timeRef2 = detectTimeQuery('What happened at 2:15 PM?', startTime)
      expect(timeRef2).not.toBeNull()
      expect(timeRef2!.type).toEqual('absolute')
      expect(timeRef2?.time).toEqual('2:15')
    })

    it('normalizes an "at H" query to H:00', () => {
      // tests extractTimeReference: specificTimeMatch hour-only normalization via formatTime
      const timeRef4 = detectTimeQuery('What happened at 2?', startTime)
      expect(timeRef4).not.toBeNull()
      expect(timeRef4!.type).toEqual('absolute')
      expect(timeRef4?.time).toEqual('2:00')
    })

    it('detects "around HH:MM am/pm" queries', () => {
      // tests extractTimeReference: specificTimeMatch with "around" keyword
      const timeRef3 = detectTimeQuery('Tell me what was discussed around 11:45 AM', startTime)
      expect(timeRef3).not.toBeNull()
      expect(timeRef3!.type).toEqual('absolute')
      expect(timeRef3?.time).toEqual('11:45')
    })
  })

  // Duration/window handling in extractTimeReference (durationRangeMatch + parseDuration)
  describe('Duration/Window Queries (durationRangeMatch)', () => {
    it('detects explicit duration queries with "last" and numeric minutes', () => {
      // tests extractTimeReference: durationRangeMatch with numeric minutes
      const timeRef = detectTimeQuery('What did I miss in the last 10 minutes?', startTime)
      expect(timeRef).not.toBeNull()
      expect(timeRef!.type).toEqual('relative')
      expect(timeRef!.duration).toEqual(600)
      expect(timeRef!.direction).toEqual('last')
    })

    it('detects "X minutes ago" queries', () => {
      // tests extractTimeReference: durationRangeMatch with "ago" modifier
      const timeRef2 = detectTimeQuery('What was said 5 minutes ago?', startTime)
      expect(timeRef2).not.toBeNull()
      expect(timeRef2!.type).toEqual('relative')
      expect(timeRef2!.duration).toEqual(300)
      expect(timeRef2!.direction).toEqual('last')
    })

    it('detects "for N minutes" queries with word amounts (couple/few/etc.)', () => {
      // tests extractTimeReference: durationRangeMatch + parseDuration with word amounts
      const timeRef3 = detectTimeQuery('I stepped out for 15 minutes, what did I miss?', startTime)
      expect(timeRef3).not.toBeNull()
      expect(timeRef3!.type).toEqual('relative')
      expect(timeRef3!.duration).toEqual(15 * 60)
      expect(timeRef3!.direction).toEqual('last')

      const timeRef6 = detectTimeQuery('I was away for a couple minutes, what happened?', startTime)
      expect(timeRef6).not.toBeNull()
      expect(timeRef6!.type).toEqual('relative')
      expect(timeRef6!.duration).toEqual(2 * 60)
      expect(timeRef6!.direction).toEqual('last')

      const timeRef8 = detectTimeQuery('I stepped out for a couple mins, what did I miss?', startTime)
      expect(timeRef8).not.toBeNull()
      expect(timeRef8!.type).toEqual('relative')
      expect(timeRef8!.duration).toEqual(2 * 60)
      expect(timeRef8!.direction).toEqual('last')
    })

    it('detects "past N minutes" and "first N minutes" queries', () => {
      // tests extractTimeReference: durationRangeMatch with "past" and "first" directions
      const timeRef4 = detectTimeQuery('Show me what happened in the past 20 minutes', startTime)
      expect(timeRef4).not.toBeNull()
      expect(timeRef4!.type).toEqual('relative')
      expect(timeRef4!.duration).toEqual(20 * 60)
      expect(timeRef4!.direction).toEqual('last')

      const timeRef5 = detectTimeQuery('What was covered in the first 30 minutes?', startTime)
      expect(timeRef5).not.toBeNull()
      expect(timeRef5!.type).toEqual('relative')
      expect(timeRef5!.duration).toEqual(30 * 60)
      expect(timeRef5!.direction).toEqual('first')
    })

    it('detects durations in hours and seconds', () => {
      // tests extractTimeReference: durationRangeMatch with hours and seconds units
      const timeRef7 = detectTimeQuery('What did the speaker say 3 hours ago?', startTime)
      expect(timeRef7).not.toBeNull()
      expect(timeRef7!.type).toEqual('relative')
      expect(timeRef7!.duration).toEqual(3 * 60 * 60)
      expect(timeRef7!.direction).toEqual('last')

      const timeRef9 = detectTimeQuery('What happened 30 secs ago?', startTime)
      expect(timeRef9).not.toBeNull()
      expect(timeRef9!.type).toEqual('relative')
      expect(timeRef9!.duration).toEqual(30)
      expect(timeRef9!.direction).toEqual('last')
    })

    it('supports word-based amounts ("last two minutes")', () => {
      // tests extractTimeReference: durationRangeMatch + parseDuration with word-based "last two minutes"
      const timeRef10 = detectTimeQuery("I wasn't paying attention for the last two minutes. get me up to speed?", startTime)
      expect(timeRef10).not.toBeNull()
      expect(timeRef10!.type).toEqual('relative')
      expect(timeRef10!.duration).toEqual(2 * 60)
      expect(timeRef10!.direction).toEqual('last')
    })

    it('does not return a duration less than 30 seconds', () => {
      // tests parseDuration minimum clamp and calculateDurationFromStart lower bound
      const timeRef11 = detectTimeQuery('I stepped out for a second. What did I miss?', startTime)
      expect(timeRef11).not.toBeNull()
      expect(timeRef11!.type).toEqual('relative')
      expect(timeRef11!.duration).toEqual(30)
      expect(timeRef11!.direction).toEqual('last')

      const timeRef12 = detectTimeQuery('What did I miss in the first 10 seconds?', startTime)
      expect(timeRef12).not.toBeNull()
      expect(timeRef12!.type).toEqual('relative')
      expect(timeRef12!.duration).toEqual(30)
      expect(timeRef12!.direction).toEqual('first')

      // Started 10 seconds ago
      const testStartTime = new Date()
      testStartTime.setHours(
        testStartTime.getHours(),
        testStartTime.getMinutes(),
        testStartTime.getSeconds() - 10,
        testStartTime.getMilliseconds()
      )

      const timeRef2 = detectTimeQuery('What happened since the beginning?', testStartTime)
      expect(timeRef2).not.toBeNull()
      expect(timeRef2!.type).toEqual('relative')
      expect(timeRef2!.duration).toEqual(30)
      expect(timeRef2!.direction).toEqual('first')
    })

    it('covers a wide variety of recent time window phrasings', () => {
      // tests extractTimeReference: durationRangeMatch across many phrasing variants
      const timeWindowRequests = [
        'I stepped out for a minute. What did I miss?',
        'What was discussed in the last minute?',
        'Notes on the last minute?',
        'Summarize the last minute',
        'I zoned out for a minute what did I miss',
        // New/edge cases
        'last minute?',
        'last min',
        'last min?',
        '3 mins?',
        '3 min?',
        'last 3 mins?',
        'last 3 min',
        'last 3 min?',
        'last 3 minutes?',
        'last 3 seconds?',
        'last 30 secs?',
        'last 30 sec?',
        'last 30 seconds?',
        'last 2 mins',
        'last 2 min',
        'last 2 minutes',
        'last 2 seconds',
        'last 2 secs',
        'last 2 sec',
        'last 2 s',
        'last 2 m',
        'last 2 h',
        'last 2 hours',
        'last 2 hrs',
        'last 2 hr',
        'last 2 days',
        'last 2 weeks',
        'last 2 months',
        'last 2 years',
        'last min?',
        'last mins?',
        'last minute',
        'last minutes',
        'last sec',
        'last secs',
        'last second',
        'last seconds',
        '3 mins',
        '3 min',
        '3 minutes',
        '3 seconds',
        '3 secs',
        '3 sec',
        'last 5 min',
        'last 5 mins',
        'last 5 minutes',
        'last 5 sec',
        'last 5 secs',
        'last 5 seconds'
      ]
      for (const request of timeWindowRequests) {
        const timeRef10 = detectTimeQuery(request, startTime)
        expect(timeRef10).not.toBeNull()
        expect(timeRef10!.type).toEqual('relative')
        expect(timeRef10!.duration).toBeGreaterThanOrEqual(30)
        expect(timeRef10!.direction).toEqual('last')
      }
    })
  })

  // Late joiner / from the beginning handling (checkJustJoinedRequest)
  describe('Late Joiner/From the Beginning Queries (checkJustJoinedRequest)', () => {
    it('detects joined/start/beginning questions with "what did I miss" style phrasing', () => {
      // tests checkJustJoinedRequest: content + beginning/start indicators (pattern 0)
      const testStartTime = new Date()
      testStartTime.setHours(
        testStartTime.getHours() - 1,
        testStartTime.getMinutes(),
        testStartTime.getSeconds(),
        testStartTime.getMilliseconds()
      )

      const requestsPattern0 = [
        'What happened since the beginning?',
        'What have I missed from the start?',
        'What did I miss since we started?',
        'What did I miss so far?',
        'From the beginning, what happened?',
        'Tell me everything from the start',
        'What happened from the top?',
        'Give me a summary from the beginning',
        'Recap everything from the start',
        'from the beginning',
        'Bring me up to speed from the start',
        'What happened since the beginning?',
        'What was discussed since we started?',
        'What was covered from the start?',
        'What all happened since the beginning?',
        'What was said since we started?'
      ]

      for (const req of requestsPattern0) {
        const timeRef = detectTimeQuery(req, testStartTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toEqual(60 * 60)
        expect(timeRef!.direction).toEqual('first')
      }
    })

    it('detects explicit "joined/came in/got here" late joiner phrasing', () => {
      // tests checkJustJoinedRequest: joined/came in/got here phrasing (pattern 1)
      const testStartTime = new Date()
      testStartTime.setHours(
        testStartTime.getHours() - 1,
        testStartTime.getMinutes(),
        testStartTime.getSeconds(),
        testStartTime.getMilliseconds()
      )

      const requestsPattern1 = [
        'I just joined. What did I miss?',
        'Just joined, what happened?',
        'I came in late, what have I missed?',
        'Just got here, catch me up',
        'I arrived late, fill me in',
        'Just entered the meeting, what did I miss?',
        'What did I miss since I joined?'
      ]

      for (const req of requestsPattern1) {
        const timeRef = detectTimeQuery(req, testStartTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toEqual(60 * 60)
        expect(timeRef!.direction).toEqual('first')
      }
    })

    it('detects standalone "everything" requests', () => {
      // tests checkJustJoinedRequest: standalone "tell/show/give me everything" (patterns 2/3)
      const testStartTime = new Date()
      testStartTime.setHours(
        testStartTime.getHours() - 1,
        testStartTime.getMinutes(),
        testStartTime.getSeconds(),
        testStartTime.getMilliseconds()
      )

      const requestsPattern2And3 = [
        'Tell me everything',
        'Show me everything',
        'Give me everything',
        'Fill me in on everything',
        'from everything'
      ]

      for (const req of requestsPattern2And3) {
        const timeRef = detectTimeQuery(req, testStartTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toEqual(60 * 60)
        expect(timeRef!.direction).toEqual('first')
      }
    })
  })

  // Recent content / colloquial clarification handling (checkRecentContentRequest)
  describe('Recent Content/Colloquial Queries (checkRecentContentRequest)', () => {
    it('matches clarification requests like "what was that" / "huh" / "pardon"', () => {
      // tests checkRecentContentRequest: simple clarification phrases (pattern 0)
      const requests = ['What was that?', 'What?', 'Wait, what?', 'Huh?', 'Pardon?', 'Pardon me?', 'Excuse me?', 'Sorry?']
      for (const req of requests) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toEqual(60)
        expect(timeRef!.direction).toEqual('last')
      }
    })

    it('matches "what did he/she/they just say" style questions', () => {
      // tests checkRecentContentRequest: "what did [subject] (just) say/mention" (pattern 1)
      const requests = [
        'What did he say?',
        'What did she just say?',
        'What did they just mention?',
        'What did the speaker just say'
      ]
      for (const req of requests) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toEqual(60)
        expect(timeRef!.direction).toEqual('last')
      }
    })

    it('matches "what did I just miss" style questions', () => {
      // tests checkRecentContentRequest: "what did I just miss" (pattern 2)
      const requests = ['What did I just miss', 'What did I just miss?']
      for (const req of requests) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toEqual(60)
        expect(timeRef!.direction).toEqual('last')
      }
    })

    it('matches "what is he/she talking about (now)" questions', () => {
      // tests checkRecentContentRequest: "what is [pronoun] talking about (now)" (pattern 3)
      const requests = [
        'What is she talking about now?',
        'What is she talking about?',
        'What is he talking about?',
        'What is he talking about now?'
      ]
      for (const req of requests) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toEqual(60)
        expect(timeRef!.direction).toEqual('last')
      }
    })

    it("matches 'didn't catch/hear/get that' style expressions", () => {
      // tests checkRecentContentRequest: "didn't catch/hear/get that" and similar (pattern 4)
      const requests = [
        "I didn't catch that",
        "I didn't hear that",
        'I missed that',
        "Sorry, didn't hear you",
        "Didn't get that last part",
        "Didn't catch that bit",
        "Sorry, didn't hear that last thing",
        'I missed what he said',
        'I missed what they said',
        "I didn't hear what she said"
      ]
      for (const req of requests) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toEqual(60)
        expect(timeRef!.direction).toEqual('last')
      }
    })

    it('matches repeat requests like "repeat that" / "say that again"', () => {
      // tests checkRecentContentRequest: repeat/say again patterns (pattern 5)
      const requests = [
        'Can you repeat that?',
        'Can you repeat that please?',
        'Could you say that again?',
        'Repeat that',
        'Say that again',
        'Can you repeat that please?'
      ]
      for (const req of requests) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toEqual(60)
        expect(timeRef!.direction).toEqual('last')
      }
    })
  })

  // Entire transcript catch-up phrases should return direction: 'first' and full duration
  describe('Entire Transcript Catch-up Phrases', () => {
    it('returns direction "first" and full duration for entire transcript catch-up phrases', () => {
      const testStartTime = new Date()
      testStartTime.setHours(testStartTime.getHours() - 2) // 2 hours ago
      const now = new Date()
      const durationSeconds = Math.max(30, Math.floor((now.getTime() - testStartTime.getTime()) / 1000))

      const entireTranscriptPhrases = [
        'catch me up',
        'what did I miss',
        'on what I missed',
        'what has been said',
        'what happened',
        'what was said',
        'what is this about',
        'what has been discussed',
        'what has been covered',
        'what has been mentioned',
        'what has been announced',
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
        "what's been summarized",
        "what's been recapped",
        "what's been presented",
        "what's been explained",
        "what's been shown",
        "what's been told",
        "what's been given",
        "what's been brought up",
        "what's been gone over",
        "what's been discussed about"
      ]
      for (const req of entireTranscriptPhrases) {
        const timeRef = detectTimeQuery(req, testStartTime, now)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.direction).toEqual('first')
        // Allow a small margin for timing differences
        expect(Math.abs(timeRef!.duration! - durationSeconds)).toBeLessThanOrEqual(2)
      }
    })

    it('returns direction "first" and full duration for transcript request phrases', () => {
      const testStartTime = new Date()
      testStartTime.setHours(testStartTime.getHours() - 2)
      const now = new Date()
      const durationSeconds = Math.max(30, Math.floor((now.getTime() - testStartTime.getTime()) / 1000))

      const transcriptPhrases = [
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
        'can i get transcript',
        // Add some with question marks and polite forms
        'can you send me a transcript so far?',
        'can i get the transcript so far?',
        'can you send the transcript so far please?',
        'can i have the transcript so far please?',
        'can you send transcript so far?',
        'can i get transcript so far?'
      ]
      for (const req of transcriptPhrases) {
        const timeRef = detectTimeQuery(req, testStartTime, now)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.direction).toEqual('first')
        expect(Math.abs(timeRef!.duration! - durationSeconds)).toBeLessThanOrEqual(2)
      }
    })
  })

  // Generic catch-up / summary / meta queries (checkCatchupSummaryRequest + timeKeywords)
  describe('Catch-up/Summary/Meta Queries (checkCatchupSummaryRequest + timeKeywords)', () => {
    it('detects standalone and colloquial catch-up/summary requests using core phrases', () => {
      // tests checkCatchupSummaryRequest: phrase set and normalized exact matches
      const catchupRequests = [
        "what's happening",
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
        'what is being discussed about'
      ]
      for (const req of catchupRequests) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.direction).toEqual('last')
      }
    })

    it('handles colloquial "whats/what s" variants and light misspellings', () => {
      // tests checkCatchupSummaryRequest: catchupSummaryPatterns[0] (whats/what s variants)
      const variants = [
        'whats happening?',
        'whats going on rn?',
        'what s going on',
        'whats goin on?',
        'whats up with this meeting?',
        'what s up?',
        'what is goin on here',
        'whats happening lol'
      ]
      for (const req of variants) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toBeGreaterThanOrEqual(30)
        expect(timeRef!.direction).toEqual('last')
      }
    })

    it('handles polite, abbreviated, and slangy catch-up requests', () => {
      // tests checkCatchupSummaryRequest: catchupSummaryPatterns[1] (catch/fill/bring/get me up to speed)
      const variants = [
        'can you catch me up?',
        'could u catch me up real quick?',
        'pls catch me up on this',
        'plz catch me up',
        'please fill me in',
        'can u fill me in on this?',
        'could you bring me up to speed?',
        'can you get me up to speed on what I missed?'
      ]
      for (const req of variants) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toBeGreaterThanOrEqual(30)
        expect(timeRef!.direction).toEqual('first')
      }
    })

    it('handles quick recap / TLDR style summary requests', () => {
      // tests checkCatchupSummaryRequest: catchupSummaryPatterns[2] (quick recap/summary, tl;dr)
      const variants = [
        'quick recap?',
        'quick summary of what I missed',
        'tl dr what just happened',
        'tl  dr of this meeting',
        'tldr on this convo'
      ]
      for (const req of variants) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toBeGreaterThanOrEqual(30)
        expect(timeRef!.direction).toEqual('first')
      }
    })

    it('handles "what is the gist" style gist/summary questions', () => {
      // tests checkCatchupSummaryRequest: catchupSummaryPatterns[3] ("what is/whats the gist")
      const variants = [
        'whats the gist?',
        "what's the gist of this?",
        'what is the gist of that?',
        'what s the gist of this convo',
        'whats the gist of this meeting'
      ]
      for (const req of variants) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.duration).toBeGreaterThanOrEqual(30)
        expect(timeRef!.direction).toEqual('first')
      }
    })
  })

  // Ambiguous/colloquial summary queries that rely on timeKeywords + question words
  describe('Ambiguous/Colloquial Summary Queries (timeKeywords + question words)', () => {
    it('detects ambiguous/colloquial recent summary requests', () => {
      // tests detectTimeQuery: timeKeywords + question word gating for summary-like queries
      const ambiguousRequests = [
        "what's happening?",
        "what's going on?",
        'what is up?',
        "what's up?",
        "what's being discussed?",
        "what's being talked about?",
        "what's being said?",
        "what's being covered?",
        "what's being mentioned?",
        "what's being announced?",
        "what's being noted?",
        "what's being summarized?",
        "what's being recapped?",
        "what's being presented?",
        "what's being explained?",
        "what's being shown?",
        "what's being told?",
        "what's being given?",
        "what's being brought up?",
        "what's being gone over?",
        "what's being discussed about?"
      ]
      for (const req of ambiguousRequests) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.direction).toEqual('last')
      }
    })
    it('detects ambiguous/colloquial entire event summary requests', () => {
      // tests detectTimeQuery: timeKeywords + question word gating for summary-like queries
      const ambiguousRequests = [
        'what has been said?',
        'what has been discussed?',
        'what has been covered?',
        'what has been mentioned?',
        'what has been announced?',
        'what has been noted?',
        'what has been summarized?',
        'what has been recapped?',
        'what has been presented?',
        'what has been explained?',
        'what has been shown?',
        'what has been told?',
        'what has been given?',
        'what has been brought up?',
        'what has been gone over?',
        'what has been discussed about?',
        'what is this about?'
      ]
      for (const req of ambiguousRequests) {
        const timeRef = detectTimeQuery(req, startTime)
        expect(timeRef).not.toBeNull()
        expect(timeRef!.type).toEqual('relative')
        expect(timeRef!.direction).toEqual('first')
      }
    })
  })
})
