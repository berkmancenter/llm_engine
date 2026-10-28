import { isZoomUrl, isValidPropertyFormat } from '../../../src/conversations/propertyFormats.js'

describe('isZoomUrl()', () => {
  it('accepts a bare zoom.us meeting URL', () => {
    expect(isZoomUrl('https://zoom.us/j/123456789')).toBe(true)
  })

  it('accepts a vanity subdomain', () => {
    expect(isZoomUrl('https://harvard.zoom.us/j/123456789')).toBe(true)
  })

  it('accepts a vanity-subdomain webinar join URL (the /w/ path, not /j/)', () => {
    // Matches a real Zoom-generated webinar invite's join link.
    expect(isZoomUrl('https://huitstage.zoom.us/w/93875854509?tk=abc&pwd=def')).toBe(true)
  })

  it('rejects a non-Zoom host', () => {
    expect(isZoomUrl('https://teams.microsoft.com/l/meetup-join/abc123')).toBe(false)
  })

  it('rejects a spoof where zoom.us is only the userinfo, not the real host', () => {
    expect(isZoomUrl('https://zoom.us@evil.com/j/123456789')).toBe(false)
  })

  it('rejects a host that merely contains zoom.us as a substring, not a subdomain', () => {
    expect(isZoomUrl('https://notzoom.us.evil.com/j/123456789')).toBe(false)
  })

  it('rejects an unparseable string', () => {
    expect(isZoomUrl('not a url at all')).toBe(false)
  })

  it('rejects non-string input without throwing', () => {
    expect(isZoomUrl(undefined)).toBe(false)
    expect(isZoomUrl(null)).toBe(false)
    expect(isZoomUrl(42)).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isZoomUrl('')).toBe(false)
  })
})

describe('isValidPropertyFormat()', () => {
  it('delegates "zoomUrl" to isZoomUrl', () => {
    expect(isValidPropertyFormat('zoomUrl', 'https://zoom.us/j/123456789')).toBe(true)
    expect(isValidPropertyFormat('zoomUrl', 'https://teams.microsoft.com/l/meetup-join/abc')).toBe(false)
  })
})
