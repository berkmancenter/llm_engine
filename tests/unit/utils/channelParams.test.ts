import parseChannelParams from '../../../src/utils/channelParams.js'

describe('parseChannelParams', () => {
  it('parses a single name,passcode pair', () => {
    expect(parseChannelParams('moderator,abc123')).toEqual([{ name: 'moderator', passcode: 'abc123' }])
  })

  // Express hands back a bare string for one `channel=` and an array for several.
  it('parses every pair when the query string repeats the parameter', () => {
    expect(parseChannelParams(['moderator,abc123', 'transcript,def456'])).toEqual([
      { name: 'moderator', passcode: 'abc123' },
      { name: 'transcript', passcode: 'def456' }
    ])
  })

  it('trims whitespace around the name and the passcode', () => {
    expect(parseChannelParams(' moderator , abc123 ')).toEqual([{ name: 'moderator', passcode: 'abc123' }])
  })

  it('leaves the passcode undefined for a channel that has none', () => {
    expect(parseChannelParams('chat')).toEqual([{ name: 'chat', passcode: undefined }])
  })

  it('returns an empty list when the query string names no channels', () => {
    expect(parseChannelParams(undefined)).toEqual([])
    expect(parseChannelParams('')).toEqual([])
  })
})
