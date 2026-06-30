import config from '../../config/config.js'
import logger from '../../config/logger.js'
import { AnalyticsSnapshot } from '../../types/index.types.js'

const MATOMO_SOURCE = 'matomo'
const REQUEST_TIMEOUT_MS = 15000

/* Backoff before each retry of the visits call, in milliseconds. Matomo builds a
   range archive on demand the first time it is queried, so a call made moments after
   an event ends can time out or error while that archive is still being computed.
   This fetch runs in a background job (the Vibes Analyst handler), not on the event
   stop request, so it can afford to wait these out: one initial attempt plus three
   retries spanning ~17s total. */
const VISITS_RETRY_DELAYS_MS = [2000, 5000, 10000]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* Mongoose returns analyticsRefs as a Map normally, but as a plain object when the record
   was queried as raw data. This function doesn't control how its callers loaded the
   conversation, so it reads whichever of the two shapes it gets. */
function matomoRef(conversation): string | undefined {
  const refs = conversation.analyticsRefs
  if (!refs) return undefined
  if (typeof refs.get === 'function') return refs.get(MATOMO_SOURCE)
  return refs[MATOMO_SOURCE]
}

/* The ref is the Matomo custom dimension holding the conversation id (e.g. "dimension7").
   Built here at fetch because the id lives only on the document. */
function matomoSegment(conversation): string | undefined {
  const ref = matomoRef(conversation)
  if (!ref) return undefined
  return `${ref}==${conversation._id}`
}

/* Matomo's range period takes calendar dates (YYYY-MM-DD), not timestamps. */
function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/* Shifts a Date by a whole number of days, used to pad the queried range. */
function shiftDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

/* One Matomo Reporting API call. The auth token goes in the POST body, never the
   URL, so it stays out of request logs. Returns parsed JSON, or null on any
   network, HTTP, or Matomo-level error so a failed fetch never throws upstream. */
async function callMatomo(method: string, params: Record<string, string>, token: string): Promise<unknown | null> {
  const query = new URLSearchParams({ module: 'API', format: 'json', method, ...params })
  const url = `${config.matomo.baseUrl}/index.php?${query.toString()}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token_auth: token }),
      signal: controller.signal
    })

    if (!response.ok) {
      logger.error(`Matomo ${method} returned HTTP ${response.status}`)
      return null
    }

    const json = await response.json()
    // Matomo reports its own errors with HTTP 200 and a { result: 'error' } body.
    if (json && typeof json === 'object' && (json as { result?: string }).result === 'error') {
      logger.error(`Matomo ${method} error: ${(json as { message?: string }).message}`)
      return null
    }
    return json
  } catch (error: unknown) {
    logger.error(`Matomo ${method} request failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/* Calls Matomo, retrying only when the call comes back null (a transient failure:
   timeout, HTTP error, or Matomo error such as an archive still building). A valid
   response is returned immediately and never retried, so a genuine zero-visit answer
   is reported as-is rather than mistaken for "not ready yet". Gives up and returns
   null once the retry budget is spent. */
async function callMatomoWithRetry(method: string, params: Record<string, string>, token: string): Promise<unknown | null> {
  let result = await callMatomo(method, params, token)
  for (const delayMs of VISITS_RETRY_DELAYS_MS) {
    if (result !== null) break
    logger.info(`Matomo ${method} returned no data; retrying in ${delayMs}ms (archive may still be building)`)
    await sleep(delayMs)
    result = await callMatomo(method, params, token)
  }
  return result
}

/* One entry from a Matomo visit's actionDetails. Matomo's event-type actions carry a
   type of 'event' plus an eventCategory/eventAction/eventName triple; other action kinds
   (page views, downloads) leave those undefined. Read defensively, since a real response
   can omit any of them. */
interface MatomoActionDetail {
  type?: string
  eventCategory?: string
  eventAction?: string
  eventName?: string
}

/* Translates one Matomo action into a source-neutral breakdown key, or null when the
   action is not one we count. Only event-type actions on an allowlisted category map; every
   other action (page views, unknown categories, missing fields) returns null and is dropped.
   The backchannel key deliberately omits eventName, which can carry the message text. Pure,
   so the mapping is unit-testable on its own. */
export function mapMatomoActionKey(action: MatomoActionDetail | null | undefined): string | null {
  if (!action || action.type !== 'event') return null
  const { eventCategory: category, eventAction, eventName: name } = action

  if (category === 'assistant' && eventAction === 'command_sent') {
    return name ? `command:${name}` : null
  }
  if (category === 'assistant' && eventAction === 'tab_switched') {
    return name ? `tab:${name}` : null
  }
  if (category === 'feature' && (eventAction === 'open' || eventAction === 'close') && name === 'transcript') {
    return `transcript:${eventAction}`
  }
  if (category === 'transcript' && typeof eventAction === 'string' && eventAction.startsWith('scroll')) {
    return 'transcript:scroll'
  }
  if (category === 'backchannel' && (eventAction === 'quick_response_sent' || eventAction === 'custom_message_sent')) {
    return 'backchannel:message'
  }
  return null
}

/* The windowed counts derived from one pass over Matomo's per-visit live log. */
interface WindowedCounts {
  dwellSeconds: number
  visitCount: number
  visitorCount: number
  actionCount: number
  activeVisitorCount: number
  deviceBreakdown: Record<string, number>
  actionBreakdown: Record<string, number>
  actionUserBreakdown: Record<string, number>
}

/* Derives every event-windowed count from the per-visit live log in a single pass, so
   the log is walked once rather than once per metric. A daily summary report is scoped to a
   whole calendar day and cannot be narrowed to the event, so these counts come from the log
   instead, which carries each visit's action timestamps.

   For each visit whose session span [firstAction, lastAction] overlaps the event window
   [eventStart, eventEnd]:
   - dwellSeconds adds the visit's time inside the window. sum_visit_length is the whole
     session, which overshoots when a visitor arrived early or lingered after the end, so
     the span is clipped to the window before it is summed.
   - visitCount counts the visit.
   - visitorCount counts the visit's distinct visitorId, so one attendee with two visits
     is a single attendee. A visit with no visitorId is not counted as an attendee at all,
     so if the Matomo site is configured to anonymize or omit visitorId, attendeeCount
     undercounts the real audience and the posters-exceed-tracked-sessions check trips more
     readily.
   - actionCount adds only the visit's actionDetails entries whose own timestamp falls
     inside the window, dropping actions that happened before the event opened or after it
     closed even when the surrounding session overlaps.
   - actionBreakdown runs each in-window action through mapMatomoActionKey and tallies the
     allowlisted ones by occurrence (e.g. command:visual, tab:chat). Unmapped actions still
     count toward actionCount but not the breakdown, so the breakdown sums to at most
     actionCount.
   - actionUserBreakdown tallies the same keys by distinct visitor: one visitor firing a key
     ten times adds one, so the read layer can report what share of visitors did it, which
     the occurrence total alone cannot show.
   - activeVisitorCount is the distinct visitorId set among visits that took at least one
     in-window action, so it is the denominator for per-active-visitor action averages. It is
     at most visitorCount, since a visit can overlap the window without acting inside it.
   - deviceBreakdown tallies the visit's deviceType (e.g. "Desktop", "Smartphone") by visit,
     so the device counts sum to visitCount and reconcile with the other windowed totals. A
     visit with a missing or empty deviceType is bucketed under "Unknown" rather than dropped,
     so no in-window visit goes uncounted in the breakdown.

   Matomo timestamps are Unix seconds and sometimes arrive as strings, so each is coerced
   with Number and any entry with a missing or zero timestamp is skipped. A non-array
   response is treated as no visits and yields all-zero counts and an empty breakdown. */
function windowedCountsFrom(visits: unknown, startTime: Date, endTime: Date): WindowedCounts {
  const windowStartSeconds = Math.floor(startTime.getTime() / 1000)
  const windowEndSeconds = Math.floor(endTime.getTime() / 1000)

  let dwellSeconds = 0
  let visitCount = 0
  let actionCount = 0
  const visitorIds = new Set<string>()
  const activeVisitorIds = new Set<string>()
  const deviceBreakdown: Record<string, number> = {}
  const actionBreakdown: Record<string, number> = {}
  // One visitor set per action key, collapsed to sizes (the distinct-visitor breakdown) below.
  const visitorsByActionKey = new Map<string, Set<string>>()

  if (!Array.isArray(visits)) {
    return {
      dwellSeconds,
      visitCount,
      visitorCount: 0,
      actionCount,
      activeVisitorCount: 0,
      deviceBreakdown,
      actionBreakdown,
      actionUserBreakdown: {}
    }
  }

  for (const visit of visits) {
    const firstActionSeconds = Number(visit?.firstActionTimestamp ?? 0)
    const lastActionSeconds = Number(visit?.lastActionTimestamp ?? 0)
    if (!firstActionSeconds || !lastActionSeconds) continue

    const sessionStartsInWindow = firstActionSeconds <= windowEndSeconds
    const sessionEndsInWindow = lastActionSeconds >= windowStartSeconds
    if (!sessionStartsInWindow || !sessionEndsInWindow) continue

    visitCount += 1
    const visitorId = visit?.visitorId ? String(visit.visitorId) : undefined
    if (visitorId) visitorIds.add(visitorId)

    const deviceType = visit?.deviceType ? String(visit.deviceType) : 'Unknown'
    deviceBreakdown[deviceType] = (deviceBreakdown[deviceType] ?? 0) + 1

    const overlapSeconds = Math.min(lastActionSeconds, windowEndSeconds) - Math.max(firstActionSeconds, windowStartSeconds)
    if (overlapSeconds > 0) dwellSeconds += overlapSeconds

    if (Array.isArray(visit?.actionDetails)) {
      for (const action of visit.actionDetails) {
        const actionSeconds = Number(action?.timestamp ?? 0)
        if (!actionSeconds) continue
        if (actionSeconds < windowStartSeconds || actionSeconds > windowEndSeconds) continue
        actionCount += 1
        if (visitorId) activeVisitorIds.add(visitorId)
        const key = mapMatomoActionKey(action)
        if (!key) continue
        actionBreakdown[key] = (actionBreakdown[key] ?? 0) + 1
        if (visitorId) {
          const visitors = visitorsByActionKey.get(key) ?? new Set<string>()
          visitors.add(visitorId)
          visitorsByActionKey.set(key, visitors)
        }
      }
    }
  }

  const actionUserBreakdown: Record<string, number> = {}
  for (const [key, visitors] of visitorsByActionKey) actionUserBreakdown[key] = visitors.size

  return {
    dwellSeconds,
    visitCount,
    visitorCount: visitorIds.size,
    actionCount,
    activeVisitorCount: activeVisitorIds.size,
    deviceBreakdown,
    actionBreakdown,
    actionUserBreakdown
  }
}

/**
 * Fetches one event's tracked-session counts from Matomo's Reporting API and maps
 * them to an additive snapshot. Returns null (a graceful no-op) when Matomo is not
 * configured, the event carries no Matomo segment, the event has no time window,
 * or the API call fails. The caller stores a non-null result as the event's
 * Matomo snapshot.
 */
export async function fetchMatomoSnapshot(conversation): Promise<AnalyticsSnapshot | null> {
  const { baseUrl, token, siteId } = config.matomo
  if (!baseUrl || !token || !siteId) return null

  const segment = matomoSegment(conversation)
  if (!segment) return null

  const { startTime, endTime } = conversation
  if (!startTime || !endTime) return null

  /* The queried range is padded one day before eventStart and one day after eventEnd.
     dateOnly formats in UTC, but Matomo resolves a range in the site's own timezone, so
     an evening event at a site west of UTC can land on a different calendar day than its
     UTC date and a same-day range would return nothing for it. Over-fetching a day on each
     side covers that drift in either direction; the exact-timestamp clipping below then
     keeps only the in-window data, so the extra days cost nothing in the final counts. */
  const sharedParams = {
    idSite: String(siteId),
    period: 'range',
    date: `${dateOnly(shiftDays(startTime, -1))},${dateOnly(shiftDays(endTime, 1))}`,
    segment
  }

  /* The per-visit log is the source of truth for the windowed attendee, visit, action, dwell,
     and device counts, since a daily summary report cannot be narrowed below a calendar day. It is
     fetched with the retry helper so a not-yet-ready archive gets several chances.
     filter_limit -1 lifts Matomo's default page size so no visit is dropped.
     If the log ultimately comes back null (the fetch failed or the archive never built), the
     counts have no real source, so the whole snapshot is suppressed rather than stored as
     fabricated zeros that would read as "nobody showed up". An empty array is a real
     zero-session answer and still produces a zero-count snapshot. */
  const visitLog = await callMatomoWithRetry('Live.getLastVisitsDetails', { ...sharedParams, filter_limit: '-1' }, token)
  if (visitLog === null) return null

  const counts = windowedCountsFrom(visitLog, startTime, endTime)

  return {
    attendeeCount: counts.visitorCount,
    totalVisits: counts.visitCount,
    totalActions: counts.actionCount,
    totalDwellSeconds: counts.dwellSeconds,
    deviceBreakdown: counts.deviceBreakdown,
    actionBreakdown: counts.actionBreakdown,
    actionUserBreakdown: counts.actionUserBreakdown,
    activeVisitorCount: counts.activeVisitorCount
  }
}

export default fetchMatomoSnapshot
