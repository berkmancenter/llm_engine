// Production agents
import backChannelMetrics from './backChannel/backChannelMetrics.js'
import backChannelInsights from './backChannel/backChannelInsights.js'
import eventAssistant from './eventAssistant/eventAssistant.js'

// Development agents
import civilityPerMessage from './development/civilityPerMessage.js'
import civilityPerMessagePerspectiveAPI from './development/civilityPerMessagePerspectiveAPI.js'
import radicalEmpathyPerMessage from './development/radicalEmpathyPerMessage.js'
import playfulPerMessage from './development/playfulPerMessage.js'
import playfulPeriodic from './development/playfulPeriodic.js'
import reflection from './development/reflection.js'
import delegates from './development/delegates/index.js'
import experts from './development/experts/index.js'

import generic from './development/generic/index.js'
import config from '../config/config.js'
import eventAssistantPlus from './eventAssistant/eventAssistantPlus.js'

const development = {
  civilityPerMessage,
  civilityPerMessagePerspectiveAPI,
  radicalEmpathyPerMessage,
  playfulPerMessage,
  playfulPeriodic,
  reflection,
  delegates,
  experts,
  generic
}

export default {
  ...(config.enableDevelopmentAgents ? development : {}),
  backChannelMetrics,
  backChannelInsights,
  eventAssistant,
  eventAssistantPlus
}
