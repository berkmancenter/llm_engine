import catchAsync from '../utils/catchAsync.js'
import { planEventSetup } from '../services/eventSetup/planner.service.js'
import logger from '../config/logger.js'

const plan = catchAsync(async (req, res) => {
  /* If something goes wrong with a specific request, we want to be able
     to trace it back to the originating Slack user and to the specific
     handoff token. Logging jti and slackUserId gives us both without
     ever putting the raw signed token into the logs. */
  const ctx = req.handoff?.context as { slackUserId?: string } | undefined
  logger.info(
    `event-setup plan jti=${req.handoff?.jti} slackUserId=${ctx?.slackUserId} descriptionLength=${req.body.description?.length}`
  )

  const result = await planEventSetup({ description: req.body.description })
  res.send(result)
})

export default { plan }
