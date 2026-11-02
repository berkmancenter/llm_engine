/** Event export policy and HTTP contract, independent of chat agents and client apps. */
export interface ArchiveEvent {
  _id: { toString(): string }
  name?: string
  conversationType?: string
  active?: boolean
  draft?: boolean
  locked?: boolean
  enforceMembership?: boolean
  startTime?: Date | string
  endTime?: Date | string
  summary?: string
  presenters?: Array<{ name?: string }>
  topic?: { private?: boolean; isDeleted?: boolean } | null
}

export function archiveEventEligibility(event: ArchiveEvent | null): string | null {
  if (!event) return 'missing_event'
  if (!['eventAssistant', 'backChannel'].includes(event.conversationType || '')) return 'not_event'
  if (event.active !== false || !event.endTime || event.draft !== false) return 'not_completed'
  if (event.locked || event.enforceMembership) return 'restricted_event'
  if (event.topic?.private !== false || event.topic?.isDeleted !== false) return 'nonpublic_topic'
  if (!event.summary?.trim()) return 'no_summary'
  return null
}

export function archiveEventPayload(event: ArchiveEvent) {
  const reason = archiveEventEligibility(event)
  if (reason) throw new Error(`Ineligible archive event: ${reason}`)
  return {
    source: 'llm-engine',
    source_id: event._id.toString(),
    title: event.name?.trim() || 'Untitled event',
    date: new Date(event.startTime || event.endTime!).toISOString().slice(0, 10),
    markdown: event.summary!.trim(),
    participants: (event.presenters || []).map((p) => p.name?.trim()).filter((name): name is string => !!name)
  }
}

export class ArchiveDeliveryError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message)
  }
}

export async function deliverArchiveEvent(apiUrl: string, token: string, event: ArchiveEvent): Promise<string> {
  if (!apiUrl || !token) throw new ArchiveDeliveryError('missing_configuration', false)
  const endpoint = `${apiUrl.replace(/\/+$/, '')}/v1/conversations`
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(archiveEventPayload(event)),
      signal: AbortSignal.timeout(15000),
      redirect: 'error'
    })
  } catch {
    // Never include a token, summary or arbitrary downstream response in job logs.
    throw new ArchiveDeliveryError('network_or_timeout', true)
  }
  if (!response.ok) {
    throw new ArchiveDeliveryError(`http_${response.status}`, response.status === 429 || response.status >= 500)
  }
  const result = (await response.json().catch(() => null)) as { path?: unknown } | null
  if (typeof result?.path !== 'string' || !/^inbox\/conversations\/event-[a-f0-9]{64}\.md$/.test(result.path)) {
    throw new ArchiveDeliveryError('invalid_acknowledgment', true)
  }
  return result.path
}
