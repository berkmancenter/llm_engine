import adapterTypes, { internalAdapterTypes } from './index.js'

export default [
  { name: 'nextspace', label: 'Nextspace' },
  ...Object.keys(adapterTypes)
    .filter((adapterType) => !internalAdapterTypes.includes(adapterType))
    .map((adapterType) => ({
      name: adapterTypes[adapterType].name,
      label: adapterTypes[adapterType].label
    }))
]
