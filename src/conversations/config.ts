import conversationTypes from './index.js'

export default Object.keys(conversationTypes).map((conversationType) => {
  const ct = conversationTypes[conversationType]
  return {
    name: ct.name,
    description: ct.description,
    label: ct.label,
    platforms: ct.platforms,
    properties: ct.properties,
    features: ct.features?.map(
      ({
        name,
        label,
        description,
        participantDescription,
        default: defaultVal,
        properties,
        tab,
        audience,
        slashCommand
      }) => ({
        name,
        label,
        description,
        participantDescription,
        default: defaultVal,
        properties,
        tab,
        audience,
        slashCommand
      })
    )
  }
})
