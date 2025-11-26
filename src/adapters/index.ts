import zoom from './zoom.js'
import slack from './development/slack/index.js'
import config from '../config/config.js'

const development = {
  slack
}

export default {
  ...(config.enableDevelopmentAdapters ? development : {}),
  zoom
}
