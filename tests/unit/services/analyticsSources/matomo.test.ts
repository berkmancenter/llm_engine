import { jest } from '@jest/globals'

// Set Matomo config before anything loads the config module, so the fetcher sees it.
process.env.MATOMO_BASE_URL = 'https://matomo.example'
process.env.MATOMO_TOKEN = 'secret-token'
process.env.MATOMO_SITE_ID = '7'

const { fetchMatomoSnapshot } = await import('../../../../src/services/analyticsSources/matomo.js')
const config = (await import('../../../../src/config/config.js')).default

// Unix-seconds timestamp for a clock time on the event day, to build visit logs.
function ts(hms: string): number {
  return Math.floor(Date.parse(`2026-06-10T${hms}.000Z`) / 1000)
}

/* The event window is 09:00 to 10:30. Three visits whose sessions overlap it by
   different amounts: one starts before and leaves mid-event (30 min in), one joins
   mid-event and lingers past the end (75 min in), and one single-action visit (0).
   Clipped to the window the three contribute 1800 + 4500 + 0 = 6300 seconds, even
   though their raw session lengths run well past the event.

   The windowed counts are derived from this same log. visitorId 'v1' appears on two
   of the three visits, so the distinct attendee count is 2 (v1 and v2), not 3. Every
   visit overlaps the window, so all three count toward totalVisits. The actionDetails
   carry per-action timestamps: actions stamped outside 09:00-10:30 (08:55 and 10:45)
   are excluded, leaving five in-window actions across the three visits.

   Each visit also carries a deviceType, tallied by visit into the device breakdown:
   two Desktop and one Smartphone, so the breakdown sums to the three in-window visits. */
const visitDetailsResponse = [
  {
    visitorId: 'v1',
    deviceType: 'Desktop',
    firstActionTimestamp: ts('08:50:00'),
    lastActionTimestamp: ts('09:30:00'),
    actionDetails: [{ timestamp: ts('08:55:00') }, { timestamp: ts('09:05:00') }, { timestamp: ts('09:25:00') }]
  },
  {
    visitorId: 'v2',
    deviceType: 'Smartphone',
    firstActionTimestamp: ts('09:15:00'),
    lastActionTimestamp: ts('11:00:00'),
    actionDetails: [{ timestamp: ts('09:20:00') }, { timestamp: ts('10:00:00') }, { timestamp: ts('10:45:00') }]
  },
  {
    visitorId: 'v1',
    deviceType: 'Desktop',
    firstActionTimestamp: ts('09:00:00'),
    lastActionTimestamp: ts('09:00:00'),
    actionDetails: [{ timestamp: ts('09:00:00') }]
  }
]
const DWELL_WITHIN_EVENT = 6300
const WINDOWED_VISITS = 3
const WINDOWED_ATTENDEES = 2
const WINDOWED_ACTIONS = 5
const WINDOWED_DEVICE_BREAKDOWN = { Desktop: 2, Smartphone: 1 }

function eventConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'c1',
    startTime: new Date('2026-06-10T09:00:00.000Z'),
    endTime: new Date('2026-06-10T10:30:00.000Z'),
    analyticsRefs: new Map([['matomo', 'dimension7']]),
    ...overrides
  }
}

function bodyForUrl(url: string): unknown {
  if (url.includes('Live.getLastVisitsDetails')) return visitDetailsResponse
  return {}
}

function mockMatomoFetch() {
  return jest
    .spyOn(global, 'fetch')
    .mockImplementation(async (input) => ({ ok: true, json: async () => bodyForUrl(String(input)) } as Response))
}

describe('fetchMatomoSnapshot', () => {
  // The retry path sleeps between attempts; fake timers keep those waits instant.
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('maps the Reporting API response to additive snapshot counts', async () => {
    mockMatomoFetch()

    const snapshot = await fetchMatomoSnapshot(eventConversation())

    expect(snapshot).toEqual({
      attendeeCount: WINDOWED_ATTENDEES,
      totalVisits: WINDOWED_VISITS,
      totalActions: WINDOWED_ACTIONS,
      totalDwellSeconds: DWELL_WITHIN_EVENT,
      deviceBreakdown: WINDOWED_DEVICE_BREAKDOWN
    })
  })

  it('counts dwell as time inside the event window, not the whole browsing session', async () => {
    mockMatomoFetch()

    const snapshot = await fetchMatomoSnapshot(eventConversation())

    // Raw sessions sum to 36000s, but only the part overlapping 09:00-10:30 counts.
    expect(snapshot?.totalDwellSeconds).toBe(DWELL_WITHIN_EVENT)
  })

  it('returns null when the live visit log is unavailable rather than fabricating zero counts', async () => {
    // The visit log is the source of truth for the windowed counts. When Live returns a
    // Matomo-level error on every attempt (HTTP 200 with an error body, so the retry helper
    // still ends up with null), there is no real session data. Storing zeros here would read
    // as "nobody showed up", so the fetch returns null and no snapshot is stored at all.
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('Live.getLastVisitsDetails')) {
        return { ok: true, json: async () => ({ result: 'error', message: 'no live data' }) } as Response
      }
      return { ok: true, json: async () => bodyForUrl(url) } as Response
    })

    const pending = fetchMatomoSnapshot(eventConversation())
    await jest.runAllTimersAsync()
    const snapshot = await pending

    expect(snapshot).toBeNull()
    // The log fetch is retried like the summary call, so a transient archive miss gets
    // several chances before the fetch gives up: one attempt plus three retries.
    const liveCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('Live.getLastVisitsDetails'))
    expect(liveCalls).toHaveLength(4)
  })

  it('returns a zero-count snapshot when the visit log is genuinely empty', async () => {
    // An empty array is a real answer (the event tracked no sessions), not a failed fetch,
    // so the snapshot is still produced with zero counts rather than suppressed.
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('Live.getLastVisitsDetails')) return { ok: true, json: async () => [] } as Response
      return { ok: true, json: async () => bodyForUrl(url) } as Response
    })

    const snapshot = await fetchMatomoSnapshot(eventConversation())

    expect(snapshot).toEqual({
      attendeeCount: 0,
      totalVisits: 0,
      totalActions: 0,
      totalDwellSeconds: 0,
      deviceBreakdown: {}
    })
  })

  it('buckets an in-window visit with no deviceType under "Unknown"', async () => {
    // A visit can arrive with a missing or empty device type; rather than dropping it from
    // the breakdown (which would make the device counts undercount totalVisits), it lands
    // in an "Unknown" bucket so every in-window visit is still represented.
    const oneUnknownDeviceVisit = [
      {
        visitorId: 'v9',
        firstActionTimestamp: ts('09:10:00'),
        lastActionTimestamp: ts('09:20:00'),
        actionDetails: [{ timestamp: ts('09:15:00') }]
      }
    ]
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('Live.getLastVisitsDetails')) return { ok: true, json: async () => oneUnknownDeviceVisit } as Response
      return { ok: true, json: async () => bodyForUrl(url) } as Response
    })

    const snapshot = await fetchMatomoSnapshot(eventConversation())

    expect(snapshot?.deviceBreakdown).toEqual({ Unknown: 1 })
  })

  it('builds the segment from the stored dimension ref and the conversation id, token off the url', async () => {
    const fetchSpy = mockMatomoFetch()

    await fetchMatomoSnapshot(eventConversation())

    // The live visit log is the source of truth for the windowed counts, so its request
    // carries the site, range, and segment that scope the query to this event.
    const liveCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('Live.getLastVisitsDetails'))
    expect(liveCall).toBeDefined()
    const liveParams = new URL(String(liveCall![0])).searchParams
    expect(liveParams.get('idSite')).toBe('7')
    expect(liveParams.get('period')).toBe('range')
    // The queried range is widened one day on each side of the event (Fix 2), so a
    // site timezone west of UTC cannot resolve an evening event onto a calendar day
    // outside the range and return nothing. Exact-timestamp clipping trims the extra.
    expect(liveParams.get('date')).toBe('2026-06-09,2026-06-11')
    // The stored ref names the custom dimension; the adapter pairs it with the
    // conversation id to isolate this event's visits.
    expect(liveParams.get('segment')).toBe('dimension7==c1')
    // The log is fetched unbounded so every visit's timestamps are available to clip
    // dwell to the event window.
    expect(liveParams.get('filter_limit')).toBe('-1')
    // The auth token must not ride in the URL where it would land in logs.
    expect(String(liveCall![0])).not.toContain('secret-token')
  })

  it('returns null when the conversation has no matomo segment', async () => {
    const fetchSpy = mockMatomoFetch()

    const snapshot = await fetchMatomoSnapshot(eventConversation({ analyticsRefs: new Map() }))

    expect(snapshot).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns null when the event has no time window', async () => {
    mockMatomoFetch()

    const snapshot = await fetchMatomoSnapshot(eventConversation({ startTime: undefined }))

    expect(snapshot).toBeNull()
  })

  it('returns null when Matomo config is incomplete', async () => {
    mockMatomoFetch()
    const originalToken = config.matomo.token
    config.matomo.token = undefined

    try {
      const snapshot = await fetchMatomoSnapshot(eventConversation())
      expect(snapshot).toBeNull()
    } finally {
      config.matomo.token = originalToken
    }
  })

  it('retries the live visit log when it keeps failing, then returns null after the bound', async () => {
    // The live visit log is the source of truth for the windowed counts. When it never
    // recovers within the retry budget, the fetch gives up and stores no snapshot.
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 504 } as Response)

    const pending = fetchMatomoSnapshot(eventConversation())
    await jest.runAllTimersAsync()
    const snapshot = await pending

    expect(snapshot).toBeNull()
    // One initial attempt plus three retries on the live log call: a transient archive
    // miss gets several chances before the fetch gives up.
    const liveCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('Live.getLastVisitsDetails'))
    expect(liveCalls).toHaveLength(4)
  })

  it('retries a transient live visit log failure and succeeds once the archive is ready', async () => {
    // The first two live log calls fail (the range archive is still building), the third
    // succeeds. This is the cold-archive race that an event stop hits, now retried.
    let liveAttempts = 0
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('Live.getLastVisitsDetails')) {
        liveAttempts++
        if (liveAttempts < 3) return { ok: false, status: 504 } as Response
        return { ok: true, json: async () => visitDetailsResponse } as Response
      }
      return { ok: true, json: async () => bodyForUrl(url) } as Response
    })

    const pending = fetchMatomoSnapshot(eventConversation())
    await jest.runAllTimersAsync()
    const snapshot = await pending

    expect(liveAttempts).toBe(3)
    expect(snapshot).toEqual({
      attendeeCount: WINDOWED_ATTENDEES,
      totalVisits: WINDOWED_VISITS,
      totalActions: WINDOWED_ACTIONS,
      totalDwellSeconds: DWELL_WITHIN_EVENT,
      deviceBreakdown: WINDOWED_DEVICE_BREAKDOWN
    })
  })

  it('does not retry a valid empty live visit log (a genuinely empty event reports as empty)', async () => {
    // An empty array is a real answer (the event tracked no sessions), not a transient
    // failure, so the log call is made once and not retried.
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => ({ ok: true, json: async () => [] } as Response))

    const pending = fetchMatomoSnapshot(eventConversation())
    await jest.runAllTimersAsync()
    const snapshot = await pending

    expect(snapshot?.totalVisits).toBe(0)
    const liveCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('Live.getLastVisitsDetails'))
    expect(liveCalls).toHaveLength(1)
  })
})
