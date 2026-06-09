// Production agents
import backChannelMetrics from './backChannel/backChannelMetrics.js'
import backChannelInsights from './backChannel/backChannelInsights.js'
import eventAssistant from './eventAssistant/eventAssistant.js'
import eventMediator from './eventMediator/eventMediator.js'
import moderatorNotifier from './moderatorNotifier/moderatorNotifier.js'
import engagementAgent from './engagement/engagementAgent.js'
import jargonFilterAgent from './jargonFilter/jargonFilter.js'
import librarian from './librarian/librarianAgent.js'
import chatbot from './chatbot/chatbot.js'
import eventHistorian from './eventHistorian/eventHistorian.js'
import eventSetup from './eventSetup/eventSetup.js'

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
import voiceAssistant from './eventAssistant/voiceAssistant.js'
import logger from '../config/logger.js'

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

const agentTypes = {
  ...(config.enableDevelopmentAgents ? development : {}),
  backChannelMetrics,
  backChannelInsights,
  eventAssistant,
  chatbot,
  eventMediator,
  moderatorNotifier,
  engagementAgent,
  jargonFilterAgent,
  voiceAssistant,
  librarian,
  eventHistorian,
  eventSetup
}

for (const [key, agentType] of Object.entries(agentTypes)) {
  try {
    const { default: caps } = await import(`./${key}/capabilities.js`)
    agentType.capabilities = caps
    logger.info(`Loaded capabilities for agent type: ${key}`)
  } catch {
    logger.debug(`No capabilities for agent type: ${key}`)
  }
}

export default agentTypes
