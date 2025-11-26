import { NextFunction, Request, Response } from 'express'
import recall from './recall.js'
import slack from './development/slack.js'
import zoom from './zoom.js'
import config from '../config/config.js'

export interface Handler {
  handleEvent(request: Request, response: Response)
  middleware(request: Request, response: Response, next: NextFunction)
}

const development = {
  slack
}
export default {
  ...(config.enableDevelopmentAdapters ? development : {}),
  recall,
  zoom
}
