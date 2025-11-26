import conversationTypes from './index.js'

export default Object.keys(conversationTypes).map((conversationType) => ({
  name: conversationTypes[conversationType].name,
  description: conversationTypes[conversationType].description,
  label: conversationTypes[conversationType].label,
  platforms: conversationTypes[conversationType].platforms,
  properties: conversationTypes[conversationType].properties
}))
