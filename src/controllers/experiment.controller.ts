import httpStatus from 'http-status'
import experimentService from '../services/experiment.service.js'
import catchAsync from '../utils/catchAsync.js'

const createExperiment = catchAsync(async (req, res) => {
  const experiment = await experimentService.createExperiment(req.body, req.user)
  res.status(httpStatus.CREATED).send(experiment)
})

const runExperiment = catchAsync(async (req, res) => {
  const experiment = await experimentService.runExperiment(req.params.experimentId)
  res.status(httpStatus.OK).send(experiment)
})

const getExperiment = catchAsync(async (req, res) => {
  const experiment = await experimentService.getExperiment(req.params.experimentId)
  res.status(httpStatus.OK).send(experiment)
})

const getExperimentResults = catchAsync(async (req, res) => {
  const { experimentId } = req.params
  const { reportName, format = 'text', additionalChannels, agent } = req.query
  const timezone = req.headers['x-timezone'] || 'UTC'

  // Parse additionalChannels - can be a comma-separated string or array
  let channelsArray: string[] = []
  if (additionalChannels) {
    if (Array.isArray(additionalChannels)) {
      channelsArray = additionalChannels as string[]
    } else if (typeof additionalChannels === 'string') {
      channelsArray = additionalChannels.split(',').map((ch) => ch.trim())
    }
  }

  const report = await experimentService.generateExperimentReport(
    experimentId,
    reportName,
    format,
    timezone,
    channelsArray,
    agent as string | undefined
  )
  const contentTypes = {
    text: 'text/plain',
    csv: 'text/csv'
  }
  res.setHeader('Content-Type', contentTypes[format] || 'text/plain')

  // Set Content-Disposition header for CSV downloads
  if (format === 'csv') {
    res.setHeader('Content-Disposition', `attachment; filename="${reportName}_${experimentId}.csv"`)
  }

  res.status(httpStatus.OK).send(report)
})

export default { createExperiment, runExperiment, getExperiment, getExperimentResults }
