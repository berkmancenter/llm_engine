import { BehaviorPolicy } from '../src/types/index.types.js'

export interface ConversationTemplate {
  goals: string[]
  behaviorPolicy: BehaviorPolicy
}

export const TEMPLATES: Record<string, ConversationTemplate> = {
  publicAcademicLecture: {
    goals: ['surface_signal', 'invite_quieter_voices', 'bridge_topics', 'provoke_participation', 'synthesize_discussion', 'private_reassure', 'private_not_alone', 'private_interest_bridge', 'private_transcript_hook'],
    behaviorPolicy: {
      globalPolicy: {
        tone: 'professional',
        formality: 'semiFormal',
        verbosity: 'brief',
        jargonLevel: 'high',
        safetyPosture: 'strict'
      },
      channels: {
        groupChat: {
          proactivePolicy: {
            initiativeLevel: 'lightlyProactive',
            socialSensitivity: 'high',
            minContributionMinutes: 3
          }
        },
        dm: {
          qaBehavior: {
            answerScope: 'broaderSubjectArea',
            responseLength: 'medium',
            clarifyWhenAmbiguous: true,
            addContextWhenUseful: true,
            allowFollowUpDialogue: true
          },
          proactivePolicy: {
            initiativeLevel: 'passive',
            socialSensitivity: 'high'
          }
        }
      }
    }
  },

  classroomLecture: {
    goals: ['clarify_confusion', 'surface_signal', 'structure_conversation', 'invite_quieter_voices', 'private_reassure', 'private_not_alone', 'private_interest_bridge', 'private_transcript_hook'],
    behaviorPolicy: {
      globalPolicy: {
        tone: 'warmSupportive',
        formality: 'casual',
        verbosity: 'medium',
        jargonLevel: 'low',
        safetyPosture: 'standard'
      },
      channels: {
        groupChat: {
          proactivePolicy: {
            initiativeLevel: 'moderatelyProactive',
            socialSensitivity: 'high',
            minContributionMinutes: 2
          }
        },
        dm: {
          qaBehavior: {
            answerScope: 'helpUserUnderstandTheLecture',
            responseLength: 'medium',
            clarifyWhenAmbiguous: true,
            addContextWhenUseful: true,
            allowFollowUpDialogue: true
          },
          proactivePolicy: {
            initiativeLevel: 'moderatelyProactive',
            socialSensitivity: 'high',
            minContributionMinutes: 3
          }
        }
      }
    }
  },

  companyMeeting: {
    goals: ['surface_signal', 'synthesize_discussion', 'poll_reveal', 'structure_conversation', 'invite_quieter_voices', 'private_reassure', 'private_not_alone', 'private_interest_bridge', 'private_transcript_hook'],
    behaviorPolicy: {
      globalPolicy: {
        tone: 'clearNeutral',
        formality: 'semiFormal',
        verbosity: 'brief',
        jargonLevel: 'medium',
        safetyPosture: 'strict'
      },
      channels: {
        groupChat: {
          proactivePolicy: {
            initiativeLevel: 'lightlyProactive',
            socialSensitivity: 'high',
            minContributionMinutes: 3
          }
        },
        dm: {
          qaBehavior: {
            answerScope: 'companyContextOnly',
            responseLength: 'short',
            clarifyWhenAmbiguous: true,
            addContextWhenUseful: false,
            allowFollowUpDialogue: false
          },
          proactivePolicy: {
            initiativeLevel: 'lightlyProactive',
            socialSensitivity: 'high',
            minContributionMinutes: 5
          }
        }
      }
    }
  },

  casualCommunityEvent: {
    goals: ['play_commentary', 'provoke_participation', 'challenge_consensus', 'surface_signal', 'invite_quieter_voices', 'bridge_topics', 'private_reassure', 'private_not_alone', 'private_interest_bridge', 'private_transcript_hook'],
    behaviorPolicy: {
      globalPolicy: {
        tone: 'playful',
        formality: 'casual',
        verbosity: 'medium',
        jargonLevel: 'low',
        safetyPosture: 'standard'
      },
      channels: {
        groupChat: {
          proactivePolicy: {
            initiativeLevel: 'moderatelyProactive',
            socialSensitivity: 'medium',
            minContributionMinutes: 2
          }
        },
        dm: {
          qaBehavior: {
            answerScope: 'open',
            responseLength: 'medium',
            clarifyWhenAmbiguous: false,
            addContextWhenUseful: true,
            allowFollowUpDialogue: true
          },
          proactivePolicy: {
            initiativeLevel: 'moderatelyProactive',
            socialSensitivity: 'medium',
            minContributionMinutes: 3
          }
        }
      }
    }
  },

  publicPanelDiscussion: {
    goals: ['provoke_participation', 'challenge_consensus', 'surface_signal', 'invite_quieter_voices', 'synthesize_discussion', 'bridge_topics', 'private_reassure', 'private_not_alone', 'private_interest_bridge', 'private_transcript_hook'],
    behaviorPolicy: {
      globalPolicy: {
        tone: 'warmSupportive',
        formality: 'semiFormal',
        verbosity: 'brief',
        jargonLevel: 'medium',
        safetyPosture: 'standard'
      },
      channels: {
        groupChat: {
          proactivePolicy: {
            initiativeLevel: 'moderatelyProactive',
            socialSensitivity: 'medium',
            minContributionMinutes: 2
          }
        },
        dm: {
          qaBehavior: {
            answerScope: 'broaderSubjectArea',
            responseLength: 'medium',
            clarifyWhenAmbiguous: true,
            addContextWhenUseful: true,
            allowFollowUpDialogue: true
          },
          proactivePolicy: {
            initiativeLevel: 'lightlyProactive',
            socialSensitivity: 'medium',
            minContributionMinutes: 4
          }
        }
      }
    }
  }
}
