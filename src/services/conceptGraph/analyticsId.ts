import { createHmac } from 'crypto'
import config from '../../config/config.js'
import { CONCEPT_GRAPH_ARTIFACT } from '../../models/artifact.model/conceptGraphArtifact.js'

/*
 * An opaque id for a concept or prompt node that is safe to send to analytics.
 *
 * Node ids are slugs of what people said (see idFor in assemble.ts), and the events behind
 * them can run under the Chatham House Rule, so an id must never reach an analytics
 * service. This id is a keyed hash of the node id: without the secret it cannot be
 * recomputed from a guessed phrase, so it can't be reversed by a dictionary attack.
 *
 * Computed on every read and never stored, so rotating the secret needs no migration. It
 * is deliberately not given to contributions: a contribution id points at one person's
 * account. With no secret configured nothing is added, rather than falling back to an
 * unkeyed hash or a default key.
 */
const ANALYTICS_ID_LENGTH = 16

export const analyticsIdFor = (nodeId: string, secret: string | undefined = config.analytics?.idSecret) => {
  if (!secret) return undefined
  return createHmac('sha256', secret).update(nodeId).digest('hex').slice(0, ANALYTICS_ID_LENGTH)
}

/* Returns a copy of a concept graph payload with `analyticsId` on every concept and origin
   prompt that is an array. The input is not modified. Any other shape (a document payload)
   gains no keys. */
export const withAnalyticsIds = <T>(payload: T, secret: string | undefined = config.analytics?.idSecret): T => {
  if (!secret || !payload || typeof payload !== 'object') return payload
  const graph = payload as unknown as { concepts?: unknown; originPrompts?: unknown }
  const tag = (nodes: unknown) =>
    (nodes as { id: string }[]).map((node) => ({ ...node, analyticsId: analyticsIdFor(node.id, secret) }))
  return {
    ...payload,
    ...(Array.isArray(graph.concepts) && { concepts: tag(graph.concepts) }),
    ...(Array.isArray(graph.originPrompts) && { originPrompts: tag(graph.originPrompts) })
  } as T
}

/* The JSON form of an artifact or an artifact version, with analytics ids added wherever a
   concept graph payload sits: a version's own `payload`, or the `currentVersion` an artifact
   has inlined. Anything that is not a concept graph passes through untouched. */
export const serializeWithAnalyticsIds = (doc, secret: string | undefined = config.analytics?.idSecret) => {
  const json = doc && typeof doc.toJSON === 'function' ? doc.toJSON() : doc
  if (!secret || !json || typeof json !== 'object') return json
  if (json.payload && (json.type === undefined || json.type === CONCEPT_GRAPH_ARTIFACT)) {
    return { ...json, payload: withAnalyticsIds(json.payload, secret) }
  }
  const current = json.currentVersion
  if (json.type === CONCEPT_GRAPH_ARTIFACT && current && typeof current === 'object' && current.payload) {
    return { ...json, currentVersion: { ...current, payload: withAnalyticsIds(current.payload, secret) } }
  }
  return json
}

/* The response body for any artifact read: one artifact or version, a plain list of them, or
   a paginated page whose `results` are. */
export const serializeArtifactResponse = (body, secret: string | undefined = config.analytics?.idSecret) => {
  if (Array.isArray(body)) return body.map((item) => serializeWithAnalyticsIds(item, secret))
  if (body && Array.isArray(body.results)) {
    return { ...body, results: body.results.map((item) => serializeWithAnalyticsIds(item, secret)) }
  }
  return serializeWithAnalyticsIds(body, secret)
}
