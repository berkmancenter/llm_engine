import { jest } from '@jest/globals'
import { createConnectionReporter } from '../../../src/utils/gcpConnectionMetrics.js'

function makeReporter(overrides: Record<string, unknown> = {}) {
  const mockCreateTimeSeries = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined) // eslint-disable-line @typescript-eslint/no-explicit-any
  const mockProjectPath = jest.fn((id: string) => `projects/${id}`)
  const mockIsAvailable = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(true) // eslint-disable-line @typescript-eslint/no-explicit-any
  const mockProject = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue('test-project') // eslint-disable-line @typescript-eslint/no-explicit-any
  const mockInstance = jest
    .fn<(...args: any[]) => Promise<any>>() // eslint-disable-line @typescript-eslint/no-explicit-any
    .mockImplementation(async (key: string) => (key === 'id' ? '123456' : 'projects/999/zones/us-central1-a'))
  const mockLoggerWarn = jest.fn()

  const MockMetricServiceClient = jest.fn().mockImplementation(() => ({
    createTimeSeries: mockCreateTimeSeries,
    projectPath: mockProjectPath
  }))

  const report = createConnectionReporter({
    enabled: true,
    gcpMetadata: { isAvailable: mockIsAvailable, project: mockProject, instance: mockInstance },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    MetricServiceClient: MockMetricServiceClient as any,
    logger: { warn: mockLoggerWarn },
    ...overrides
  })

  return { report, mockCreateTimeSeries, mockProjectPath, mockIsAvailable, mockLoggerWarn }
}

describe('gcpConnectionMetrics', () => {
  it('does nothing when disabled (ENABLE_GCP_CONNECTION_METRICS off, the default)', async () => {
    const { report, mockIsAvailable, mockCreateTimeSeries } = makeReporter({ enabled: false })
    await report(5)

    expect(mockIsAvailable).not.toHaveBeenCalled()
    expect(mockCreateTimeSeries).not.toHaveBeenCalled()
  })

  it('does nothing when enabled but the GCE metadata server is unreachable', async () => {
    const { report, mockIsAvailable, mockCreateTimeSeries } = makeReporter()
    mockIsAvailable.mockResolvedValue(false)
    await report(5)

    expect(mockCreateTimeSeries).not.toHaveBeenCalled()
  })

  it('publishes a gce_instance time series with the given count when enabled and on GCE', async () => {
    const { report, mockCreateTimeSeries } = makeReporter()
    await report(7)

    expect(mockCreateTimeSeries).toHaveBeenCalledTimes(1)
    const [[arg]] = mockCreateTimeSeries.mock.calls
    expect(arg.name).toBe('projects/test-project')
    expect(arg.timeSeries[0].metric).toEqual({ type: 'custom.googleapis.com/app/concurrent_connections' })
    expect(arg.timeSeries[0].resource).toEqual({
      type: 'gce_instance',
      labels: { project_id: 'test-project', instance_id: '123456', zone: 'us-central1-a' }
    })
    expect(arg.timeSeries[0].points[0].value).toEqual({ int64Value: 7 })
  })

  it('swallows a publish failure, logs once, and stops trying on later calls', async () => {
    const { report, mockCreateTimeSeries, mockIsAvailable, mockLoggerWarn } = makeReporter()
    mockCreateTimeSeries.mockRejectedValueOnce(new Error('boom'))

    await expect(report(1)).resolves.toBeUndefined()
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1)

    await report(2)
    // Neither call should re-run after the first failure trips this reporter's breaker.
    expect(mockIsAvailable).toHaveBeenCalledTimes(1)
    expect(mockCreateTimeSeries).toHaveBeenCalledTimes(1)
  })

  it('gives each reporter instance its own independent state', async () => {
    const a = makeReporter()
    const b = makeReporter()
    a.mockCreateTimeSeries.mockRejectedValueOnce(new Error('boom'))

    await a.report(1) // trips a's breaker
    await b.report(1) // b is unaffected

    expect(a.mockCreateTimeSeries).toHaveBeenCalledTimes(1)
    expect(b.mockCreateTimeSeries).toHaveBeenCalledTimes(1)
  })
})
