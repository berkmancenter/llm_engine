import adapterTypes from './index.js'

export default [
  { name: 'nextspace', label: 'Nextspace' },
  ...Object.keys(adapterTypes).map((adapterType) => ({
    name: adapterTypes[adapterType].name,
    label: adapterTypes[adapterType].label
  }))
]
