import { BehaviorPolicy, ConversationContext } from '../src/types/index.types.js'

export interface ConversationTemplate {
  goals: string[]
  behaviorPolicy: BehaviorPolicy
  conversationContext: ConversationContext
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
    },

    conversationContext: {
      conversationType: 'Academic lecture',
      purpose: 'Deepen understanding of the presented research and open lines of scholarly inquiry.',
      audience: {
        expertiseLevel: 'expert',
        assumedBackgroundKnowledge: 'high',
        type: ['researchers', 'academics', 'graduate students']
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
    },
    conversationContext: {
      conversationType: 'Classroom lecture',
      purpose: 'Help students follow along, surface confusion early, and reinforce key concepts.',
      audience: {
        expertiseLevel: 'beginner',
        assumedBackgroundKnowledge: 'low',
        type: ['students'],
        description: 'Learners who may be encountering this material for the first time.'
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
    },
    conversationContext: {
      conversationType: 'Company meeting',
      purpose: 'Align on decisions, surface concerns across seniority levels, and capture outcomes.',
      audience: {
        expertiseLevel: 'mixed',
        assumedBackgroundKnowledge: 'medium',
        type: ['employees', 'managers', 'executives'],
        description: 'Internal audience with varying seniority — power dynamics may suppress candid input.'
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
    },
    conversationContext: {
      conversationType: 'Community event',
      purpose: 'Build connection and energy among participants — surface shared interests, spark conversation, and make the room feel alive.',
      audience: {
        expertiseLevel: 'mixed',
        assumedBackgroundKnowledge: 'low',
        type: ['community members', 'local residents', 'hobbyists', 'general public'],
        description: 'Informal gathering — participants came to connect and have fun, not to be lectured at.'
      }
    }
  },

  publicPanelDiscussion: {
    goals: ['provoke_participation', 'challenge_consensus', 'missing_perspective', 'surface_signal', 'invite_quieter_voices', 'synthesize_discussion', 'bridge_topics', 'private_reassure', 'private_not_alone', 'private_interest_bridge', 'private_transcript_hook'],
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
    },
    conversationContext: {
      conversationType: 'Panel discussion',
      purpose: 'Draw out the tensions between panelists and connect audience reactions to the live debate.',
      audience: {
        expertiseLevel: 'mixed',
        assumedBackgroundKnowledge: 'lowToMedium',
        type: ['general public', 'practitioners', 'interested non-experts'],
        description: 'Varied background — some domain familiarity, most engaged as interested observers.'
      }
    }
  }
}
