import handlebars from 'handlebars'
import httpStatus from 'http-status'
import ApiError from '../utils/ApiError.js'
import { AgentProperty, BehaviorPolicy, ConversationType, Feature, FeatureConfig } from '../types/index.types.js'
import { isValidPropertyFormat } from './propertyFormats.js'

const FACILITATIVE_GOALS = [
  'synthesize_discussion',
  'bridge_topics',
  'invite_quieter_voices',
  'clarify_confusion',
  'surface_signal',
  'structure_conversation'
]

const CHALLENGE_GOALS = ['provoke_participation', 'play_commentary', 'poll_reveal']

const DM_GOALS = ['private_reassure', 'private_not_alone', 'private_transcript_hook', 'private_interest_bridge']

export const NEUTRAL_BEHAVIORAL_POLICY: BehaviorPolicy = {
  globalPolicy: {
    tone: 'warmSupportive',
    verbosity: 'brief',
    formality: 'semiFormal',
    safetyPosture: 'strict'
  },
  channels: {
    dm: {
      proactivePolicy: {
        initiativeLevel: 'lightlyProactive',
        minContributionMinutes: 10
      }
    },
    groupChat: {
      proactivePolicy: {
        initiativeLevel: 'moderatelyProactive',
        minContributionMinutes: 2
      }
    }
  }
}

function deriveDefaultsFromFeatures(enabledFeatures: string[]) {
  const goals: string[] = [...DM_GOALS]
  const hasCollectiveVoice = enabledFeatures.includes('collectiveVoice')
  const hasCatalyst = enabledFeatures.includes('catalyst')

  if (hasCollectiveVoice) goals.push(...FACILITATIVE_GOALS)
  if (hasCatalyst) goals.push(...CHALLENGE_GOALS)

  return { goals, behaviorPolicy: NEUTRAL_BEHAVIORAL_POLICY }
}

interface ResolvedConversationConfig {
  agentTypes: Array<{ name: string; properties?: Record<string, unknown> }>
  adapters: unknown[]
  channels: ConversationType['channels']
  enableDMs: ConversationType['enableDMs']
  properties: Record<string, unknown>
  features: Feature[]
  goals: string[]
  behaviorPolicy: BehaviorPolicy
}

const removeEmptyValues = (obj) => {
  if (Array.isArray(obj)) {
    const arr = obj.map(removeEmptyValues).filter((item) => item !== null && item !== undefined && item !== '')
    return arr.length ? arr : undefined
  }

  if (obj && typeof obj === 'object') {
    const result = {}
    for (const [key, value] of Object.entries(obj)) {
      const cleanedValue = removeEmptyValues(value)
      if (cleanedValue !== undefined && cleanedValue !== null && cleanedValue !== '') {
        result[key] = cleanedValue
      }
    }
    return Object.keys(result).length ? result : undefined
  }

  if (obj === null || obj === undefined || obj === '') return undefined

  return obj
}

const getNestedValue = (obj: Record<string, unknown>, path: string): unknown =>
  path
    .split('.')
    .reduce((acc: unknown, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj)

const setNestedValue = (obj: Record<string, unknown>, path: string, value: unknown): void => {
  const keys = path.split('.')
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') current[keys[i]] = {}
    current = current[keys[i]] as Record<string, unknown>
  }
  current[keys[keys.length - 1]] = value
}

const resolveAgentProperties = (agentProperties: AgentProperty[], resolvedProperties: Record<string, unknown>) => {
  const result: Record<string, unknown> = {}
  for (const prop of agentProperties) {
    if ('$ref' in prop) {
      const value = getNestedValue(resolvedProperties, prop.$ref)
      const key = prop.as ?? prop.$ref.split('.').at(-1)!
      if (value !== undefined) setNestedValue(result, key, value)
    } else {
      const value = resolvedProperties[prop.name] ?? prop.default
      const key = prop.as ?? prop.name
      if (value !== undefined) setNestedValue(result, key, value)
    }
  }
  return result
}

const resolvePropertyReferences = (obj, properties: Record<string, unknown>) => {
  const template = handlebars.compile(JSON.stringify(obj))
  const parsed = JSON.parse(template({ properties }))

  const coerceValues = (node) => {
    if (typeof node === 'string') {
      const trimmed = node.trim()
      if (trimmed === 'true') return true
      if (trimmed === 'false') return false
      const num = Number(trimmed)
      if (!Number.isNaN(num) && trimmed !== '') return num
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          return coerceValues(JSON.parse(trimmed))
        } catch {
          return node
        }
      }
      return node
    }
    if (Array.isArray(node)) return node.map(coerceValues)
    if (node && typeof node === 'object') {
      const result = {}
      // eslint-disable-next-line guard-for-in
      for (const key in node) result[key] = coerceValues(node[key])
      return result
    }
    return node
  }

  return coerceValues(removeEmptyValues(parsed))
}

/* allowDraft relaxes the two checks that draft status also tracks: a missing required
   property and a malformed format value. The email webhook sets it so an incomplete
   invite becomes a draft for review instead of a 400. Enum and object-shape checks stay
   strict either way. The event form leaves it off, so form submissions stay strict. */
const validateProperties = (
  properties: Record<string, unknown>,
  propDefs: ConversationType['properties'],
  allowDraft = false
): void => {
  for (const prop of propDefs) {
    if (!allowDraft && prop.required && !(prop.name in properties)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Required property '${prop.name}' is missing`)
    }

    if (prop.type === 'enum' && prop.name in properties) {
      const value = properties[prop.name]
      const isAllowed = prop.options!.some((item) => {
        if (typeof item === 'object') {
          if (typeof value !== 'object' || value === null) return false
          const keysToValidate = prop.validationKeys || Object.keys(item)
          return keysToValidate.every((k) => value[k] === item[k])
        }
        return item === value
      })
      if (!isAllowed) {
        const allowedValues = prop
          .options!.map((item) => {
            if (typeof item === 'object') {
              const keysToShow = prop.validationKeys || Object.keys(item)
              return JSON.stringify(Object.fromEntries(keysToShow.map((k) => [k, item[k]])))
            }
            return item
          })
          .join(', ')
        throw new ApiError(httpStatus.BAD_REQUEST, `Invalid value for '${prop.name}'. Must be one of: ${allowedValues}`)
      }
    }

    if (prop.type === 'object' && prop.schema && prop.name in properties) {
      const value = properties[prop.name]
      if (typeof value !== 'object' || value === null) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Property '${prop.name}' must be an object`)
      }
      const itemKey = prop.itemKey || 'name'
      const allowedKeys = prop.schema.map((item) => item[itemKey])
      for (const key of Object.keys(value)) {
        if (!allowedKeys.includes(key)) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `Invalid key '${key}' in '${prop.name}'. Allowed keys: ${allowedKeys.join(', ')}`
          )
        }
      }
    }

    if (
      !allowDraft &&
      prop.format &&
      prop.name in properties &&
      !isValidPropertyFormat(prop.format, properties[prop.name])
    ) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Property '${prop.name}' is not a valid ${prop.format}`)
    }
  }
}

const resolvePropertyDefaults = (
  properties: Record<string, unknown>,
  propDefs: ConversationType['properties']
): Record<string, unknown> => {
  const resolved = { ...properties }
  for (const prop of propDefs) {
    if (prop.required || prop.name in resolved) continue

    if (prop.default !== undefined) {
      resolved[prop.name] = prop.default
    } else if (prop.type === 'object' && prop.schema) {
      const itemKey = prop.itemKey || 'name'
      const defaultObject = {}
      for (const schemaItem of prop.schema) {
        const key = schemaItem[itemKey]
        const itemDefaults = {}
        for (const [k, v] of Object.entries(schemaItem)) {
          if (k.startsWith('default')) {
            const fieldName = k.replace('default', '').charAt(0).toLowerCase() + k.replace('default', '').slice(1)
            itemDefaults[fieldName] = v
          }
        }
        defaultObject[key] = itemDefaults
      }
      resolved[prop.name] = defaultObject
    }
  }
  return resolved
}

const resolveFeatures = (
  requestedFeatures: Array<{ name: string; enabled?: boolean; config?: Record<string, unknown> }> | undefined,
  featureDefs: FeatureConfig[] | undefined
): Feature[] => {
  /* When no features array is provided, return empty. The guide falls back to
     feature.default, which covers pre-existing conversations without a DB migration. */
  if (requestedFeatures === undefined) return []

  return (featureDefs ?? []).map((feature) => {
    const requested = requestedFeatures.find((f) => f.name === feature.name)
    if (!requested) return { name: feature.name, enabled: false }
    const enabled = requested.enabled !== false
    const config: Record<string, unknown> = { ...requested.config }
    for (const prop of feature.properties ?? []) {
      if (!(prop.name in config) && prop.default !== undefined) config[prop.name] = prop.default
    }
    return { name: feature.name, enabled, ...(enabled && Object.keys(config).length && { config }) }
  })
}

const resolveAgents = (
  conversationType: ConversationType,
  resolvedProperties: Record<string, unknown>
): Array<{ name: string; properties?: Record<string, unknown> }> => {
  const mapAgent = (agent: { name: string; properties?: AgentProperty[] }) => ({
    name: agent.name,
    properties: agent.properties ? resolveAgentProperties(agent.properties, resolvedProperties) : undefined
  })

  return [
    ...(conversationType.agents ?? []).map(mapAgent),
    ...(conversationType.features ?? [])
      .filter((feature) => !!resolvedProperties[feature.name])
      .flatMap((feature) => feature.agents.map(mapAgent))
  ]
}

export default function resolveConversationType(
  params: {
    platforms?: string[]
    properties?: Record<string, unknown>
    features?: Array<{ name: string; enabled?: boolean; config?: Record<string, unknown> }>
  },
  conversationType: ConversationType,
  allowDraft = false
): ResolvedConversationConfig {
  const { platforms, properties = {}, features: requestedFeatures } = params

  validateProperties(properties, conversationType.properties, allowDraft)
  const resolvedProperties = resolvePropertyDefaults(properties, conversationType.properties)
  const features = resolveFeatures(requestedFeatures, conversationType.features)

  // Merge feature configs into a working object keyed by feature name for $ref resolution
  const workingProperties = { ...resolvedProperties }
  for (const { name, config, enabled } of features) workingProperties[name] = enabled ? config ?? true : false

  const adapterDefs = conversationType.adapters || {}
  const sortedKey = (platforms || []).slice().sort().join(',')
  const exactMatch = adapterDefs[sortedKey]
  const perPlatform = (platforms || []).map((p) => adapterDefs[p]).filter(Boolean)
  let adapters: unknown[] = []
  if (exactMatch) {
    adapters = [resolvePropertyReferences(exactMatch, workingProperties)]
  } else if (perPlatform.length > 0) {
    adapters = perPlatform.map((a) => resolvePropertyReferences(a, workingProperties))
  } else if (adapterDefs.default) {
    adapters = [resolvePropertyReferences(adapterDefs.default, workingProperties)]
  }

  const enabledFeatureNames = features.filter((f) => f.enabled).map((f) => f.name)
  const { goals, behaviorPolicy } = deriveDefaultsFromFeatures(enabledFeatureNames)

  return {
    agentTypes: resolveAgents(conversationType, workingProperties),
    adapters,
    channels: conversationType.channels || [],
    enableDMs: conversationType.enableDMs,
    properties: resolvedProperties,
    features,
    goals,
    behaviorPolicy
  }
}
