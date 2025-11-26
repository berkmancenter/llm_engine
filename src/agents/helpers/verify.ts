const PROPERTIES = [
  'name',
  'description',
  'maxTokens',
  'defaultTriggers',
  'initialize',
  'start',
  'stop',
  // 'isWithinTokenLimit',
  'priority',
  'llmTemplateVars',
  'defaultLLMTemplates',
  'defaultLLMPlatform',
  'defaultLLMModel',
  'ragCollectionName'
]

export default function (agentType) {
  for (const prop of PROPERTIES) {
    // properties should exist even if they are undefined, to show all properties have been considered for a new agentType
    if (!Object.hasOwn(agentType, prop)) throw new Error(`Agent type missing required property ${prop}`)
  }

  // check vars provided for each template
  for (const template in agentType.defaultLLMTemplates || {}) {
    if (!Array.isArray(agentType.llmTemplateVars?.[template]))
      throw new Error(`Template ${template} is missing vars specification`)
  }

  if (agentType.defaultTriggers?.periodic || agentType.defaultTriggers?.perMessage) {
    if (!agentType.evaluate) {
      throw new Error(`Evaluate method is required`)
    }
  }
  return agentType
}
