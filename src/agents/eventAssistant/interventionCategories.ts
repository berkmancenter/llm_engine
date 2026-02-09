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
 * Definition of an intervention category
 */
export interface InterventionCategory {
  name: string
  description: string
  interventions: InterventionType[]
  requiresPrivateMessages: boolean
  defaultWeight: number
}

/**
 * Registry of all intervention categories
 */
export const interventionCategories: Record<string, InterventionCategory> = {
  collectiveConsciousness: {
    name: 'collectiveConsciousness',
    description: 'Bridge individual experience → group awareness',
    interventions: [
      InterventionType.SIGNAL,
      InterventionType.SYNTHESIS,
      InterventionType.MINORITY_VOICE,
      InterventionType.CONFUSION,
      InterventionType.MODERATOR_ESCALATION
    ],
    requiresPrivateMessages: true,
    defaultWeight: 1.0
  },
  engagement: {
    name: 'engagement',
    description: 'Generate energy & participation',
    interventions: [InterventionType.PROVOCATION, InterventionType.PLAY],
    requiresPrivateMessages: false,
    defaultWeight: 1.0
  },
  facilitation: {
    name: 'facilitation',
    description: 'Help people follow along',
    interventions: [InterventionType.STRUCTURE, InterventionType.BRIDGE],
    requiresPrivateMessages: false,
    defaultWeight: 1.0
  }
}

/**
 * Default configuration with all categories enabled at weight 1.0
 */
export const defaultCategoriesConfig: InterventionCategoriesConfig = {
  collectiveConsciousness: { enabled: true, weight: 1.0 },
  engagement: { enabled: true, weight: 1.0 },
  facilitation: { enabled: true, weight: 1.0 }
}

/**
 * Get list of enabled intervention types based on category configuration
 * Always includes NONE as an option
 */
export function getEnabledInterventions(
  categoryConfig: InterventionCategoriesConfig = defaultCategoriesConfig,
  supportsModerator: boolean = false
): InterventionType[] {
  const enabledTypes: Set<InterventionType> = new Set()

  for (const [categoryName, category] of Object.entries(interventionCategories)) {
    const config = categoryConfig[categoryName as keyof InterventionCategoriesConfig]
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
  for (const [categoryName, category] of Object.entries(interventionCategories)) {
    const config = categoryConfig[categoryName as keyof InterventionCategoriesConfig]
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

  for (const [categoryName, category] of Object.entries(interventionCategories)) {
    const config = categoryConfig[categoryName as keyof InterventionCategoriesConfig]
    if (config?.enabled) {
      enabledCategories.push({
        name: categoryName,
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

  return lines.join('\n')
}

/**
 * Get the category that an intervention type belongs to
 */
export function getCategoryForIntervention(interventionType: InterventionType): string | null {
  for (const [categoryName, category] of Object.entries(interventionCategories)) {
    if (category.interventions.includes(interventionType)) {
      return categoryName
    }
  }
  return null
}
