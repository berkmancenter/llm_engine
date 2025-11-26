import agentTypes from './index.js'

export default Object.keys(agentTypes).map((agentType) => ({
  agentType,
  name: agentTypes[agentType].name,
  description: agentTypes[agentType].description
}))
