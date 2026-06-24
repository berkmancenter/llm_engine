import {
  selectSparkCandidates,
  groundReception,
  MAX_RECEPTIONS
} from '../../../../src/agents/vibesAnalyst/quoteReception.js'

/* All test messages hang off this base time. The reaction window is 3 minutes, so
   chat placed within 3 minutes after a transcript line counts as its reaction. */
const BASE = new Date('2026-06-10T10:00:00.000Z').getTime()
function at(minute: number): Date {
  return new Date(BASE + minute * 60 * 1000)
}

function transcriptLine(minute: number, body: string, pseudonym = 'Speaker') {
  return { body, pseudonym, fromAgent: false, createdAt: at(minute), channels: ['transcript'] }
}

function chatMessage(minute: number, body: string, options: { fromAgent?: boolean } = {}) {
  return { body, pseudonym: 'ana', fromAgent: options.fromAgent ?? false, createdAt: at(minute), channels: ['chat'] }
}

describe('selectSparkCandidates', () => {
  // posterCount 10 keeps the floor at its absolute minimum of 3 reactions.
  const posterCount = 10

  it('selects a transcript line that drew enough chat reaction', () => {
    const transcript = [transcriptLine(5, 'We should ban gas stoves entirely.')]
    const chat = [
      chatMessage(5.5, 'No way, gas is better for cooking'),
      chatMessage(6, 'agreed, electric is the future'),
      chatMessage(6.5, 'my landlord would never'),
      chatMessage(7, 'induction is amazing actually')
    ]

    const candidates = selectSparkCandidates(transcript, chat, posterCount)

    expect(candidates).toHaveLength(1)
    expect(candidates[0].sparkMessage.body).toBe('We should ban gas stoves entirely.')
    expect(candidates[0].reactionVolume).toBe(4)
    expect(candidates[0].reactionChat).toHaveLength(4)
  })

  it('ignores a line whose reaction stays below the floor', () => {
    const transcript = [transcriptLine(30, 'A minor aside no one picked up.')]
    const chat = [chatMessage(31, 'ok')]

    const candidates = selectSparkCandidates(transcript, chat, posterCount)

    expect(candidates).toEqual([])
  })

  it('suppresses an overlapping nearby line, keeping the stronger one', () => {
    const transcript = [
      transcriptLine(5, 'The strong claim that set people off.'),
      transcriptLine(6, 'A follow-up a minute later.')
    ]
    const chat = [
      chatMessage(5.5, 'whoa really'),
      chatMessage(6, 'I do not buy that'),
      chatMessage(6.5, 'say more'),
      chatMessage(7, 'this changes everything')
    ]

    const candidates = selectSparkCandidates(transcript, chat, posterCount)

    expect(candidates).toHaveLength(1)
    expect(candidates[0].sparkMessage.body).toBe('The strong claim that set people off.')
    expect(candidates[0].reactionVolume).toBe(4)
  })

  it('caps the number of receptions, keeping the strongest', () => {
    const transcript = [
      transcriptLine(5, 'First big moment.'),
      transcriptLine(20, 'Second big moment.'),
      transcriptLine(40, 'Third moment, a bit weaker.')
    ]
    const chat = [
      chatMessage(5.2, 'a'),
      chatMessage(5.4, 'b'),
      chatMessage(5.6, 'c'),
      chatMessage(5.8, 'd'),
      chatMessage(6, 'e'),
      chatMessage(20.2, 'f'),
      chatMessage(20.4, 'g'),
      chatMessage(20.6, 'h'),
      chatMessage(20.8, 'i'),
      chatMessage(40.2, 'j'),
      chatMessage(40.4, 'k'),
      chatMessage(40.6, 'l')
    ]

    const candidates = selectSparkCandidates(transcript, chat, posterCount)

    expect(candidates).toHaveLength(MAX_RECEPTIONS)
    expect(candidates.map((candidate) => candidate.reactionVolume)).toEqual([5, 4])
  })

  it('counts only participant messages in the reaction, not the bot', () => {
    const transcript = [transcriptLine(5, 'Something that drew people in.')]
    const chat = [
      chatMessage(5.3, 'I have a question about that'),
      chatMessage(5.6, 'me too'),
      chatMessage(5.9, 'same here'),
      chatMessage(5.5, 'Great question! Here is my take.', { fromAgent: true }),
      chatMessage(6.1, 'Happy to expand on that.', { fromAgent: true })
    ]

    const candidates = selectSparkCandidates(transcript, chat, posterCount)

    expect(candidates).toHaveLength(1)
    expect(candidates[0].reactionVolume).toBe(3)
    expect(candidates[0].reactionChat.every((message) => !message.fromAgent)).toBe(true)
  })
})

describe('groundReception', () => {
  function candidate() {
    return {
      sparkMessage: { body: 'We should ban gas stoves entirely.', channels: ['transcript'] },
      reactionVolume: 4,
      reactionChat: [{ body: 'No way, gas is better for cooking' }, { body: 'agreed, electric is the future' }]
    }
  }

  it('keeps a reception when both quotes are real and the sentiment is valid', () => {
    const result = groundReception(candidate(), {
      sparkQuote: 'ban gas stoves',
      reactionQuote: 'No way, gas is better for cooking',
      sentiment: 'pushback'
    })

    expect(result).toEqual({
      sparkQuote: 'ban gas stoves',
      reactionVolume: 4,
      reactionQuote: 'No way, gas is better for cooking',
      sentiment: 'pushback'
    })
  })

  it('drops a reception whose spark quote is not in the transcript line', () => {
    const result = groundReception(candidate(), {
      sparkQuote: 'tax carbon heavily',
      reactionQuote: 'No way, gas is better for cooking',
      sentiment: 'pushback'
    })

    expect(result).toBeNull()
  })

  it('drops a reception whose reaction quote was never said', () => {
    const result = groundReception(candidate(), {
      sparkQuote: 'ban gas stoves',
      reactionQuote: 'this is totally made up',
      sentiment: 'agreement'
    })

    expect(result).toBeNull()
  })

  it('drops a reception with an unrecognized sentiment label', () => {
    const result = groundReception(candidate(), {
      sparkQuote: 'ban gas stoves',
      reactionQuote: 'No way, gas is better for cooking',
      sentiment: 'angry'
    })

    expect(result).toBeNull()
  })
})
