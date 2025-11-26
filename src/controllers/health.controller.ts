import catchAsync from '../utils/catchAsync.js'

const checkHealth = catchAsync(async (req, res) => {
  res.send({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  })
})

export default { checkHealth }
