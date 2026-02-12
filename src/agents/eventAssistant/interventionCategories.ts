/**
 * Types of interventions the mediator can make
 */
export enum InterventionType {
  SIGNAL = 'SIGNAL',
  SYNTHESIS = 'SYNTHESIS',
  MINORITY_VOICE = 'MINORITY_VOICE',
  CONFUSION = 'CONFUSION',
  PROVOCATION = 'PROVOCATION',
  BRIDGE = 'BRIDGE',
  STRUCTURE = 'STRUCTURE',
  PLAY = 'PLAY',
  MODERATOR_ESCALATION = 'MODERATOR_ESCALATION',
  NONE = 'NONE'
}

/**
 * Configuration for a single intervention category
 */
export interface CategoryConfig {
  enabled: boolean
  weight: number // 0.0 - 2.0, relative priority
}

/**
 * Full configuration for all intervention categories
 */
export interface InterventionCategoriesConfig {
  collectiveConsciousness?: CategoryConfig
  engagement?: CategoryConfig
  facilitation?: CategoryConfig
}

/**
 * Details about an available intervention category for configuration
 */
export interface InterventionCategoryDetails {
  name: string // The key used in InterventionCategoriesConfig
  label: string // User-facing display name
  description: string // What this category does
  interventions: InterventionType[] // Which intervention types it includes
  requiresPrivateMessages: boolean
  defaultWeight: number
  defaultEnabled: boolean
}

export const interventionCategories: InterventionCategoryDetails[] = [
  {
    name: 'collectiveConsciousness',
    label: 'Collective Consciousness',
    description: 'Bridge individual experience → group awareness',
    interventions: [
      InterventionType.SIGNAL,
      InterventionType.SYNTHESIS,
      InterventionType.MINORITY_VOICE,
      InterventionType.CONFUSION,
      InterventionType.MODERATOR_ESCALATION
    ],
    requiresPrivateMessages: true,
    defaultWeight: 1.0,
    defaultEnabled: true
  },
  {
    name: 'engagement',
    label: 'Engagement',
    description: 'Generate energy & participation',
    interventions: [InterventionType.PROVOCATION, InterventionType.PLAY],
    requiresPrivateMessages: false,
    defaultWeight: 2.0,
    defaultEnabled: true
  },
  {
    name: 'facilitation',
    label: 'Facilitation',
    description: 'Help people follow along',
    interventions: [InterventionType.STRUCTURE, InterventionType.BRIDGE],
    requiresPrivateMessages: false,
    defaultWeight: 1.0,
    defaultEnabled: true
  }
]

/**
 * Default configuration with all categories enabled at their default weights
 * Built from interventionCategories
 */
export const defaultCategoriesConfig: InterventionCategoriesConfig = interventionCategories.reduce((acc, cat) => {
  acc[cat.name as keyof InterventionCategoriesConfig] = {
    enabled: cat.defaultEnabled,
    weight: cat.defaultWeight
  }
  return acc
}, {} as InterventionCategoriesConfig)

/**
 * Get list of enabled intervention types based on category configuration
 * Always includes NONE as an option
 */
export function getEnabledInterventions(
  categoryConfig: InterventionCategoriesConfig = defaultCategoriesConfig,
  supportsModerator: boolean = false
): InterventionType[] {
  const enabledTypes: Set<InterventionType> = new Set()

  for (const category of interventionCategories) {
    const config = categoryConfig[category.name as keyof InterventionCategoriesConfig]
    if (config?.enabled) {
      for (const intervention of category.interventions) {
        // Only include MODERATOR_ESCALATION if moderator is supported
        if (intervention === InterventionType.MODERATOR_ESCALATION && !supportsModerator) {
          continue
        }
        enabledTypes.add(intervention)
      }
    }
  }

  // Always include NONE as an option
  enabledTypes.add(InterventionType.NONE)

  return Array.from(enabledTypes)
}

/**
 * Check if private messages should be fetched based on enabled categories
 * Returns true if any enabled category requires private messages
 */
export function shouldFetchPrivateMessages(categoryConfig: InterventionCategoriesConfig = defaultCategoriesConfig): boolean {
  for (const category of interventionCategories) {
    const config = categoryConfig[category.name as keyof InterventionCategoriesConfig]
    if (config?.enabled && category.requiresPrivateMessages) {
      return true
    }
  }
  return false
}

/**
 * Generate prompt text explaining category priorities to the LLM
 * Returns guidance about which intervention types to prioritize based on weights
 */
export function getCategoryWeightGuidance(categoryConfig: InterventionCategoriesConfig = defaultCategoriesConfig): string {
  const enabledCategories: Array<{ name: string; description: string; weight: number; interventions: string[] }> = []

  for (const category of interventionCategories) {
    const config = categoryConfig[category.name as keyof InterventionCategoriesConfig]
    if (config?.enabled) {
      enabledCategories.push({
        name: category.name,
        description: category.description,
        weight: config.weight,
        interventions: category.interventions.filter((i) => i !== InterventionType.MODERATOR_ESCALATION)
      })
    }
  }

  if (enabledCategories.length === 0) {
    return 'No intervention categories are enabled. You should not intervene.'
  }

  // Sort by weight descending
  enabledCategories.sort((a, b) => b.weight - a.weight)

  const lines: string[] = ['## Intervention Priorities', '']

  // Check if all weights are equal
  const allEqual = enabledCategories.every((c) => c.weight === enabledCategories[0].weight)

  if (allEqual) {
    lines.push('All enabled categories have equal priority. Choose the most appropriate intervention type for the moment.')
    lines.push('')
    for (const cat of enabledCategories) {
      lines.push(`- **${cat.name}** (${cat.description}): ${cat.interventions.join(', ')}`)
    }
  } else {
    lines.push('Prioritize intervention types based on these weights (higher = more priority):')
    lines.push('')
    for (const cat of enabledCategories) {
      let priority

      if (cat.weight >= 1.5) {
        priority = 'HIGH'
      } else if (cat.weight >= 1.0) {
        priority = 'NORMAL'
      } else {
        priority = 'LOW'
      }
      lines.push(
        `- **${cat.name}** [${priority}, weight: ${cat.weight}] (${cat.description}): ${cat.interventions.join(', ')}`
      )
    }
    lines.push('')
    lines.push('When multiple intervention types could apply, prefer those from higher-weighted categories.')
  }

  // Add engagement-specific guidance when engagement is weighted high
  const engagementConfig = categoryConfig.engagement
  if (engagementConfig?.enabled && engagementConfig.weight >= 1.5) {
    lines.push('')
    lines.push('## Engagement Mode')
    lines.push('')
    lines.push(
      'With engagement highly weighted, you are an **active participant** in this discussion, not just an observer.'
    )
    lines.push('You are in the room. Break the fourth wall. Contribute to the energy.')
    lines.push('')
    lines.push('Be active when:')
    lines.push('- The speaker asks a question and nobody responds — jump in with a provocation or your own take')
    lines.push('- Something funny, ironic, or notable happens — add color commentary')
    lines.push('- The room is too quiet or passive — spark discussion')
    lines.push('- A bold claim goes unchallenged — ask the hard question')
    lines.push("- There's a natural pause or transition — add a witty observation")
    lines.push('')
    lines.push("Don't wait for problems. Participate. The higher the engagement weight, the more present you should be.")
  }

  return lines.join('\n')
}

/**
 * Get the category that an intervention type belongs to
 */
export function getCategoryForIntervention(interventionType: InterventionType): string | null {
  for (const category of interventionCategories) {
    if (category.interventions.includes(interventionType)) {
      return category.name
    }
  }
  return null
}
