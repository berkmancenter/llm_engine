import { MetricServiceClient } from '@google-cloud/monitoring'
import * as gcpMetadata from 'gcp-metadata'
import config from '../config/config.js'
import logger from '../config/logger.js'

// Reports this instance's current concurrent connection count as a custom
// Cloud Monitoring metric — the primary autoscaling signal
// infra/modules/webserver-mig/autoscaler.tf's autoscaler is built around
// (CPU utilization is only its fallback). Without this, the autoscaler
// silently scales on CPU alone.
//
// Opt-in via ENABLE_GCP_CONNECTION_METRICS (default false) — see
// config.ts's description for why this isn't auto-detected/on by default.
// Once enabled, this also no-ops outside GCE (local dev, tests, CI): the
// GCE metadata server isn't reachable there, so the first call fails fast
// and every call after that short-circuits without retrying — that
// verdict can't change for the life of the process. A transient failure
// once we're past that check (a Monitoring API 429, a metadata-server
// timeout) is not the same thing and does not latch; it's logged and
// retried on the next scheduled call.

const METRIC_TYPE = 'custom.googleapis.com/app/concurrent_connections'

type GcpMetadataDeps = Pick<typeof gcpMetadata, 'isAvailable' | 'project' | 'instance'>

export interface ConnectionReporterDeps {
  enabled: boolean
  gcpMetadata: GcpMetadataDeps
  MetricServiceClient: typeof MetricServiceClient
  // Narrower than winston's actual Logger type (which only a real logger
  // needs to satisfy) — this is all reportConcurrentConnections calls.
  logger: { warn: (message: string) => void }
}

// A factory, not a bare function, specifically so this is testable via
// dependency injection (tests/CLAUDE.md's preferred approach — "sidesteps
// ESM mocking entirely") rather than jest.unstable_mockModule: each call
// gets its own closed-over state (the "give up after one failure" latch,
// cached resource labels, the lazily-created client), so tests don't need
// to fight shared module-level state or Jest's ESM module mocking at all.
// See tests/unit/utils/gcpConnectionMetrics.test.ts.
export function createConnectionReporter(deps: ConnectionReporterDeps) {
  let client: MetricServiceClient | undefined
  let resourceLabels: { project_id: string; instance_id: string; zone: string } | undefined
  let disabled = false

  async function getResourceLabels() {
    if (resourceLabels) return resourceLabels
    const [projectId, instanceId, zonePath] = await Promise.all([
      deps.gcpMetadata.project('project-id'),
      deps.gcpMetadata.instance('id'),
      deps.gcpMetadata.instance('zone')
    ])
    resourceLabels = {
      project_id: projectId,
      instance_id: String(instanceId),
      // zonePath looks like "projects/123456/zones/us-central1-a" — the
      // gce_instance monitored resource wants just the zone name.
      zone: zonePath.split('/').pop()
    }
    return resourceLabels
  }

  return async function reportConcurrentConnections(count: number): Promise<void> {
    if (!deps.enabled || disabled) return
    try {
      if (!(await deps.gcpMetadata.isAvailable())) {
        // Genuinely not running on GCE (local dev, tests, CI) — this
        // can't change for the life of the process, so stop asking.
        disabled = true
        return
      }
      const labels = await getResourceLabels()
      client ??= new deps.MetricServiceClient()
      await client.createTimeSeries({
        name: client.projectPath(labels.project_id),
        timeSeries: [
          {
            metric: { type: METRIC_TYPE },
            resource: { type: 'gce_instance', labels },
            points: [
              {
                interval: { endTime: { seconds: Math.floor(Date.now() / 1000) } },
                value: { int64Value: count }
              }
            ]
          }
        ]
      })
    } catch (error) {
      // Not the "we're not on GCE" case above — a real API/network error.
      // Don't latch `disabled` here: this runs on a fixed interval (see
      // websockets/index.ts), so the next call is the retry, and one bad
      // request shouldn't silently blind the autoscaler for the rest of
      // the process's life.
      deps.logger.warn(`Failed to publish concurrent_connections metric, will retry: ${error.message}`)
    }
  }
}

export default createConnectionReporter({
  enabled: config.enableGcpConnectionMetrics,
  gcpMetadata,
  MetricServiceClient,
  logger
})
