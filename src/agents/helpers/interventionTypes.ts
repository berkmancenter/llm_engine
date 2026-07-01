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
  NONE = 'NONE',
  POLL_REVEAL = 'POLL_REVEAL'
}

/**
 * Analysis result from intervention detection
 */
export interface InterventionAnalysis {
  shouldIntervene: boolean
  interventionType: InterventionType
  reasoning: string
  sharedChatMessage?: string
  confidenceScore: number
  detectedPattern?: string
  affectedUsers?: number
  context?: string
}
