/* eslint-disable no-console */

/**
 * Seed the proactive-group-agent LangSmith dataset with starter scenarios.
 *
 * Each scenario specifies a templateName that matches the event format and
 * subject matter. Cross-template variance is visible by comparing scenarios
 * in the LangSmith experiment view.
 *
 * Usage:
 *   yarn evaluate:proactive-group-agent:seed
 *   yarn evaluate:proactive-group-agent:seed --dataset=my-dataset
 *   yarn evaluate:proactive-group-agent:seed --dry-run
 */

import { Client } from 'langsmith'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const datasetName = args.find((a) => a.startsWith('--dataset='))?.split('=')[1] || 'proactive-group-agent'

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

interface ChatMessage {
  text: string
  userIndex: number
  offsetSeconds: number
}

interface TranscriptMessage {
  text: string
  speaker: string
  offsetSeconds: number
}

interface Scenario {
  description: string
  endTimeSeconds: number
  eventName?: string
  eventDescription?: string
  presenters?: { name: string; bio: string }[]
  transcriptMessages?: TranscriptMessage[]
  chatMessages?: ChatMessage[]
  privateMessages?: ChatMessage[]
  guardrails?: string[]
  contentSensitivity?: {
    level?: 'standard' | 'elevated' | 'high'
    domains?: string[]
  }
}

interface Example {
  name: string
  inputs: Scenario
  metadata: {
    templateName: string
    notes?: string
  }
}

const examples: Example[] = [
  // ── publicAcademicLecture ──────────────────────────────────────────────────
  // Subject: AI and education — jargon-heavy, expert audience.
  // Passive moment after a terminology-dense section; two questions in chat;
  // one private message from a confused non-expert.
  // Expected: bridge_topics or surface_signal; professional/semiFormal register;
  // jargon appropriate for the expert audience template but the confusion signal
  // should not go unnoticed.
  {
    name: 'Academic lecture — passive moment after jargon-heavy section',
    inputs: {
      description:
        'A researcher presents findings on LLM integration in K-12 schools. Chat has gone quiet after a dense terminology section. Two clarifying questions are in chat; one private message signals confusion.',
      endTimeSeconds: 660,
      eventName: 'AI in the classroom: opportunity, risk, and what teachers actually need',
      eventDescription:
        'Researcher Kenji Watanabe presents findings from a two-year study on LLM integration in secondary schools.',
      presenters: [{ name: 'Kenji Watanabe', bio: 'Education technology researcher and former secondary school teacher.' }],
      transcriptMessages: [
        {
          speaker: 'Kenji Watanabe',
          text: 'What we found is that retrieval-augmented generation significantly outperformed zero-shot prompting for structured essay tasks — but the opposite was true for open-ended creative work.',
          offsetSeconds: 90
        },
        {
          speaker: 'Kenji Watanabe',
          text: 'The pedagogy question is not whether students use these tools. They already do. The question is whether we design assessments that account for that reality.',
          offsetSeconds: 240
        },
        {
          speaker: 'Kenji Watanabe',
          text: 'Teachers in our study reported that the biggest challenge was not the technology — it was not knowing what the technology was actually doing inside the model.',
          offsetSeconds: 420
        },
        {
          speaker: 'Kenji Watanabe',
          text: 'The hallucination problem is particularly acute in history and science contexts, where confident but wrong answers are harder for students to detect than in maths.',
          offsetSeconds: 570
        },
        {
          speaker: 'Kenji Watanabe',
          text: 'We need a new literacy — not just digital literacy, but what I would call epistemic literacy about AI-generated content.',
          offsetSeconds: 630
        }
      ],
      chatMessages: [
        {
          text: 'Sorry if this is a basic question — what is retrieval-augmented generation?',
          userIndex: 0,
          offsetSeconds: 640
        },
        {
          text: 'Still trying to follow — is epistemic literacy a technical term or more general?',
          userIndex: 1,
          offsetSeconds: 652
        }
      ],
      privateMessages: [
        {
          text: 'I am a teacher and I have no idea what half of these terms mean — am I the only one?',
          userIndex: 2,
          offsetSeconds: 655
        },
        {
          text: 'Lost since the RAG section. Feel like this is pitched at people who already know this stuff.',
          userIndex: 0,
          offsetSeconds: 658
        }
      ],
      contentSensitivity: {
        level: 'elevated',
        domains: ['academic integrity', 'AI-generated content in education']
      }
    },
    metadata: {
      templateName: 'publicAcademicLecture',
      notes:
        'Professional/semiFormal tone. High jargon level appropriate. clarify_confusion or surface_signal likely. Private confusion signal must not be attributed.'
    }
  },

  // ── classroomLecture ────────────────────────────────────────────────────────
  // Subject: mental health and burnout — emotionally sensitive, beginner audience.
  // Quiet moment after a personal anecdote; students not engaging.
  // Expected: warmSupportive/casual register; clarify_confusion or invite_quieter_voices;
  // gentle re-engagement without clinical jargon.
  {
    name: 'Classroom lecture — quiet after emotionally resonant moment',
    inputs: {
      description:
        'A guest psychiatrist speaks to undergraduate students about burnout. After sharing a patient anecdote, the room has gone quiet. Two students privately signal they found it personally relatable.',
      endTimeSeconds: 540,
      eventName: 'Understanding burnout: what your mind is trying to tell you',
      eventDescription:
        'Dr. Priya Anand helps students recognise early warning signs of burnout and understand the psychology behind it.',
      presenters: [{ name: 'Dr. Priya Anand', bio: 'Consultant psychiatrist specialising in occupational mental health.' }],
      transcriptMessages: [
        {
          speaker: 'Dr. Anand',
          text: 'Burnout is not a personal failing. It is a systems problem. The individual is the last line of defence in a structure that was never designed to support them.',
          offsetSeconds: 120
        },
        {
          speaker: 'Dr. Anand',
          text: 'I had a patient — a senior manager, very high performing — who told me she cried in her car every morning before going in. For two years. And nobody noticed.',
          offsetSeconds: 300
        },
        {
          speaker: 'Dr. Anand',
          text: 'When we talk about psychological safety, we are not talking about making people comfortable. We are talking about making it safe to tell the truth.',
          offsetSeconds: 450
        },
        {
          speaker: 'Dr. Anand',
          text: 'The first step is always recognition. You cannot address something you have not named.',
          offsetSeconds: 510
        }
      ],
      chatMessages: [
        { text: 'Thank you for sharing that', userIndex: 0, offsetSeconds: 520 },
        { text: 'Really powerful', userIndex: 1, offsetSeconds: 530 }
      ],
      privateMessages: [
        { text: 'This is describing my last semester exactly', userIndex: 2, offsetSeconds: 532 },
        { text: 'I did not realise what I was going through had a name', userIndex: 1, offsetSeconds: 538 }
      ]
    },
    metadata: {
      templateName: 'classroomLecture',
      notes:
        'warmSupportive/casual tone critical. Private signals are personal — surface as pattern only, no attribution. invite_quieter_voices or structure_conversation most appropriate.'
    }
  },

  // ── companyMeeting ──────────────────────────────────────────────────────────
  // Subject: return-to-office policy — internal, power-sensitive.
  // Senior voices converging publicly; junior employees concerned privately.
  // Expected: clearNeutral/semiFormal; invite_quieter_voices; strict safety posture.
  {
    name: 'Company meeting — RTO policy with suppressed junior concerns',
    inputs: {
      description:
        'All-hands on new return-to-office policy. Senior voices in chat are aligned and positive. Two junior employees privately express concerns about commute burden and childcare.',
      endTimeSeconds: 420,
      eventName: 'Q3 all-hands: office, hybrid, and what comes next',
      eventDescription: 'Leadership presents the updated return-to-office policy and answers questions from the team.',
      presenters: [{ name: 'Sarah Okafor', bio: 'Chief People Officer.' }],
      transcriptMessages: [
        {
          speaker: 'Sarah Okafor',
          text: 'After eighteen months of hybrid, we have seen that in-person collaboration drives our best work. Starting in September, we are asking teams to be in the office three days a week.',
          offsetSeconds: 60
        },
        {
          speaker: 'Sarah Okafor',
          text: 'We have invested significantly in the office environment — new collaboration spaces, better catering, and a refreshed commuter benefits programme.',
          offsetSeconds: 180
        },
        {
          speaker: 'Sarah Okafor',
          text: 'We know this is a change, and we want to support everyone through it. Your managers will follow up with individual conversations this week.',
          offsetSeconds: 300
        }
      ],
      chatMessages: [
        { text: 'The new spaces look amazing — really excited about this', userIndex: 0, offsetSeconds: 360 },
        { text: 'Great to have some clarity after all the uncertainty', userIndex: 1, offsetSeconds: 380 }
      ],
      privateMessages: [
        { text: 'Three days is going to be really hard with my childcare situation', userIndex: 2, offsetSeconds: 390 },
        { text: 'The commute costs are going to wipe out my salary increase', userIndex: 1, offsetSeconds: 408 }
      ]
    },
    metadata: {
      templateName: 'companyMeeting',
      notes:
        'clearNeutral/semiFormal. Strict safety posture. invite_quieter_voices appropriate but must be carefully worded — power dynamics real. No attribution of private messages.'
    }
  },

  // ── publicPanelDiscussion ───────────────────────────────────────────────────
  // Subject: climate policy — contested, energetic debate.
  // Public chat riding the optimistic panelist; private scepticism building.
  // Expected: warmSupportive/semiFormal; surface_signal or invite_quieter_voices;
  // moderately proactive; medium social sensitivity.
  {
    name: 'Panel discussion — public optimism masking private scepticism',
    inputs: {
      description:
        'Panel on corporate net-zero commitments. Public chat is following the most optimistic panelist. Two participants privately express scepticism about the feasibility of the timelines.',
      endTimeSeconds: 600,
      eventName: 'Net zero by 2040: ambition or delusion?',
      eventDescription: 'Three voices in climate policy debate whether corporate net-zero commitments are credible.',
      presenters: [
        { name: 'Clara Mendez', bio: 'Head of sustainability at a FTSE 100 energy company.' },
        { name: 'Dr. Tobias Ren', bio: 'Climate economist and critic of voluntary carbon markets.' },
        { name: 'Aisha Osei', bio: 'Policy director at a leading environmental NGO.' }
      ],
      transcriptMessages: [
        {
          speaker: 'Clara Mendez',
          text: 'We have committed to net zero by 2038. The roadmap is in place, the capital is allocated, and we are on track.',
          offsetSeconds: 60
        },
        {
          speaker: 'Dr. Ren',
          text: 'With respect, the accounting behind most of these commitments relies heavily on offsets that do not represent real emissions reductions.',
          offsetSeconds: 150
        },
        {
          speaker: 'Aisha Osei',
          text: 'I think what gives me hope is that we are seeing genuine behaviour change in supply chains, not just headline pledges.',
          offsetSeconds: 300
        },
        {
          speaker: 'Clara Mendez',
          text: 'The narrative that business cannot move fast enough is simply not supported by what we are seeing on the ground.',
          offsetSeconds: 420
        },
        { speaker: 'Aisha Osei', text: 'The momentum is real. I have never been more optimistic.', offsetSeconds: 510 }
      ],
      chatMessages: [
        { text: 'Great to hear such confidence from industry', userIndex: 0, offsetSeconds: 540 },
        { text: 'Finally some good news on this topic', userIndex: 1, offsetSeconds: 555 }
      ],
      privateMessages: [
        {
          text: 'The offset critique from Dr Ren is getting buried and it is the most important point in this whole discussion',
          userIndex: 2,
          offsetSeconds: 565
        },
        {
          text: 'I am not convinced these timelines are real but I do not want to be the one to say it',
          userIndex: 0,
          offsetSeconds: 580
        }
      ]
    },
    metadata: {
      templateName: 'publicPanelDiscussion',
      notes:
        'warmSupportive/semiFormal. surface_signal or invite_quieter_voices. Private scepticism must surface as pattern — no attribution. Medium social sensitivity.'
    }
  },

  // ── casualCommunityEvent ─────────────────────────────────────────────────────
  // Subject: local housing — community-driven, conversational.
  // Surprise stat lands; brief stunned pause; energy waiting to be released.
  // Expected: playful/casual; play_commentary or provoke_participation;
  // moderately proactive; personality-forward.
  {
    name: 'Community event — surprising housing stat, energy waiting to be released',
    inputs: {
      description:
        'A local councillor presents housing data at a neighbourhood forum. She just revealed that 60% of new planning applications in the area are for single-family homes, not the affordable units residents have been asking for. Stunned pause in chat.',
      endTimeSeconds: 480,
      eventName: 'Our neighbourhood in 2030: what gets built, and who decides',
      eventDescription:
        'Councillor Diane Holt and local architect Marcus Webb discuss the pipeline of planning applications and what residents can actually do about them.',
      presenters: [
        { name: 'Diane Holt', bio: 'Ward councillor with responsibility for planning and development.' },
        { name: 'Marcus Webb', bio: 'Local architect and housing advocate.' }
      ],
      transcriptMessages: [
        {
          speaker: 'Diane Holt',
          text: 'I want to be honest with you about what is actually in the pipeline, because I think people deserve to know.',
          offsetSeconds: 60
        },
        {
          speaker: 'Diane Holt',
          text: 'Of the forty-two applications currently under review, twenty-six are for detached or semi-detached homes. Six are for affordable or social housing. The rest are commercial conversions.',
          offsetSeconds: 150
        },
        {
          speaker: 'Marcus Webb',
          text: 'And this is not unusual. We have been seeing this pattern for three years. The financial incentives for developers just do not point toward affordability.',
          offsetSeconds: 270
        },
        {
          speaker: 'Diane Holt',
          text: 'What I can tell you is that resident objections do carry weight at committee stage. More than most people realise.',
          offsetSeconds: 390
        },
        {
          speaker: 'Marcus Webb',
          text: 'The window to object to the Ridgeway development closes in eleven days. I cannot stress that enough.',
          offsetSeconds: 440
        }
      ],
      chatMessages: [
        { text: 'Wait — six out of forty-two?', userIndex: 0, offsetSeconds: 455 },
        { text: 'That cannot be right', userIndex: 1, offsetSeconds: 465 }
      ],
      privateMessages: []
    },
    metadata: {
      templateName: 'casualCommunityEvent',
      notes:
        'Playful/casual tone. This is a genuine surprise moment — play_commentary or provoke_participation appropriate. Energy is high, community register expected. Not a moment for measured neutrality.'
    }
  },

  // ── companyMeeting (burnout) ────────────────────────────────────────────────
  // Same mental health topic as the classroom scenario, but corporate context.
  // Contrasts with classroomLecture scenario: should be clearNeutral/semiFormal,
  // not warmSupportive/casual. Strict safety posture applies.
  // Expected: invite_quieter_voices or structure_conversation; measured register;
  // no clinical warmth, no casual register, no attribution of private signals.
  {
    name: 'Company meeting — burnout session, clearNeutral contrast to classroom',
    inputs: {
      description:
        'An occupational health consultant presents burnout data and announces EAP improvements. Chat has one public question about the data breakdown. Three employees have privately asked practical questions about accessing the EAP discreetly — how to refer themselves, whether it is confidential from their manager, when it starts. These are aggregatable without exposure risk and the speaker has not addressed them.',
      endTimeSeconds: 390,
      eventName: 'Workplace wellbeing: what the data says and what we are doing about it',
      eventDescription: "Dr. Priya Anand presents occupational health findings and the company's updated support framework.",
      presenters: [{ name: 'Dr. Priya Anand', bio: 'Consultant in occupational health and organisational psychology.' }],
      transcriptMessages: [
        {
          speaker: 'Dr. Anand',
          text: 'Our survey data shows that 41% of employees reported feeling burned out at least once in the past six months. That is not a personal problem — it is an organisational signal.',
          offsetSeconds: 90
        },
        {
          speaker: 'Dr. Anand',
          text: 'The research is clear that presenteeism — showing up while unwell — costs organisations more than absenteeism. We tend to measure the wrong thing.',
          offsetSeconds: 210
        },
        {
          speaker: 'Dr. Anand',
          text: 'From next quarter, the EAP will include six funded sessions with a specialist, not just a helpline. And managers will receive training on early recognition.',
          offsetSeconds: 330
        }
      ],
      chatMessages: [{ text: 'Is the 41% figure broken down by team or level anywhere?', userIndex: 0, offsetSeconds: 365 }],
      privateMessages: [
        { text: 'Can I access the EAP without my manager being notified?', userIndex: 2, offsetSeconds: 355 },
        {
          text: 'Is the six-session EAP available immediately or does it start next quarter?',
          userIndex: 1,
          offsetSeconds: 362
        },
        { text: 'How do I actually refer myself — is there a form or do I go through HR?', userIndex: 0, offsetSeconds: 372 }
      ],
      contentSensitivity: {
        level: 'elevated',
        domains: ['mental health', 'personal disclosure in professional settings']
      }
    },
    metadata: {
      templateName: 'companyMeeting',
      notes:
        'clearNeutral/semiFormal register — contrast with classroom burnout scenario. Strict safety. 3 private signals are practical EAP access questions — aggregatable as "several people want to know how to access support" without exposure risk. surface_signal or invite_quieter_voices appropriate.'
    }
  },

  // ── classroomLecture (AI/education) ─────────────────────────────────────────
  // Same jargon-confusion topic as the academic lecture scenario, but for beginner
  // undergraduate students. Contrasts with publicAcademicLecture: should be
  // warmSupportive/casual/medium, not professional/semiFormal/brief.
  // Expected: clarify_confusion or invite_quieter_voices; accessible language;
  // more scaffolding and encouragement; longer response than the academic version.
  {
    name: 'Classroom lecture — AI jargon confusion, warmSupportive contrast to academic lecture',
    inputs: {
      description:
        'An introductory lecture on AI in education for undergraduate students with no technical background. After a dense terminology section, chat has gone quiet. Students are privately signalling confusion.',
      endTimeSeconds: 540,
      eventName: 'AI and learning: what students need to know',
      eventDescription:
        'An introductory session helping undergraduate students understand how AI tools work and what they mean for how they study.',
      presenters: [{ name: 'Dr. Lena Kovač', bio: 'Lecturer in digital education and learning technology.' }],
      transcriptMessages: [
        {
          speaker: 'Dr. Kovač',
          text: 'These tools use something called a transformer architecture — they predict the next word based on everything they have seen before. That is a simplification, but it is a useful one.',
          offsetSeconds: 120
        },
        {
          speaker: 'Dr. Kovač',
          text: 'When a model hallucinates, it is not lying — it does not have intent. It is generating text that looks plausible based on patterns, even when the content is wrong.',
          offsetSeconds: 270
        },
        {
          speaker: 'Dr. Kovač',
          text: 'Retrieval-augmented generation is one approach to reducing this — it anchors the model to a specific set of documents rather than relying purely on its training.',
          offsetSeconds: 420
        },
        {
          speaker: 'Dr. Kovač',
          text: 'The practical implication for you as students is: always verify. Treat these tools as a starting point, not an endpoint.',
          offsetSeconds: 500
        }
      ],
      chatMessages: [
        { text: 'I got a bit lost around the hallucination part', userIndex: 0, offsetSeconds: 515 },
        { text: 'Same — what is retrieval-augmented generation?', userIndex: 1, offsetSeconds: 525 }
      ],
      privateMessages: [
        {
          text: 'I feel like everyone else understands this and I am the only one confused',
          userIndex: 2,
          offsetSeconds: 530
        },
        { text: 'Is transformer architecture something we need to know for the exam?', userIndex: 0, offsetSeconds: 538 }
      ]
    },
    metadata: {
      templateName: 'classroomLecture',
      notes:
        'warmSupportive/casual/medium — contrast with academic lecture AI scenario (professional/semiFormal/brief). Same confusion signal, different register. clarify_confusion most appropriate. Response should be longer and more encouraging than the academic version.'
    }
  },

  // ── Cross-template: active healthy debate — NO_INTERVENTION ──────────────
  // Same scenario shape for all templates via separate examples.
  // Using publicPanelDiscussion as the representative — panels are most likely
  // to have active back-and-forth that the agent might wrongly interrupt.
  {
    name: 'Panel — active healthy debate, expect NO_INTERVENTION',
    inputs: {
      description:
        'Genuine multi-sided back-and-forth on housing policy. Participants are actively exchanging substantive messages. Agent should stay silent.',
      endTimeSeconds: 525,
      eventName: 'Net zero by 2040: ambition or delusion?',
      eventDescription: 'Three voices in climate policy debate whether corporate net-zero commitments are credible.',
      presenters: [
        { name: 'Clara Mendez', bio: 'Head of sustainability at a FTSE 100 energy company.' },
        { name: 'Dr. Tobias Ren', bio: 'Climate economist and critic of voluntary carbon markets.' }
      ],
      transcriptMessages: [
        { speaker: 'Clara Mendez', text: 'The roadmap is clear and the capital is committed.', offsetSeconds: 60 },
        { speaker: 'Dr. Ren', text: 'The offset accounting does not hold up under scrutiny.', offsetSeconds: 120 }
      ],
      chatMessages: [
        {
          text: 'I think the offset critique is fair but the timeline argument is separate',
          userIndex: 0,
          offsetSeconds: 460
        },
        { text: 'Exactly — you can accept the goal and still question the mechanism', userIndex: 1, offsetSeconds: 475 },
        { text: 'The Ren point about additionality is the one nobody wants to answer', userIndex: 2, offsetSeconds: 490 },
        {
          text: 'Because the answer is uncomfortable for the companies making the pledges',
          userIndex: 0,
          offsetSeconds: 505
        },
        { text: 'So what would a credible offset actually look like?', userIndex: 1, offsetSeconds: 518 }
      ],
      privateMessages: []
    },
    metadata: {
      templateName: 'publicPanelDiscussion',
      notes:
        'Expected output is NO_INTERVENTION. interventionAppropriateness should be 1.0 for silence, 0.0 for any intervention.'
    }
  },
  // ── casualCommunityEvent: active banter — NO_INTERVENTION ────────────────
  // Community forum with lively back-and-forth. Tests that the playful template
  // does not over-trigger — even in a casual context, active discussion should
  // produce silence.
  {
    name: 'Community event — active banter, expect NO_INTERVENTION',
    inputs: {
      description:
        'Lively neighbourhood forum. Residents are exchanging views energetically about the planning data. No facilitation needed — the group is doing it themselves.',
      endTimeSeconds: 510,
      eventName: 'Our neighbourhood in 2030: what gets built, and who decides',
      eventDescription:
        'Councillor Diane Holt and local architect Marcus Webb discuss the pipeline of planning applications and what residents can actually do about them.',
      presenters: [
        { name: 'Diane Holt', bio: 'Ward councillor with responsibility for planning and development.' },
        { name: 'Marcus Webb', bio: 'Local architect and housing advocate.' }
      ],
      transcriptMessages: [
        {
          speaker: 'Diane Holt',
          text: 'Of the forty-two applications currently under review, twenty-six are for detached or semi-detached homes.',
          offsetSeconds: 90
        },
        {
          speaker: 'Marcus Webb',
          text: 'The financial incentives just do not point toward affordability.',
          offsetSeconds: 150
        }
      ],
      chatMessages: [
        { text: 'Six affordable units out of forty-two — that is genuinely shocking', userIndex: 0, offsetSeconds: 440 },
        { text: 'I mean, we have been saying this for years. Now we have the numbers.', userIndex: 1, offsetSeconds: 452 },
        { text: 'What can we actually do before the Ridgeway deadline?', userIndex: 2, offsetSeconds: 463 },
        { text: 'There is a template objection letter on the residents association site', userIndex: 0, offsetSeconds: 474 },
        { text: 'Amazing — sharing that now', userIndex: 1, offsetSeconds: 482 },
        { text: 'Marcus said eleven days — is that calendar days or working days?', userIndex: 2, offsetSeconds: 495 }
      ],
      privateMessages: []
    },
    metadata: {
      templateName: 'casualCommunityEvent',
      notes:
        'Expected output is NO_INTERVENTION. Community is self-organising. Tests that playful/casual template does not cause the agent to over-trigger into an active discussion.'
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
      console.log(`  [${ex.metadata.templateName}] ${ex.name}`)
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
      description: 'LLM-as-judge evaluation scenarios for the Proactive Group Agent'
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
