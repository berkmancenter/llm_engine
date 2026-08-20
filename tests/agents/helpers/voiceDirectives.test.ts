import { AgentMessageActions } from '../../../src/types/index.types.js'
import { evaluateVoiceTrigger, extractVoiceQuestion } from '../../../src/agents/helpers/voiceDirectives.js'

function msg(body: string, channels = ['transcript']) {
  return { body, bodyType: 'text', channels } as never
}

const botName = 'Berkie'

describe('evaluateVoiceTrigger', () => {
  it('contributes when message contains an inline hey trigger with a question', () => {
    const result = evaluateVoiceTrigger(msg(`hey ${botName} what is going on?`), botName, [])
    expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
    expect(result.userMessage.body).toBe(`hey ${botName} what is going on?`)
  })

  it('returns OK when no hey trigger is present', () => {
    const result = evaluateVoiceTrigger(msg('part-time work is interesting'), botName, [])
    expect(result.action).toEqual(AgentMessageActions.OK)
    expect(result.userMessage.body).toBe('part-time work is interesting')
  })

  it('returns OK for a bare hey trigger with no question, waiting for next message', () => {
    const result = evaluateVoiceTrigger(msg(`hey ${botName}`), botName, [])
    expect(result.action).toEqual(AgentMessageActions.OK)
    expect(result.userMessage.body).toBe(`hey ${botName}`)
  })

  it('normalizes misspelled bot name for inline hey trigger', () => {
    const result = evaluateVoiceTrigger(msg('hey Burkie what is part-time work?'), botName, [])
    expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
    expect(result.userMessage.body).toBe(`hey ${botName} what is part-time work?`)
  })

  it('normalizes misspelled bot name for bare hey trigger', () => {
    const result = evaluateVoiceTrigger(msg('hey berkey'), botName, [])
    expect(result.action).toEqual(AgentMessageActions.OK)
    expect(result.userMessage.body).toBe(`hey ${botName}`)
  })

  it('contributes for a deferred question when previous transcript message was a bare hey trigger', () => {
    const prevMsg = msg(`hey ${botName}`)
    const currMsg = msg('what did Jessica say about flexible work?')
    const result = evaluateVoiceTrigger(currMsg, botName, [prevMsg])
    expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
    expect(result.userMessage.body).toBe('what did Jessica say about flexible work?')
  })

  it('returns OK when previous transcript message had an inline question, not a bare trigger', () => {
    const prevMsg = msg(`hey ${botName} what is part-time work?`)
    const currMsg = msg('tell me more')
    const result = evaluateVoiceTrigger(currMsg, botName, [prevMsg])
    expect(result.action).toEqual(AgentMessageActions.OK)
    expect(result.userMessage.body).toBe('tell me more')
  })

  it('matches hey trigger anywhere in the message, not just at the start', () => {
    const result = evaluateVoiceTrigger(msg(`so hey ${botName} what is this talk about?`), botName, [])
    expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
  })

  it('returns OK for bare hey trigger mid-message with no question after it', () => {
    const result = evaluateVoiceTrigger(msg(`okay so hey ${botName}`), botName, [])
    expect(result.action).toEqual(AgentMessageActions.OK)
  })

  it('handles punctuation on hey and bot name (hey, Berkie,)', () => {
    const result = evaluateVoiceTrigger(msg('hey, Berkie, what is part-time work?'), botName, [])
    expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
  })

  // Fuzzy bot name matching — fuzzball scores vs 'Berkie'
  it('fuzzy matches "Burkie" (~83, passes threshold)', () => {
    const result = evaluateVoiceTrigger(msg('hey Burkie what is part-time work?'), botName, [])
    expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
    expect(result.userMessage.body).toBe(`hey ${botName} what is part-time work?`)
  })

  it('fuzzy matches "Birkie" (~83, passes threshold)', () => {
    const result = evaluateVoiceTrigger(msg('hey Birkie what is part-time work?'), botName, [])
    expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
    expect(result.userMessage.body).toBe(`hey ${botName} what is part-time work?`)
  })

  it('fuzzy matches "Berkee" (~83, passes threshold)', () => {
    const result = evaluateVoiceTrigger(msg('hey Berkee what is part-time work?'), botName, [])
    expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
    expect(result.userMessage.body).toBe(`hey ${botName} what is part-time work?`)
  })

  it('fuzzy matches "Berkye" (~83, passes threshold)', () => {
    const result = evaluateVoiceTrigger(msg('hey Berkye what is part-time work?'), botName, [])
    expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
    expect(result.userMessage.body).toBe(`hey ${botName} what is part-time work?`)
  })

  it('fuzzy matches "Berk" (~80, passes threshold)', () => {
    const result = evaluateVoiceTrigger(msg('hey Berk what is part-time work?'), botName, [])
    expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
    expect(result.userMessage.body).toBe(`hey ${botName} what is part-time work?`)
  })

  it('fuzzy matches "Berky" (~73, passes nameMatchThreshold of 70)', () => {
    const result = evaluateVoiceTrigger(msg('hey Berky what is part-time work?'), botName, [])
    expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
    expect(result.userMessage.body).toBe(`hey ${botName} what is part-time work?`)
  })
})

describe('extractVoiceQuestion', () => {
  it('returns null when no hey trigger is present', () => {
    expect(extractVoiceQuestion(msg('part-time work is interesting'), [], botName)).toBeNull()
  })

  it('returns null for a bare hey trigger with no inline question', () => {
    expect(extractVoiceQuestion(msg(`hey ${botName}`), [], botName)).toBeNull()
  })

  it('returns the inline question text', () => {
    expect(extractVoiceQuestion(msg(`hey ${botName} what is part-time work?`), [], botName)).toBe(
      'What is part-time work?'
    )
  })

  it('capitalizes the first letter of the extracted question', () => {
    expect(extractVoiceQuestion(msg(`hey ${botName} what is this?`), [], botName)).toBe('What is this?')
  })

  it('returns current message text when previous transcript message was a bare hey trigger', () => {
    const prevMsg = msg(`hey ${botName}`)
    const currMsg = msg('what did Jessica say about flexible work?')
    expect(extractVoiceQuestion(currMsg, [prevMsg], botName)).toBe('what did Jessica say about flexible work?')
  })

  it('returns null when previous transcript message had an inline question', () => {
    const prevMsg = msg(`hey ${botName} what is part-time work?`)
    const currMsg = msg('tell me more')
    expect(extractVoiceQuestion(currMsg, [prevMsg], botName)).toBeNull()
  })

  it('only uses the previous transcript message for deferred lookback, ignoring non-transcript messages', () => {
    const nonTranscriptMsg = msg(`hey ${botName}`, ['chat'])
    const currMsg = msg('what did Jessica say?')
    // non-transcript messages should not act as a bare trigger
    expect(extractVoiceQuestion(currMsg, [nonTranscriptMsg], botName)).toBeNull()
  })
})
