/* eslint-disable no-console */

/**
 * Seed the qa-behavior LangSmith dataset with Q&A scenarios that exercise
 * each qaBehavior dimension across multiple event templates.
 *
 * The same question is often paired across two templates whose policy differs on
 * the dimension under test — e.g. the same ambiguous question in classroomLecture
 * (clarifyWhenAmbiguous=true) and casualCommunityEvent (clarifyWhenAmbiguous=false).
 * This cross-template pairing makes policy differences visible in the experiment view.
 *
 * Usage:
 *   yarn evaluate:qa-behavior:seed
 *   yarn evaluate:qa-behavior:seed --dataset=my-dataset
 *   yarn evaluate:qa-behavior:seed --dry-run
 */

import { Client } from 'langsmith'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const datasetName = args.find((a) => a.startsWith('--dataset='))?.split('=')[1] || 'qa-behavior'

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

interface TranscriptMessage {
  text: string
  speaker: string
  offsetSeconds: number
}

interface ChatMessage {
  text: string
  userIndex: number
  offsetSeconds: number
}

interface Scenario {
  description: string
  /** The question the participant sends as a private DM to the agent. */
  userQuestion: string
  /** qaBehavior dimension this scenario is designed to test. */
  dimension: string
  endTimeSeconds: number
  eventName?: string
  eventDescription?: string
  presenters?: { name: string; bio: string }[]
  transcriptMessages?: TranscriptMessage[]
  chatMessages?: ChatMessage[]
}

interface Example {
  name: string
  inputs: Scenario
  metadata: {
    templateName: string
    dimension: string
    notes?: string
  }
}

// ---------------------------------------------------------------------------
// Shared event fixtures
// ---------------------------------------------------------------------------

const AI_LECTURE_EVENT = {
  eventName: 'Introduction to Machine Learning',
  eventDescription: 'A gentle introduction to machine learning concepts for students with no prior technical background.',
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
      text: "Today we have covered supervised learning, loss functions, and the basics of gradient descent. Next session we'll look at overfitting.",
      offsetSeconds: 270
    }
  ] as TranscriptMessage[]
}

const AI_ETHICS_TALK_EVENT = {
  eventName: 'Fairness and Accountability in AI Systems',
  eventDescription:
    'Academic talk on the ethical challenges of deploying machine learning in high-stakes domains such as hiring, lending, and criminal justice.',
  presenters: [{ name: 'Prof. Amara Diallo', bio: 'Research professor in AI ethics and algorithmic accountability.' }],
  transcriptMessages: [
    {
      speaker: 'Prof. Diallo',
      text: 'Algorithmic fairness is not a single criterion — there are at least a dozen mathematically incompatible definitions, and you cannot satisfy all of them at once.',
      offsetSeconds: 40
    },
    {
      speaker: 'Prof. Diallo',
      text: 'Disparate impact is one of the oldest legal doctrines applied to automated decision-making — it asks whether a neutral policy disproportionately harms a protected group.',
      offsetSeconds: 120
    },
    {
      speaker: 'Prof. Diallo',
      text: 'The EU AI Act takes a risk-based approach: the higher the stakes, the stricter the requirements for transparency and human oversight.',
      offsetSeconds: 210
    }
  ] as TranscriptMessage[]
}

const COMPANY_ALLHANDS_EVENT = {
  eventName: 'Q3 All-Hands: Flexible Work Policy Update',
  eventDescription:
    'Company-wide all-hands meeting to present the updated flexible work policy, answer employee questions, and discuss implementation timelines.',
  presenters: [
    { name: 'Priya Sharma', bio: 'VP of People Operations.' },
    { name: 'Marcus Webb', bio: 'Chief Operating Officer.' }
  ],
  transcriptMessages: [
    {
      speaker: 'Priya Sharma',
      text: "Starting next quarter, employees can choose any three days in the office each week — Monday through Friday, no prescribed days. We're calling it Flex3.",
      offsetSeconds: 45
    },
    {
      speaker: 'Marcus Webb',
      text: 'Teams will still need to align on at least one shared in-person day per week for collaboration. Each department head will set that anchor day by the end of the month.',
      offsetSeconds: 120
    },
    {
      speaker: 'Priya Sharma',
      text: 'Home-office stipends increase from $50 to $100 per month. That takes effect on the first of next quarter and applies to all full-time employees.',
      offsetSeconds: 200
    }
  ] as TranscriptMessage[]
}

const TECH_MEETUP_EVENT = {
  eventName: 'AI Tools for Everyday Life',
  eventDescription:
    'A casual community meetup exploring how people are using AI assistants, image generators, and writing tools in their daily routines.',
  presenters: [{ name: 'Jamie Loughran', bio: 'Independent tech blogger and AI tools enthusiast.' }],
  transcriptMessages: [
    {
      speaker: 'Jamie Loughran',
      text: "I've been using AI writing assistants for everything from drafting emails to brainstorming birthday party themes — it's become part of my daily workflow.",
      offsetSeconds: 30
    },
    {
      speaker: 'Jamie Loughran',
      text: 'The image generators have come a long way. Last month I used one to design my whole living room — just described what I wanted and iterated from there.',
      offsetSeconds: 100
    },
    {
      speaker: 'Jamie Loughran',
      text: 'My main tip: be specific in your prompts. The more context you give, the better the output. Vague prompts get vague results.',
      offsetSeconds: 180
    }
  ] as TranscriptMessage[]
}

const AI_PANEL_EVENT = {
  eventName: 'Regulating AI: Who Decides and How?',
  eventDescription:
    'Public panel discussion featuring researchers, policymakers, and industry voices debating approaches to AI governance and regulation.',
  presenters: [
    { name: 'Dr. Lena Fischer', bio: 'AI policy researcher, European Digital Rights Institute.' },
    { name: 'Ravi Menon', bio: 'Director of AI strategy at a large technology company.' },
    { name: 'Congresswoman Adriana Vaz', bio: 'Member of the House Science and Technology Committee.' }
  ],
  transcriptMessages: [
    {
      speaker: 'Dr. Fischer',
      text: 'The EU AI Act is the most comprehensive regulatory framework to date, but it was drafted before large language models became mainstream — there are real gaps.',
      offsetSeconds: 60
    },
    {
      speaker: 'Ravi Menon',
      text: "Industry self-regulation has a poor track record on privacy. I don't think we should assume it will work better for AI safety.",
      offsetSeconds: 140
    },
    {
      speaker: 'Congresswoman Vaz',
      text: 'We are working on a bipartisan bill that would require algorithmic impact assessments for any AI system used in federal contracting.',
      offsetSeconds: 220
    }
  ] as TranscriptMessage[]
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

const examples: Example[] = [
  // ── responseLength ─────────────────────────────────────────────────────────
  // Same question, two templates: companyMeeting (short) vs classroomLecture (medium).

  {
    name: 'responseLength — companyMeeting (short) — What is the Flex3 policy?',
    inputs: {
      ...COMPANY_ALLHANDS_EVENT,
      description:
        'Employee sends a direct DM asking for a quick summary of the Flex3 policy. companyMeeting configures responseLength=short — the agent should answer in one or two sentences.',
      userQuestion: 'Can you give me a quick summary of the new Flex3 policy?',
      dimension: 'responseLength',
      endTimeSeconds: 260
    },
    metadata: {
      templateName: 'companyMeeting',
      dimension: 'responseLength',
      notes: 'responseLength=short — expect 1–2 sentence answer'
    }
  },

  {
    name: 'responseLength — classroomLecture (medium) — What is gradient descent?',
    inputs: {
      ...AI_LECTURE_EVENT,
      description:
        'Student DMs to ask what gradient descent is. classroomLecture configures responseLength=medium — the agent should give a focused paragraph, not a single sentence and not an essay.',
      userQuestion: 'Can you explain what gradient descent is in your own words?',
      dimension: 'responseLength',
      endTimeSeconds: 310
    },
    metadata: {
      templateName: 'classroomLecture',
      dimension: 'responseLength',
      notes: 'responseLength=medium — expect focused paragraph, not terse or exhaustive'
    }
  },

  // ── answerScope ────────────────────────────────────────────────────────────
  // Same kind of question, templates differ on how far the agent may stray.

  {
    name: 'answerScope — companyContextOnly — question about general ML concepts',
    inputs: {
      ...COMPANY_ALLHANDS_EVENT,
      description:
        'Employee DMs asking how machine learning works in general. companyMeeting configures answerScope=companyContextOnly — the agent should redirect or decline to explain general ML, staying within company context.',
      userQuestion: 'How does machine learning actually work? Is it anything like what the company is using?',
      dimension: 'answerScope',
      endTimeSeconds: 260
    },
    metadata: {
      templateName: 'companyMeeting',
      dimension: 'answerScope',
      notes: 'answerScope=companyContextOnly — should not explain general ML; redirect to company context'
    }
  },

  {
    name: 'answerScope — broaderSubjectArea — same ML question in academic context',
    inputs: {
      ...AI_ETHICS_TALK_EVENT,
      description:
        'Attendee DMs asking how machine learning works generally. publicAcademicLecture configures answerScope=broaderSubjectArea — the agent may go beyond the specific talk into the broader field.',
      userQuestion: 'How does machine learning actually work? I want to understand it at a high level.',
      dimension: 'answerScope',
      endTimeSeconds: 260
    },
    metadata: {
      templateName: 'publicAcademicLecture',
      dimension: 'answerScope',
      notes: 'answerScope=broaderSubjectArea — may go beyond the talk into general ML explanation'
    }
  },

  {
    name: 'answerScope — helpUserUnderstandTheLecture — question that tempts going off-topic',
    inputs: {
      ...AI_LECTURE_EVENT,
      description:
        'Student DMs asking about recent AI news. classroomLecture configures answerScope=helpUserUnderstandTheLecture — the agent should bring the answer back to the lecture material rather than discussing recent news broadly.',
      userQuestion: 'I keep hearing about AI in the news. Is any of that related to what we covered today?',
      dimension: 'answerScope',
      endTimeSeconds: 310
    },
    metadata: {
      templateName: 'classroomLecture',
      dimension: 'answerScope',
      notes:
        'answerScope=helpUserUnderstandTheLecture — connect news to lecture content; do not drift into general AI news discussion'
    }
  },

  {
    name: 'answerScope — open — off-topic question at casual meetup',
    inputs: {
      ...TECH_MEETUP_EVENT,
      description:
        'Attendee DMs with a question that goes well beyond the meetup topic. casualCommunityEvent configures answerScope=open — the agent may help with any reasonable question.',
      userQuestion:
        "This might be off-topic, but I'm trying to learn Python for data analysis. Any advice on where to start?",
      dimension: 'answerScope',
      endTimeSeconds: 230
    },
    metadata: {
      templateName: 'casualCommunityEvent',
      dimension: 'answerScope',
      notes: 'answerScope=open — agent may engage with any topic the user raises'
    }
  },

  // ── clarifyWhenAmbiguous ───────────────────────────────────────────────────
  // Same ambiguous question, two templates: classroomLecture (clarify=true)
  // vs casualCommunityEvent (clarify=false).

  {
    name: 'clarifyWhenAmbiguous — classroomLecture (true) — vague "explain that" DM',
    inputs: {
      ...AI_LECTURE_EVENT,
      description:
        'Student sends a vague DM referencing "that thing" without specifying what. classroomLecture configures clarifyWhenAmbiguous=true — the agent should ask which concept the student means rather than guessing.',
      userQuestion: 'I got a bit lost with that last thing you explained. Can you go over it again?',
      dimension: 'clarifyWhenAmbiguous',
      endTimeSeconds: 310
    },
    metadata: {
      templateName: 'classroomLecture',
      dimension: 'clarifyWhenAmbiguous',
      notes: 'clarifyWhenAmbiguous=true — ambiguous "that last thing"; agent should ask for clarification'
    }
  },

  {
    name: 'clarifyWhenAmbiguous — casualCommunityEvent (false) — same vague question',
    inputs: {
      ...TECH_MEETUP_EVENT,
      description:
        'Attendee sends the same vague DM. casualCommunityEvent configures clarifyWhenAmbiguous=false — the agent should make a reasonable interpretation and answer rather than asking for clarification.',
      userQuestion: 'I got a bit lost with that last thing. Can you explain it again?',
      dimension: 'clarifyWhenAmbiguous',
      endTimeSeconds: 230
    },
    metadata: {
      templateName: 'casualCommunityEvent',
      dimension: 'clarifyWhenAmbiguous',
      notes: 'clarifyWhenAmbiguous=false — agent should attempt an answer, not ask for clarification'
    }
  },

  // ── addContextWhenUseful ───────────────────────────────────────────────────
  // Same question from a likely novice, two templates: classroomLecture
  // (addContext=true) vs companyMeeting (addContext=false).

  {
    name: 'addContextWhenUseful — classroomLecture (true) — novice asking about loss functions',
    inputs: {
      ...AI_LECTURE_EVENT,
      description:
        'Student with no ML background DMs asking what a loss function is. classroomLecture configures addContextWhenUseful=true — the agent should add an analogy or scaffolding to help the concept land, not just a bare definition.',
      userQuestion: "What's a loss function? I've never heard that term before.",
      dimension: 'addContextWhenUseful',
      endTimeSeconds: 310
    },
    metadata: {
      templateName: 'classroomLecture',
      dimension: 'addContextWhenUseful',
      notes: 'addContextWhenUseful=true — novice audience; add analogy or scaffolding alongside the definition'
    }
  },

  {
    name: 'addContextWhenUseful — companyMeeting (false) — employee asking about home-office stipend',
    inputs: {
      ...COMPANY_ALLHANDS_EVENT,
      description:
        'Employee DMs asking when the home-office stipend increase takes effect. companyMeeting configures addContextWhenUseful=false — the agent should answer directly from the presentation without adding unsolicited context about why the policy changed or how stipends work generally.',
      userQuestion: 'When does the new home-office stipend amount take effect?',
      dimension: 'addContextWhenUseful',
      endTimeSeconds: 260
    },
    metadata: {
      templateName: 'companyMeeting',
      dimension: 'addContextWhenUseful',
      notes: 'addContextWhenUseful=false — answer directly; do not pad with unsolicited background'
    }
  },

  // ── allowFollowUpDialogue ──────────────────────────────────────────────────
  // Same question, two templates: publicPanelDiscussion (followUp=true)
  // vs companyMeeting (followUp=false).

  {
    name: 'allowFollowUpDialogue — publicPanelDiscussion (true) — takeaways question',
    inputs: {
      ...AI_PANEL_EVENT,
      description:
        'Attendee DMs asking for the key takeaways from the panel. publicPanelDiscussion configures allowFollowUpDialogue=true — the agent should invite further dialogue at the close of the response.',
      userQuestion: "What would you say are the two or three most important takeaways from today's panel?",
      dimension: 'allowFollowUpDialogue',
      endTimeSeconds: 280
    },
    metadata: {
      templateName: 'publicPanelDiscussion',
      dimension: 'allowFollowUpDialogue',
      notes: 'allowFollowUpDialogue=true — response should close with a genuine invitation to continue the conversation'
    }
  },

  {
    name: 'allowFollowUpDialogue — companyMeeting (false) — same takeaways question',
    inputs: {
      ...COMPANY_ALLHANDS_EVENT,
      description:
        'Employee DMs asking for the key takeaways from the all-hands. companyMeeting configures allowFollowUpDialogue=false — the agent should give a clean, closed answer with no invitation to follow up.',
      userQuestion: 'What are the main takeaways from today?',
      dimension: 'allowFollowUpDialogue',
      endTimeSeconds: 260
    },
    metadata: {
      templateName: 'companyMeeting',
      dimension: 'allowFollowUpDialogue',
      notes: 'allowFollowUpDialogue=false — close response cleanly; do not invite further dialogue'
    }
  }
]

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

async function seed() {
  console.log(`Dataset: ${datasetName}`)
  if (dryRun) console.log('Dry-run mode — no writes.')
  console.log(`Seeding ${examples.length} example(s)…\n`)

  if (dryRun) {
    for (const ex of examples) {
      console.log(`[dry-run] ${ex.name}`)
      console.log(`  template: ${ex.metadata.templateName}  dimension: ${ex.metadata.dimension}`)
      console.log(`  question: ${ex.inputs.userQuestion}`)
    }
    return
  }

  const client = new Client()

  let dataset
  try {
    dataset = await client.readDataset({ datasetName })
    console.log(`Found existing dataset: ${dataset.id}`)
  } catch {
    dataset = await client.createDataset(datasetName, {
      description: 'Behavior policy Q&A evaluation: tests qaBehavior dimensions across event templates'
    })
    console.log(`Created dataset: ${dataset.id}`)
  }

  const existingExamples: string[] = []
  for await (const ex of client.listExamples({ datasetId: dataset.id })) {
    if (ex.metadata?.name) existingExamples.push(ex.metadata.name as string)
  }

  let created = 0
  let skipped = 0

  for (const example of examples) {
    if (existingExamples.includes(example.name)) {
      console.log(`  skip  ${example.name}`)
      skipped++
      continue
    }

    await client.createExample(
      example.inputs as unknown as Record<string, unknown>,
      {},
      {
        datasetId: dataset.id,
        metadata: { ...example.metadata, name: example.name }
      }
    )
    console.log(`  added ${example.name}`)
    created++
  }

  console.log(`\nDone. Created: ${created}  Skipped: ${skipped}`)
}

seed().catch((err) => {
  console.error(err)
  process.exit(1)
})
