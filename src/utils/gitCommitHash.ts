import { execSync } from 'child_process'
import logger from '../config/logger.js'

// cache it since it doesn't/shouldn't change while running
let hash

module.exports = function getGitCommitHash() {
  try {
    if (!hash) {
      hash = execSync('git rev-parse --short HEAD').toString().trim()
    }
    return hash
  } catch {
    logger.warn('Could not get git hash')
    return null
  }
}
