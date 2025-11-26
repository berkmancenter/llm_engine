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
  const { reportName, format = 'text' } = req.query
  const report = await experimentService.generateExperimentReport(experimentId, reportName, format)
  const contentTypes = {
    text: 'text/plain'
  }
  res.setHeader('Content-Type', contentTypes[format] || 'text/plain')
  res.status(httpStatus.OK).send(report)
})

export default { createExperiment, runExperiment, getExperiment, getExperimentResults }
