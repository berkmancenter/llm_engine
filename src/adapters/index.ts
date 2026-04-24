import zoom from './zoom.js'
import slack from './slack/index.js'
import config from '../config/config.js'

const development = {}

export const internalAdapterTypes = ['slack']

export default {
  ...(config.enableDevelopmentAdapters ? development : {}),
  slack,
  zoom
}
