/* eslint-disable no-console */

/**
 * Seed the checkin LangSmith dataset with scenarios for each private goal,
 * spread across multiple event templates.
 *
 * Usage:
 *   yarn evaluate:checkin:seed
 *   yarn evaluate:checkin:seed --dataset=my-dataset
 *   yarn evaluate:checkin:seed --dry-run
 */

import { Client } from 'langsmith'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const datasetName = args.find((a) => a.startsWith('--dataset='))?.split('=')[1] || 'checkin'

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

interface ChatMessage {
  text: string
  userIndex: number
  offsetSeconds: number
}

interface DmMessage {
  text: string
  offsetSeconds: number
}

interface TranscriptMessage {
  text: string
  speaker: string
  offsetSeconds: number
}

interface Scenario {
  description: string
  goalId: string
  endTimeSeconds: number
  eventName?: string
  eventDescription?: string
  presenters?: { name: string; bio: string }[]
  transcriptMessages?: TranscriptMessage[]
  chatMessages?: ChatMessage[]
  // userIndex 0 = target participant; 1, 2 = other participants
  participantDms?: DmMessage[]
  otherParticipantDms?: { userIndex: 1 | 2; text: string; offsetSeconds: number }[]
}

interface Example {
  name: string
  inputs: Scenario
  metadata: {
    goalId: string
    templateName: string
    notes?: string
  }
}

const examples: Example[] = [
  // ── private_reassure ────────────────────────────────────────────────────────

  {
    name: 'private_reassure — classroomLecture — student hedging AI questions',
    inputs: {
      description:
        'An intro AI lecture for students. Target participant has sent three messages in their DM, each preaced with a self-minimizing hedge. Clear pattern of hesitation. Should trigger private_reassure. warmSupportive/casual register.',
      goalId: 'private_reassure',
      endTimeSeconds: 380,
      eventName: 'Understanding machine learning: a gentle introduction',
      eventDescription:
        'Dr. Nadia Osei-Bonsu introduces machine learning concepts to students with no prior technical background.',
      presenters: [{ name: 'Dr. Nadia Osei-Bonsu', bio: 'Lecturer in digital literacy and technology education.' }],
      transcriptMessages: [
        {
          speaker: 'Dr. Osei-Bonsu',
          text: 'A neural network learns by adjusting weights — small numbers that control how strongly each input influences the output.',
          offsetSeconds: 30
        },
        {
          speaker: 'Dr. Osei-Bonsu',
          text: 'The training process is called gradient descent. The model keeps adjusting weights in the direction that reduces its error.',
          offsetSeconds: 90
        },
        {
          speaker: 'Dr. Osei-Bonsu',
          text: 'Overfitting happens when a model learns the training data too well — it memorises rather than generalises.',
          offsetSeconds: 160
        },
        {
          speaker: 'Dr. Osei-Bonsu',
          text: 'One way to prevent this is dropout — randomly switching off neurons during training so the model cannot rely on any single path.',
          offsetSeconds: 230
        }
      ],
      chatMessages: [
        { text: 'This makes sense so far', userIndex: 1, offsetSeconds: 250 },
        { text: 'Nice explanation of gradient descent', userIndex: 2, offsetSeconds: 260 }
      ],
      participantDms: [
        { text: 'Sorry if this is too basic — what does it mean when they say the model converges?', offsetSeconds: 90 },
        {
          text: 'Probably missing something obvious, but how does the model know when to stop training?',
          offsetSeconds: 200
        },
        {
          text: 'This might sound silly but what is the difference between a parameter and a hyperparameter?',
          offsetSeconds: 310
        }
      ]
    },
    metadata: {
      goalId: 'private_reassure',
      templateName: 'classroomLecture',
      notes:
        'Three hedged messages — clear pattern. Should intervene. warmSupportive/casual register. Must not diagnose, must not ask them to speak up publicly.'
    }
  },

  {
    name: 'private_reassure — companyMeeting — employee self-minimizing during strategy session',
    inputs: {
      description:
        'Q2 strategy review all-hands. Target participant has sent three self-minimizing DMs asking reasonable questions about the strategy. Senior voices in chat are aligning positively. Should trigger private_reassure. clearNeutral/semiFormal, power-aware.',
      goalId: 'private_reassure',
      endTimeSeconds: 420,
      eventName: 'Q2 strategy review and H2 planning',
      eventDescription: 'VP of Product Marcus Adeyemi presents H2 strategy and product direction for the company.',
      presenters: [{ name: 'Marcus Adeyemi', bio: 'VP of Product.' }],
      transcriptMessages: [
        {
          speaker: 'Marcus Adeyemi',
          text: 'Our core bet for H2 is consolidating around the enterprise segment. We are moving away from the long tail of SMB accounts.',
          offsetSeconds: 60
        },
        {
          speaker: 'Marcus Adeyemi',
          text: 'This means some products will be sunsetted. We will communicate the timeline to affected customers in August.',
          offsetSeconds: 150
        },
        {
          speaker: 'Marcus Adeyemi',
          text: 'The metrics we will track are ARR growth, net revenue retention, and time-to-value for new enterprise accounts.',
          offsetSeconds: 240
        }
      ],
      chatMessages: [
        { text: 'Makes sense given where the market is heading', userIndex: 1, offsetSeconds: 280 },
        { text: 'Exciting direction — glad we are focusing', userIndex: 2, offsetSeconds: 295 }
      ],
      participantDms: [
        {
          text: 'Sorry, probably not the right forum — but what happens to the team working on the products being sunsetted?',
          offsetSeconds: 90
        },
        {
          text: 'I feel like I am missing context, but does this affect the SMB roadmap we agreed in Q1?',
          offsetSeconds: 210
        },
        { text: 'Apologies for the basic question — are we still hiring for teams in affected areas?', offsetSeconds: 330 }
      ]
    },
    metadata: {
      goalId: 'private_reassure',
      templateName: 'companyMeeting',
      notes:
        'Three hedged messages. Should intervene. clearNeutral/semiFormal. Power dynamics real — must not expose them or suggest speaking up publicly.'
    }
  },

  {
    name: 'private_reassure — publicPanelDiscussion — attendee apologizing for skeptical view',
    inputs: {
      description:
        'Panel debate on the four-day work week. Target participant has sent three DMs each prefaced with an apology or hedge before expressing a legitimate skeptical view. Should trigger private_reassure. warmSupportive/semiFormal.',
      goalId: 'private_reassure',
      endTimeSeconds: 450,
      eventName: 'The four-day week: productivity miracle or management nightmare?',
      eventDescription: 'Hana Yilmaz and Robert Gould debate the evidence for and against shorter working weeks.',
      presenters: [
        { name: 'Hana Yilmaz', bio: 'Researcher and advocate for flexible working policy.' },
        { name: 'Robert Gould', bio: 'Operations consultant and critic of one-size-fits-all working models.' }
      ],
      transcriptMessages: [
        {
          speaker: 'Hana Yilmaz',
          text: 'The evidence from the Iceland and UK trials is clear — output stays the same or improves with a four-day week.',
          offsetSeconds: 60
        },
        {
          speaker: 'Robert Gould',
          text: 'But those trials were opt-in. Self-selection bias means you are measuring the most motivated workplaces, not average ones.',
          offsetSeconds: 120
        },
        {
          speaker: 'Hana Yilmaz',
          text: "Reduced hours forces teams to cut unnecessary meetings. The Parkinson's Law effect is real and measurable.",
          offsetSeconds: 210
        },
        {
          speaker: 'Robert Gould',
          text: 'That is true for knowledge work. It completely falls apart for client-facing and shift-based roles.',
          offsetSeconds: 290
        }
      ],
      chatMessages: [
        { text: 'Robert raises a fair point about shift work', userIndex: 1, offsetSeconds: 320 },
        { text: 'I think the Iceland data is more robust than Robert suggests', userIndex: 2, offsetSeconds: 340 }
      ],
      participantDms: [
        {
          text: 'Sorry to be contrarian but I am not sure the trial data translates to healthcare — is that naive?',
          offsetSeconds: 130
        },
        {
          text: "Probably overthinking this, but does the Parkinson's Law argument assume you can control your own schedule?",
          offsetSeconds: 250
        },
        {
          text: 'I might be wrong but has anyone looked at data for roles where you cannot compress deliverables?',
          offsetSeconds: 370
        }
      ]
    },
    metadata: {
      goalId: 'private_reassure',
      templateName: 'publicPanelDiscussion',
      notes:
        'Three apologetic DMs with legitimate skeptical questions. Should intervene. warmSupportive/semiFormal. Must not name them to the room.'
    }
  },

  {
    name: 'private_reassure — publicAcademicLecture — passive DM policy, expect NO_INTERVENTION',
    inputs: {
      description:
        'Academic neuroscience lecture. Target participant has sent three self-minimizing DMs. However, the publicAcademicLecture template has a passive DM initiative level — the agent should not reach out proactively.',
      goalId: 'private_reassure',
      endTimeSeconds: 400,
      eventName: 'Cortical oscillations and memory consolidation: evidence from sleep research',
      eventDescription:
        'Prof. Emeka Adeyemi presents findings from a decade of research on sleep-dependent memory consolidation.',
      presenters: [{ name: 'Prof. Emeka Adeyemi', bio: 'Professor of cognitive neuroscience and sleep researcher.' }],
      transcriptMessages: [
        {
          speaker: 'Prof. Adeyemi',
          text: 'Slow-wave sleep is characterized by high-amplitude, low-frequency oscillations in the delta range — 0.5 to 4 Hz.',
          offsetSeconds: 60
        },
        {
          speaker: 'Prof. Adeyemi',
          text: 'These synchronise with hippocampal sharp-wave ripples, creating a dialogue that transfers representations to neocortex.',
          offsetSeconds: 150
        },
        {
          speaker: 'Prof. Adeyemi',
          text: 'Our data suggests spindle density during NREM stage 2 is a stronger predictor of declarative memory retention than total sleep duration.',
          offsetSeconds: 240
        }
      ],
      participantDms: [
        {
          text: 'Sorry if this is elementary — what is the difference between declarative and non-declarative memory?',
          offsetSeconds: 90
        },
        { text: 'Probably a basic question but what are sharp-wave ripples exactly?', offsetSeconds: 210 },
        { text: 'I might be missing something — does the spindle density effect interact with age?', offsetSeconds: 330 }
      ]
    },
    metadata: {
      goalId: 'private_reassure',
      templateName: 'publicAcademicLecture',
      notes:
        'Three hedged DMs — pattern met. But DM initiative level is passive for this template. Expected output: NO_INTERVENTION. Tests that initiative level overrides goal trigger.'
    }
  },

  {
    name: 'private_reassure — casualCommunityEvent — single message, expect NO_INTERVENTION',
    inputs: {
      description:
        'Local food market tasting event. Target participant sent only one hedged DM. Pattern threshold (minMessageCount: 3) not met — goal should be filtered before LLM call. Expected output: NO_INTERVENTION.',
      goalId: 'private_reassure',
      endTimeSeconds: 220,
      eventName: 'Local food market: tasting session and producer Q&A',
      eventDescription: 'Eight local food producers open their stalls for tasting and conversation.',
      presenters: [{ name: 'Priya Mehta', bio: 'Market organiser and local food advocate.' }],
      transcriptMessages: [
        {
          speaker: 'Priya Mehta',
          text: 'Welcome everyone — really glad you could make it today. We have eight producers here with stalls set up around the room.',
          offsetSeconds: 10
        },
        {
          speaker: 'Priya Mehta',
          text: 'Feel free to wander, taste everything, and ask questions directly to the producers — they love talking about their food.',
          offsetSeconds: 40
        }
      ],
      chatMessages: [
        { text: 'This is lovely!', userIndex: 1, offsetSeconds: 60 },
        { text: 'The sourdough is incredible', userIndex: 2, offsetSeconds: 75 }
      ],
      participantDms: [{ text: 'Sorry if this is obvious — is there a map of which stall is where?', offsetSeconds: 60 }]
    },
    metadata: {
      goalId: 'private_reassure',
      templateName: 'casualCommunityEvent',
      notes: 'Only one hedged message — minMessageCount: 3 not met. Expected output: NO_INTERVENTION.'
    }
  },

  // ── private_not_alone ────────────────────────────────────────────────────────

  {
    name: 'private_not_alone — classroomLecture — shared "I am behind" feeling across 3 students',
    inputs: {
      description:
        'Financial planning lecture for students. Three participants have each privately expressed feeling behind or out of their depth — the same "I am the only one who does not know this" pattern. Target participant expressed it first. Should trigger private_not_alone. warmSupportive/casual.',
      goalId: 'private_not_alone',
      endTimeSeconds: 240,
      eventName: 'Introduction to financial planning for students',
      eventDescription:
        'Kezia Osei, financial wellbeing advisor, covers investing basics, ISAs, and common early-career mistakes.',
      presenters: [{ name: 'Kezia Osei', bio: 'Financial wellbeing advisor and personal finance educator.' }],
      transcriptMessages: [
        {
          speaker: 'Kezia Osei',
          text: 'The most important concept is compound interest. Money you invest today earns returns, and those returns earn returns.',
          offsetSeconds: 30
        },
        {
          speaker: 'Kezia Osei',
          text: 'A common mistake is waiting until you earn enough to start saving. The opportunity cost of delay is enormous.',
          offsetSeconds: 90
        },
        {
          speaker: 'Kezia Osei',
          text: 'Even fifty pounds a month, started at 22, is worth more at 65 than two hundred pounds a month started at 35.',
          offsetSeconds: 150
        },
        {
          speaker: 'Kezia Osei',
          text: 'The ISA allowance is twenty thousand pounds per year. Most of you will not use it all — but knowing it is there matters.',
          offsetSeconds: 200
        }
      ],
      chatMessages: [
        { text: 'This is making me anxious', userIndex: 1, offsetSeconds: 215 },
        { text: 'Really useful framing on compound interest', userIndex: 2, offsetSeconds: 225 }
      ],
      participantDms: [{ text: 'I feel like everyone here already knows all this and I am way behind', offsetSeconds: 80 }],
      otherParticipantDms: [
        { userIndex: 1, text: 'I do not really understand any of this and I feel bad admitting it', offsetSeconds: 110 },
        {
          userIndex: 2,
          text: 'Embarrassed to say I have never opened a savings account — feels like I am the only one',
          offsetSeconds: 140
        }
      ]
    },
    metadata: {
      goalId: 'private_not_alone',
      templateName: 'classroomLecture',
      notes:
        'Three participants share the "I am behind" pattern privately. Message should frame as solidarity. Must not name others or reveal specifics. warmSupportive/casual.'
    }
  },

  {
    name: 'private_not_alone — casualCommunityEvent — shared safety concern across 3 residents',
    inputs: {
      description:
        'Neighbourhood watch meeting. Three residents have each privately expressed feeling unsafe walking home at night in the same area. Target participant expressed it first. Should trigger private_not_alone. playful/casual but this is a sensitive topic — warmth matters.',
      goalId: 'private_not_alone',
      endTimeSeconds: 240,
      eventName: 'Neighbourhood watch: safety concerns and what residents can do',
      eventDescription: 'Inspector Claire Nwachukwu presents local crime data and practical deterrents residents can use.',
      presenters: [{ name: 'Inspector Claire Nwachukwu', bio: 'Local policing inspector and community liaison.' }],
      transcriptMessages: [
        {
          speaker: 'Inspector Nwachukwu',
          text: 'We have seen a 12% increase in opportunistic vehicle break-ins in the area over the past quarter.',
          offsetSeconds: 30
        },
        {
          speaker: 'Inspector Nwachukwu',
          text: 'The most effective deterrents are simple — visible locks, no valuables left visible, good lighting.',
          offsetSeconds: 90
        },
        {
          speaker: 'Inspector Nwachukwu',
          text: 'Community reporting is genuinely useful. Even partial plate numbers help us identify repeat offenders.',
          offsetSeconds: 160
        }
      ],
      chatMessages: [
        { text: 'This is really worrying', userIndex: 1, offsetSeconds: 180 },
        { text: 'Has anything changed with police response times recently?', userIndex: 2, offsetSeconds: 195 }
      ],
      participantDms: [
        { text: 'I have felt unsafe walking home from the station at night lately — is that just me?', offsetSeconds: 100 }
      ],
      otherParticipantDms: [
        { userIndex: 1, text: 'Same honestly, the stretch past the car park is really bad at night', offsetSeconds: 130 },
        {
          userIndex: 2,
          text: 'I avoid certain streets after dark now, which I have never had to do before',
          offsetSeconds: 165
        }
      ]
    },
    metadata: {
      goalId: 'private_not_alone',
      templateName: 'casualCommunityEvent',
      notes:
        'Three residents share the same unsafe-at-night concern privately. Must surface as solidarity, not alarm. No attribution. casualCommunityEvent tone but sensitive topic.'
    }
  },

  {
    name: 'private_not_alone — companyMeeting — no cross-participant evidence, expect NO_INTERVENTION',
    inputs: {
      description:
        'Engineering roadmap review. Target participant privately expressed concern about the 20% debt-reduction commitment not surviving first crunch. No other participant has expressed a similar concern. Cross-participant trigger condition not met — LLM should decline. Expected output: NO_INTERVENTION.',
      goalId: 'private_not_alone',
      endTimeSeconds: 360,
      eventName: 'Engineering roadmap review: H2 priorities',
      eventDescription:
        'Head of Engineering Yuki Tanaka walks through H2 engineering priorities and the new 20% debt-reduction allocation.',
      presenters: [{ name: 'Yuki Tanaka', bio: 'Head of Engineering.' }],
      transcriptMessages: [
        {
          speaker: 'Yuki Tanaka',
          text: 'We are doubling down on performance work this half — specifically around search latency and indexing throughput.',
          offsetSeconds: 45
        },
        {
          speaker: 'Yuki Tanaka',
          text: 'Three of the legacy services will be migrated to the new infrastructure in order of traffic volume.',
          offsetSeconds: 100
        },
        {
          speaker: 'Yuki Tanaka',
          text: 'We are also introducing a 20% time allocation for debt reduction, effective next sprint.',
          offsetSeconds: 155
        }
      ],
      chatMessages: [{ text: 'Great to finally have dedicated time for the debt work', userIndex: 1, offsetSeconds: 165 }],
      participantDms: [
        {
          text: 'I am worried the 20% time will not survive the first crunch sprint — how firm is that commitment?',
          offsetSeconds: 160
        }
      ],
      otherParticipantDms: []
    },
    metadata: {
      goalId: 'private_not_alone',
      templateName: 'companyMeeting',
      notes:
        'Only one participant with this concern. No cross-participant evidence. Expected output: NO_INTERVENTION. sourceMessages would be fabricated.'
    }
  },

  // ── private_interest_bridge ──────────────────────────────────────────────────

  {
    name: 'private_interest_bridge — publicPanelDiscussion — shared curiosity about junior employee experience',
    inputs: {
      description:
        'Panel on the future of remote work. Three participants have each privately asked about early-career or junior employee experience — a topic the panelists have not addressed. Target participant asked first. Should trigger private_interest_bridge. warmSupportive/semiFormal.',
      goalId: 'private_interest_bridge',
      endTimeSeconds: 270,
      eventName: 'The future of remote work: what do employees actually want?',
      eventDescription:
        'Researcher Chioma Okafor and exec Ben Hartley debate what the evidence says about remote work outcomes.',
      presenters: [
        { name: 'Chioma Okafor', bio: 'Organisational psychologist and workplace research lead.' },
        { name: 'Ben Hartley', bio: 'COO of a mid-size software company with a hybrid-first policy.' }
      ],
      transcriptMessages: [
        {
          speaker: 'Chioma Okafor',
          text: 'The data is clear that autonomy over location is now the single strongest predictor of job satisfaction.',
          offsetSeconds: 45
        },
        {
          speaker: 'Ben Hartley',
          text: 'But when we look at output metrics, the pattern is more complex — some roles see gains, others see losses.',
          offsetSeconds: 110
        },
        {
          speaker: 'Chioma Okafor',
          text: 'The roles where you see losses are usually roles that were underspecified to begin with. Remote exposes that.',
          offsetSeconds: 175
        },
        {
          speaker: 'Ben Hartley',
          text: 'The real question is how you maintain culture and mentorship pipelines across a distributed workforce.',
          offsetSeconds: 230
        }
      ],
      chatMessages: [
        { text: 'The mentorship point is a real tension', userIndex: 1, offsetSeconds: 245 },
        { text: 'Would love to hear more on how they operationalise the autonomy metric', userIndex: 2, offsetSeconds: 258 }
      ],
      participantDms: [
        {
          text: 'Has anyone looked at what remote work means for junior employees specifically — career growth and visibility?',
          offsetSeconds: 140
        }
      ],
      otherParticipantDms: [
        {
          userIndex: 1,
          text: 'Really curious whether the research looks at early-career workers differently from experienced ones',
          offsetSeconds: 170
        },
        {
          userIndex: 2,
          text: 'The junior employee experience feels underrepresented in this panel — it is a very different thing when you are just starting out',
          offsetSeconds: 210
        }
      ]
    },
    metadata: {
      goalId: 'private_interest_bridge',
      templateName: 'publicPanelDiscussion',
      notes:
        'Three participants privately curious about the same unaddressed angle. Frame as shared curiosity, not anxiety. Must not name others. warmSupportive/semiFormal.'
    }
  },

  {
    name: 'private_interest_bridge — companyMeeting — shared questions about pregnancy loss provision',
    inputs: {
      description:
        'Company parental leave policy update. Three employees have each privately asked about details of the new pregnancy loss provision that the presenter did not cover. Target participant asked first. Should trigger private_interest_bridge. clearNeutral/semiFormal, strict safety.',
      goalId: 'private_interest_bridge',
      endTimeSeconds: 360,
      eventName: 'Updated parental leave policy — what is changing',
      eventDescription: 'People Partner Amara Diallo presents the updated parental leave and pregnancy loss policies.',
      presenters: [{ name: 'Amara Diallo', bio: 'People Partner.' }],
      transcriptMessages: [
        {
          speaker: 'Amara Diallo',
          text: 'From September, primary carer leave increases from 18 to 26 weeks at full pay.',
          offsetSeconds: 30
        },
        {
          speaker: 'Amara Diallo',
          text: 'Secondary carer leave doubles to four weeks. We are removing the distinction between birth and adoptive parents.',
          offsetSeconds: 80
        },
        {
          speaker: 'Amara Diallo',
          text: 'The policy also now covers pregnancy loss, with immediate access to five days of paid leave.',
          offsetSeconds: 130
        },
        {
          speaker: 'Amara Diallo',
          text: 'We will publish the full policy on the intranet by end of week. Your people partner is the first point of contact for individual questions.',
          offsetSeconds: 175
        }
      ],
      chatMessages: [{ text: 'Really welcome change on the secondary carer leave', userIndex: 1, offsetSeconds: 185 }],
      participantDms: [
        {
          text: 'How does the pregnancy loss provision interact with sick leave — is it additional or does it come off your entitlement?',
          offsetSeconds: 145
        }
      ],
      otherParticipantDms: [
        {
          userIndex: 1,
          text: 'Does the pregnancy loss leave also cover partners, or only the person who was pregnant?',
          offsetSeconds: 158
        },
        {
          userIndex: 2,
          text: 'Is there any support beyond the five days — like a phased return or access to counselling?',
          offsetSeconds: 172
        }
      ]
    },
    metadata: {
      goalId: 'private_interest_bridge',
      templateName: 'companyMeeting',
      notes:
        'Three employees privately asking about pregnancy loss provision details. Highly sensitive topic — aggregate carefully. clearNeutral/semiFormal. Strict safety posture. No attribution.'
    }
  },

  {
    name: 'private_interest_bridge — classroomLecture — only target curious, expect NO_INTERVENTION',
    inputs: {
      description:
        'Behavioural economics lecture. Only the target participant has privately asked about cultural variation in loss aversion. No other participant has expressed curiosity about the same topic. Cross-participant trigger condition not met — LLM should decline. Expected output: NO_INTERVENTION.',
      goalId: 'private_interest_bridge',
      endTimeSeconds: 220,
      eventName: 'Introduction to behavioural economics',
      eventDescription:
        'Dr. Lars Holm introduces core behavioural economics concepts including loss aversion, the endowment effect, and anchoring.',
      presenters: [{ name: 'Dr. Lars Holm', bio: 'Lecturer in economics and behavioural science.' }],
      transcriptMessages: [
        {
          speaker: 'Dr. Holm',
          text: 'Loss aversion means we feel losses roughly twice as intensely as equivalent gains.',
          offsetSeconds: 30
        },
        {
          speaker: 'Dr. Holm',
          text: 'The endowment effect is related — we overvalue things simply because we own them.',
          offsetSeconds: 80
        },
        {
          speaker: 'Dr. Holm',
          text: 'Anchoring shows that irrelevant numbers can shape our estimates in predictable ways.',
          offsetSeconds: 130
        }
      ],
      participantDms: [
        { text: 'Is there any research on whether loss aversion differs between cultures?', offsetSeconds: 140 }
      ],
      otherParticipantDms: []
    },
    metadata: {
      goalId: 'private_interest_bridge',
      templateName: 'classroomLecture',
      notes: 'Only one participant curious. No cross-participant evidence. Expected output: NO_INTERVENTION.'
    }
  },

  // ── private_transcript_hook ──────────────────────────────────────────────────

  {
    name: 'private_transcript_hook — publicAcademicLecture — dense mRNA content, passive DM policy, expect NO_INTERVENTION',
    inputs: {
      description:
        'Academic lecture on mRNA therapeutics. Six dense technical concepts delivered in under two minutes. Silent participant has sent no DMs. Content is clearly dense enough to warrant a hook, but the publicAcademicLecture DM initiative level is passive — policy should override content density. Expected output: NO_INTERVENTION.',
      goalId: 'private_transcript_hook',
      endTimeSeconds: 160,
      eventName: 'Advances in mRNA therapeutics: from COVID vaccines to cancer treatment',
      eventDescription:
        'Dr. Fatima Al-Hassan presents the state of mRNA therapeutic development across vaccines and oncology.',
      presenters: [{ name: 'Dr. Fatima Al-Hassan', bio: 'Molecular biologist and mRNA therapeutics researcher.' }],
      transcriptMessages: [
        {
          speaker: 'Dr. Al-Hassan',
          text: 'mRNA therapeutics work by delivering synthetic messenger RNA into cells, which then translate that RNA into a protein.',
          offsetSeconds: 0
        },
        {
          speaker: 'Dr. Al-Hassan',
          text: 'The key delivery challenge is cellular uptake — lipid nanoparticles solved this by encapsulating the mRNA and facilitating endosomal escape.',
          offsetSeconds: 20
        },
        {
          speaker: 'Dr. Al-Hassan',
          text: 'First-generation COVID vaccines used modified nucleosides to reduce innate immune recognition and extend translation.',
          offsetSeconds: 45
        },
        {
          speaker: 'Dr. Al-Hassan',
          text: 'We are now seeing second-generation approaches that use self-amplifying RNA — the construct encodes both the antigen and the replication machinery.',
          offsetSeconds: 70
        },
        {
          speaker: 'Dr. Al-Hassan',
          text: "In oncology, the target is tumour-associated antigens — neo-antigens specific to the patient's mutation profile.",
          offsetSeconds: 100
        },
        {
          speaker: 'Dr. Al-Hassan',
          text: "The manufacturing challenge is personalisation at scale: each patient's vaccine is computationally predicted from their tumour sequencing data.",
          offsetSeconds: 130
        }
      ],
      participantDms: []
    },
    metadata: {
      goalId: 'private_transcript_hook',
      templateName: 'publicAcademicLecture',
      notes:
        'Dense transcript but passive DM initiative level. Tests that policy suppresses even a clearly qualifying content signal. Expected output: NO_INTERVENTION.'
    }
  },

  {
    name: 'private_transcript_hook — companyMeeting — dense restructure announcements, silent participant',
    inputs: {
      description:
        'Q3 all-hands covering a major company reorganisation. Nine back-to-back structural announcements — new business units, leadership changes, redundancies, budget reallocation, and an immediate operating model change. Other participants are reacting in chat. Target participant (users[0]) has sent no DMs and nothing in chat for the entire session. Should trigger private_transcript_hook. clearNeutral/semiFormal.',
      goalId: 'private_transcript_hook',
      endTimeSeconds: 360,
      eventName: 'Q3 all-hands: structure changes and new operating model',
      eventDescription:
        'CEO Lena Mohr announces a major reorganisation into three business units and an immediate shift to a new operating model.',
      presenters: [{ name: 'Lena Mohr', bio: 'CEO.' }],
      transcriptMessages: [
        {
          speaker: 'Lena Mohr',
          text: 'We are reorganising into three business units: Consumer, Enterprise, and Platform. Each will have its own P&L from Q4.',
          offsetSeconds: 60
        },
        {
          speaker: 'Lena Mohr',
          text: 'Consumer will be led by David Park, who moves from our Singapore office effective immediately.',
          offsetSeconds: 80
        },
        {
          speaker: 'Lena Mohr',
          text: 'Enterprise moves under Maria Chen. She will be hiring two new heads of sales this quarter and expanding the team by 40%.',
          offsetSeconds: 100
        },
        {
          speaker: 'Lena Mohr',
          text: 'The Platform team consolidates engineering infrastructure, developer tools, and the data function under one roof.',
          offsetSeconds: 125
        },
        {
          speaker: 'Lena Mohr',
          text: 'As part of this, we are cutting three legacy product lines. Teams working on those will be reassigned or offered voluntary redundancy.',
          offsetSeconds: 190
        },
        {
          speaker: 'Lena Mohr',
          text: 'All budget cycles will now run per business unit. Shared services budgets are being redistributed — affected teams will be notified individually by Friday.',
          offsetSeconds: 215
        },
        {
          speaker: 'Lena Mohr',
          text: 'The new operating model is live from the first of next month. Reporting lines change then. HR will send updated org charts today.',
          offsetSeconds: 240
        },
        {
          speaker: 'Lena Mohr',
          text: 'Office space in London is being consolidated. The Shoreditch office closes end of October. Everyone currently based there moves to the main campus.',
          offsetSeconds: 268
        },
        {
          speaker: 'Lena Mohr',
          text: 'We will hold open Q&A sessions Thursday and Friday for anyone with questions. Calendar invites going out this afternoon. That is all for now.',
          offsetSeconds: 300
        }
      ],
      chatMessages: [
        { text: 'Wow — a lot to take in', userIndex: 1, offsetSeconds: 315 },
        { text: 'Which product lines are being cut? Will that be announced separately?', userIndex: 2, offsetSeconds: 330 },
        { text: 'Does this affect people who are hybrid between two of the new units?', userIndex: 1, offsetSeconds: 345 }
      ],
      participantDms: []
    },
    metadata: {
      goalId: 'private_transcript_hook',
      templateName: 'companyMeeting',
      notes:
        'Nine rapid high-stakes announcements including redundancies and office closure, with the densest content (redundancies, budget, new operating model, office closure) all falling within the last-180s event-condition window. Other participants visibly reacting in chat. Target participant completely silent. clearNeutral/semiFormal. Low-pressure check-in. Must not imply confusion or call out their silence.'
    }
  },

  {
    name: 'private_transcript_hook — casualCommunityEvent — sparse intro content, expect NO_INTERVENTION',
    inputs: {
      description:
        'Monthly book club opening. The transcript contains only warm welcome and housekeeping remarks — light content, slow pace, no substantive information density. Silent participant has sent no DMs. The density event condition should evaluate on the recent window and fail. Expected output: NO_INTERVENTION.',
      goalId: 'private_transcript_hook',
      endTimeSeconds: 220,
      eventName: 'Monthly book club: welcome and introductions',
      eventDescription: 'Priya Mehta opens the June book club session with welcomes and a recap of how the session works.',
      presenters: [{ name: 'Priya Mehta', bio: 'Book club organiser.' }],
      transcriptMessages: [
        {
          speaker: 'Priya Mehta',
          text: 'Hi everyone, welcome to the June session — really glad you are all here.',
          offsetSeconds: 0
        },
        {
          speaker: 'Priya Mehta',
          text: 'For anyone who is new, we usually spend the first ten minutes just checking in before we dive into the book.',
          offsetSeconds: 25
        },
        {
          speaker: 'Priya Mehta',
          text: 'No pressure on anyone to have finished it — it is fine to just listen and jump in when something resonates.',
          offsetSeconds: 55
        }
      ],
      chatMessages: [
        { text: 'Great to be back!', userIndex: 1, offsetSeconds: 68 },
        { text: 'First time here — excited to join', userIndex: 2, offsetSeconds: 75 }
      ],
      participantDms: []
    },
    metadata: {
      goalId: 'private_transcript_hook',
      templateName: 'casualCommunityEvent',
      notes: 'Sparse introductory content, slow pace. Density condition should not pass. Expected output: NO_INTERVENTION.'
    }
  }
]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Dataset: ${datasetName}`)
  console.log(`Examples to seed: ${examples.length}`)
  if (dryRun) console.log('(dry run — no writes)')
  console.log()

  if (dryRun) {
    for (const ex of examples) {
      console.log(`  [${ex.metadata.goalId} / ${ex.metadata.templateName}] ${ex.name}`)
    }
    return
  }

  const client = new Client()

  let dataset: Awaited<ReturnType<typeof client.readDataset>>
  try {
    dataset = await client.readDataset({ datasetName })
    console.log(`Found existing dataset: ${dataset.id}`)
  } catch {
    dataset = await client.createDataset(datasetName, {
      description: 'LLM-as-judge evaluation scenarios for private DM check-ins across event templates'
    })
    console.log(`Created dataset: ${dataset.id}`)
  }

  const existing = new Set<string>()
  for await (const ex of client.listExamples({ datasetId: dataset.id })) {
    if (ex.metadata?.name) existing.add(ex.metadata.name as string)
  }

  let added = 0
  let skipped = 0

  for (const ex of examples) {
    if (existing.has(ex.name)) {
      console.log(`  skip (exists): ${ex.name}`)
      skipped++
      continue
    }

    await client.createExample({
      dataset_id: dataset.id,
      inputs: ex.inputs,
      outputs: {},
      metadata: { ...ex.metadata, name: ex.name }
    })
    console.log(`  added: ${ex.name}`)
    added++
  }

  console.log(`\nDone. Added: ${added}, Skipped: ${skipped}`)
  console.log(`\nView dataset: https://smith.langchain.com/datasets/${dataset.id}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
