import adapterTypes, { internalAdapterTypes } from './index.js'

const nextspaceEntry = {
  name: 'nextspace',
  label: 'Nextspace',
  description:
    'This conversation is running on Nextspace, a web-based live event platform. Participants interact through a private chat tab with the assistant, a group channel visible to all attendees, a live transcript, and a resources tab with pre-loaded and possibly on-the-fly AI-generated materials.'
}

const adapterKeys = Object.keys(adapterTypes)

const toEntry = (adapterType) => ({
  name: adapterTypes[adapterType].name,
  label: adapterTypes[adapterType].label,
  description: adapterTypes[adapterType].description
})

// All platform entries including internal adapters — used for agent prompt descriptions.
export const allPlatformConfigs = [nextspaceEntry, ...adapterKeys.map(toEntry)]

// Public platform entries (internal adapters excluded) — exposed to the frontend.
export default [nextspaceEntry, ...adapterKeys.filter((k) => !internalAdapterTypes.includes(k)).map(toEntry)]
