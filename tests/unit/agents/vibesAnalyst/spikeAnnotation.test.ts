import {
  groundAnnotation,
  isQuotableChat,
  isQuotableModerator,
  messagesDuringSpike,
  quoteAppearsIn,
  spikeQuotePool,
  topSpikesBySignificance
} from '../../../../src/agents/vibesAnalyst/spikeAnnotation.js'
import { ChatSpike, SpikeSource } from '../../../../src/types/index.types.js'

const EVENT_START = new Date('2026-06-10T10:00:00.000Z')
const at = (minutes: number) => new Date(EVENT_START.getTime() + minutes * 60 * 1000)

function spike(startMinute: number, messageCount: number, ratio: number | null, source: SpikeSource = 'chat'): ChatSpike {
  return {
    label: `${startMinute}-${startMinute + 10}`,
    startMinute,
    endMinute: startMinute + 10,
    messageCount,
    baselineAverage: ratio === null ? 0 : messageCount / ratio,
    ratio,
    source
  }
}

describe('messagesDuringSpike', () => {
  const windowSpike = spike(20, 5, 5)

  it('keeps only messages whose timestamp falls inside the spike window', () => {
    const messages = [
      { body: 'before', createdAt: at(19) },
      { body: 'at start', createdAt: at(20) },
      { body: 'inside', createdAt: at(25) },
      { body: 'at end', createdAt: at(30) },
      { body: 'after', createdAt: at(31) }
    ]

    const inWindow = messagesDuringSpike(messages, EVENT_START, windowSpike)

    // Start is inclusive, end is exclusive, matching how buckets are assigned.
    expect(inWindow.map((m) => m.body)).toEqual(['at start', 'inside'])
  })
})

describe('isQuotableChat', () => {
  it('keeps a participant line posted in the public chat', () => {
    expect(isQuotableChat({ body: 'hi', fromAgent: false, channels: ['chat'] })).toBe(true)
  })

  it('rejects a transcript speaker line, so a chat spike never quotes the transcript', () => {
    expect(isQuotableChat({ body: 'hi', fromAgent: false, channels: ['transcript'] })).toBe(false)
  })

  it('rejects a moderator backchannel line', () => {
    expect(isQuotableChat({ body: 'hi', fromAgent: false, channels: ['moderator'] })).toBe(false)
  })

  it('rejects a bot message even when it is on the chat channel', () => {
    expect(isQuotableChat({ body: 'hi', fromAgent: true, channels: ['chat'] })).toBe(false)
  })

  it('rejects a message with no channel', () => {
    expect(isQuotableChat({ body: 'hi', fromAgent: false })).toBe(false)
  })
})

describe('isQuotableModerator', () => {
  it('keeps a participant line in the moderator backchannel', () => {
    expect(isQuotableModerator({ body: 'hi', fromAgent: false, channels: ['moderator'] })).toBe(true)
  })

  it('rejects a public chat line, so a moderator spike never quotes the chat', () => {
    expect(isQuotableModerator({ body: 'hi', fromAgent: false, channels: ['chat'] })).toBe(false)
  })

  it('rejects a bot message even when it is on the moderator channel', () => {
    expect(isQuotableModerator({ body: 'hi', fromAgent: true, channels: ['moderator'] })).toBe(false)
  })
})

describe('spikeQuotePool', () => {
  const chatLine = { body: 'public', fromAgent: false, channels: ['chat'] }
  const moderatorLine = { body: 'backchannel', fromAgent: false, channels: ['moderator'] }
  const messages = [chatLine, moderatorLine]

  it('offers only the chat lines for a chat-source spike', () => {
    expect(spikeQuotePool(messages, 'chat')).toEqual([chatLine])
  })

  it('offers only the moderator lines for a moderator-source spike', () => {
    expect(spikeQuotePool(messages, 'moderator')).toEqual([moderatorLine])
  })

  it('offers nothing for a private-source spike, whose messages are never read', () => {
    expect(spikeQuotePool(messages, 'private')).toEqual([])
  })
})

describe('quoteAppearsIn', () => {
  const messages = [
    { body: 'The layoffs hit the whole team at once.', createdAt: at(21) },
    { body: { kind: 'image', url: 'x' }, createdAt: at(22) }
  ]

  it('matches a verbatim quote', () => {
    expect(quoteAppearsIn('The layoffs hit the whole team at once.', messages)).toBe(true)
  })

  it('matches despite whitespace and case differences', () => {
    expect(quoteAppearsIn('the LAYOFFS   hit the whole team', messages)).toBe(true)
  })

  it('rejects a quote that is not present', () => {
    expect(quoteAppearsIn('we doubled revenue this quarter', messages)).toBe(false)
  })

  it('rejects an empty quote so it cannot trivially match', () => {
    expect(quoteAppearsIn('   ', messages)).toBe(false)
  })

  it('ignores non-text message bodies', () => {
    expect(quoteAppearsIn('image', messages)).toBe(false)
  })
})

describe('groundAnnotation', () => {
  const windowMessages = [{ body: 'The layoffs hit the whole team at once.', createdAt: at(21) }]

  it('keeps a topic when its quote is verbatim window text', () => {
    const annotation = groundAnnotation(
      { topic: 'reaction to the layoffs', quote: 'The layoffs hit the whole team at once.' },
      windowMessages
    )

    expect(annotation).toEqual({ topic: 'reaction to the layoffs', quote: 'The layoffs hit the whole team at once.' })
  })

  it('drops an annotation whose quote was never said', () => {
    expect(groundAnnotation({ topic: 'good news', quote: 'we tripled revenue this quarter' }, windowMessages)).toBeNull()
  })

  it('drops an annotation with an empty topic', () => {
    expect(groundAnnotation({ topic: '   ', quote: 'The layoffs hit the whole team at once.' }, windowMessages)).toBeNull()
  })
})

describe('topSpikesBySignificance', () => {
  const early = spike(0, 6, 2)
  const middle = spike(20, 18, 9)
  const silentBaseline = spike(40, 9, null)

  it('ranks finite-ratio spikes above a zero-baseline spike, not below it', () => {
    // silentBaseline has a null ratio (the rest of the event was silent). A null ratio
    // must not be treated as infinitely significant, so both measured spikes outrank it
    // and the highest ratio leads.
    const ranked = topSpikesBySignificance([early, middle, silentBaseline], 3)
    expect(ranked.map((s) => s.startMinute)).toEqual([20, 0, 40])
  })

  it('ranks a louder zero-baseline spike above a quieter one by raw message count', () => {
    const quietSilent = spike(0, 4, null)
    const loudSilent = spike(30, 12, null)

    const top = topSpikesBySignificance([quietSilent, loudSilent], 1)
    expect(top.map((s) => s.startMinute)).toEqual([30])
  })

  it('returns every spike when the cap exceeds the count', () => {
    const top = topSpikesBySignificance([early, middle], 5)
    expect(top).toHaveLength(2)
  })
})
