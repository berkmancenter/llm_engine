/* eslint-disable no-undef */
/* eslint-disable no-console */
import http from 'k6/http'
import { check, sleep } from 'k6'
import exec from 'k6/execution'

import { Trend } from 'k6/metrics'

const transcriptDuration = new Trend('transcript_duration')

const NUM_CONVERSATIONS = 25

// this must be set to loadtest so that server will bypass sending agent messages to Recall
const BOT_ID = 'loadtest'

// ============================================================================
// TRANSCRIPT SIMULATION DATA
// ============================================================================

/** This is a transcript of the TedX Talk, 'The Hidden Physics of Life' by Nikta Fakhri, available at https://www.youtube.com/watch?v=AZ1Nyl7VCzU */
const TRANSCRIPT_CHUNKS = [
  'Imagine a crisp fall evening.',
  'The sky a canvas of amber and violet.',
  'Suddenly thousands of starlings appear,',
  'performing a breathtaking aerial ballet called a murmuration.',
  "It's a stunning natural phenomenon",
  'that holds the secret to the very essence of life.',
  'I am a physicist',
  'and I see something profound in the flight of these starlings—',
  'fundamental principles that govern not just these birds but all of life,',
  'from the tiniest cells to the vastest ecosystems.',
  'So where do we go from here?',
  'Let me take you on a journey',
  'to discover the physics of non-equilibrium systems like these starlings,',
  'that can account for the phenomena of life.',
  'To understand the world around us,',
  'we need to grasp two fundamental concepts: equilibrium and non-equilibrium.',
  "Let's start with equilibrium—a state of balance and stability.",
  'To illustrate this, consider a simple bar magnet.',
  'If we could zoom in,',
  'we would see countless tiny domains,',
  'each like a compass needle.',
  'In ordinary iron, these point randomly.',
  'But when we apply an external magnetic field,',
  'something remarkable happens:',
  'the domains begin to align.',
  'This alignment process is an example of what we call symmetry breaking in physics.',
  'Initially there is no preferred direction—this is a symmetry.',
  'When we apply a magnetic field, the symmetry breaks,',
  'and the system chooses a direction by aligning the domains.',
  'Once aligned, these domains reach equilibrium:',
  'stable, predictable, unchanging.',
  'If we were to film these domains',
  'and play the movie backward, it would look almost identical.',
  'Time loses its direction—this is a hallmark of equilibrium.',
  'But this state is not where life thrives.',
  'In fact, equilibrium is the antithesis of life.',
  'Life in all its messy, complex, beautiful glory exists far from equilibrium.',
  'Now, with this understanding,',
  "let's shift our focus to where life truly thrives—far from equilibrium,",
  'and return to our starlings.',
  'Each bird in this aerial ballet acts like a flying compass needle.',
  'Just as the alignment of magnetic domains leads to a macroscopic magnetic field,',
  'these birds align their velocities with neighbors.',
  'But unlike magnets, this alignment is ever-changing,',
  'responding moment by moment to surrounding birds.',
  'The result is a mesmerizing display of collective behavior',
  'that seems to defy explanation.',
  'Some people see a serpent,',
  'others a billowing cloud,',
  'or even a pulsing heart.',
  'The flock moves as one',
  'yet is composed of thousands of independent decision-makers.',
  'It’s a living system',
  'that never settles into the quiet equilibrium of a magnet—',
  'constantly moving, consuming energy to sustain its dance.',
  'This perpetual motion,',
  'this ceaseless energy use, is what we mean by non-equilibrium.',
  'And here’s where it gets fascinating:',
  'it is in this state of non-equilibrium that we find the seeds of life’s beauty and complexity.',
  'In non-equilibrium systems like a starling flock,',
  'symmetry breaking isn’t a one-time event—',
  'it’s an ongoing process driven by the continuous flow of energy and matter.',
  'We see cascades of symmetry breaking.',
  'Each break creates new possibilities, new patterns, new structures—',
  'like a never-ending game of dominoes.',
  'This continuous symmetry breaking allows for the incredible diversity and adaptability of life.',
  'It’s why living systems can respond, evolve, and create complex structures.',
  'Let’s combine these ideas—non-equilibrium and symmetry breaking—',
  'and revisit our murmuration.',
  'The starling murmuration is a perfect example of emergence in a non-equilibrium system.',
  'Just as aligned magnetic domains produce a macroscopic field,',
  'coordinated starlings create the flock’s complex, fluid-like behavior.',
  'In the magnet, emergence leads to stable equilibrium.',
  'In the flock, emergence is dynamic and ongoing.',
  'The flock’s behavior continuously emerges from the interactions of individuals',
  'and, in turn, guides them—',
  'creating a feedback loop that maintains the system far from equilibrium.',
  'This dynamic emergence is a hallmark of living systems.',
  'It’s the same principle that allows a collection of cells',
  'to become a thinking, feeling human being',
  'or a group of humans to form complex societies.',
  'In every case, the behavior of the whole both emerges from',
  'and guides the behavior of its parts.',
  'We’ve seen non-equilibrium on the grand scale of murmurations,',
  'but it also exists at the microscopic scale.',
  'The same principles manifest across all levels of life.',
  'Let’s zoom in from the murmuration',
  'to something smaller yet no less wondrous—a single living cell.',
  'Within this microscopic world, a drama unfolds',
  'that mirrors the same dance we see in the sky.',
  'In my lab, using advanced microscopes,',
  'we can watch proteins—the building blocks of life—',
  'organize into waves and spirals across dividing cells.',
  'Just as each starling responds to its neighbors,',
  'these proteins interact to create patterns that guide development.',
  'What’s remarkable is that the same principles of non-equilibrium physics describe these biological processes.',
  'We’ve discovered that these protein spirals behave like charged particles,',
  'with their cores acting as positive or negative charges depending on rotation.',
  'Just as electric charges form fields,',
  'these protein activity centers orchestrate development across the entire cell.',
  'Watching these protein patterns dance,',
  'we witness another symmetry that life breaks—the symmetry of time itself.',
  'Remember our bar magnet: in equilibrium, time loses direction.',
  'Played backward or forward, it looks the same.',
  'But in living systems, time has an arrow—a clear, irreversible direction.',
  'Think of a murmuration played in reverse;',
  'it would look wrong, unnatural.',
  'Every wingbeat, every cell division, every heartbeat is a step forward in time that cannot be undone.',
  'We can even show mathematically that this arrow of time is related to the flow of energy in living systems.',
  'Time’s direction arises from energy dissipation—',
  'from how far from equilibrium a system is.',
  'We can quantify this with entropy, a thermodynamic measure of disorder.',
  'Living systems constantly exchange energy and matter with their environment.',
  'Higher energy flow means higher entropy production and more irreversible processes.',
  'Our experiments confirm this link between energy flow, entropy, and irreversibility.',
  'This irreversibility shapes how we perceive time.',
  'And what’s truly remarkable is that living systems create order and complexity',
  'while still increasing the universe’s overall entropy.',
  'So what?',
  'How does this change how we see the world?',
  'When we embrace this dynamic view of life,',
  'we start asking new questions and exploring new possibilities.',
  'Can we use non-equilibrium physics to design smarter, more adaptable materials?',
  'Could studying energy flows in ecosystems help us find more sustainable ways to produce and use energy?',
  'If life is truly a phenomenon of non-equilibrium physics,',
  'should we search for life’s origins in places where energy flows create potential for complexity?',
  'By thinking this way, we open ourselves to discovering new forms of life—',
  'or lifelike processes—we haven’t yet imagined.',
  'And the most amazing part?',
  'We don’t have to look far to see these processes in action.',
  'Our planet is full of diversity that arises from these same fundamental dynamics.',
  'Take a coral reef, for example:',
  'a delicate balance where countless species find their place within the flow of energy and matter.',
  'Or think of the human brain,',
  'where billions of neurons fire in coordinated patterns to create consciousness.',
  'Even our societies, with their complex economic and social structures,',
  'can be understood through the lens of non-equilibrium physics.',
  'As our journey ends, let’s return once more to our starlings, now seen through new eyes.',
  'As the last light fades, they bring their ballet to a graceful close, settling into their roosts.',
  'Through them, we see how energy drives matter to self-organize,',
  'how broken symmetries create diversity,',
  'and how time’s arrow arises from life’s processes.',
  'I’ll never forget the moment in my lab, watching protein patterns ripple across a dividing cell,',
  'energy flowing and conducting this ballet through time.',
  'That moment changed my perspective.',
  'I realized that life isn’t about reaching equilibrium—',
  'it’s about maintaining this dance far from it.',
  'In this constant flux, this journey of becoming,',
  'lies the true wonder of existence—a dance we’re all part of, every moment.',
  'Thank you.'
]

// Time between transcript chunks in seconds (simulates natural speech pacing)
const TRANSCRIPT_CHUNK_DELAY = 6

// ============================================================================
// TEST SCENARIO
// ============================================================================
export const options = {
  scenarios: {
    transcript_simulation: {
      executor: 'per-vu-iterations',
      vus: NUM_CONVERSATIONS,
      iterations: 1,
      maxDuration: '30m',
      exec: 'sendTranscript'
    }
  },
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    http_req_failed: ['rate<0.05']
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function createTranscriptWebhook(username, message) {
  return {
    event: 'transcript.data',
    data: {
      bot: {
        id: BOT_ID
      },
      data: {
        participant: {
          name: username,
          id: `${username}-${Date.now()}`
        },
        words: [
          {
            text: message,
            end_timestamp: { absolute: new Date().toISOString() }
          }
        ]
      }
    }
  }
}

function createTopic(token) {
  const topicResponse = http.post(
    `${__ENV.API_BASE}/topics`,
    JSON.stringify({
      name: 'Load Test Topic',
      votingAllowed: true,
      conversationCreationAllowed: true,
      private: false,
      archivable: true
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    }
  )
  if (topicResponse.status !== 201) {
    throw new Error(`Failed to create topic: ${topicResponse.status} ${topicResponse.body}`)
  }
  const topicId = topicResponse.json().id
  console.log(`Created topic ID: ${topicId}`)
  return topicId
}

function createConversation(token, topicId, index) {
  const conversationPayload = {
    name: 'Where are all the aliens?',
    topicId,
    agentTypes: [
      {
        name: 'eventAssistant'
      }
    ],
    channels: [
      {
        name: 'transcript'
      }
    ],
    enableDMs: ['agents'],
    adapters: [
      {
        type: 'zoom',
        config: {
          meetingUrl: `http://fakezoom.com/loadtest-${Date.now()}-${index}-${Math.random().toString(36).substring(7)}`, // this has to be unique
          botName: 'Load Tester',
          botId: BOT_ID
        },
        dmChannels: [
          {
            direct: true,
            agent: 'eventAssistant',
            direction: 'both'
          }
        ],
        audioChannels: [
          {
            name: 'transcript'
          }
        ]
      }
    ]
  }
  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  }

  const url = `${__ENV.API_BASE}/conversations`
  const resp = http.post(url, JSON.stringify(conversationPayload), params)
  if (resp.status !== 201) {
    throw new Error(`Failed to create conversation: ${resp.status} ${resp.body}`)
  }
  console.log(`Created conversation ID: ${resp.json().id}`)
  return resp.json().id
}

export function sendTranscript(conversations) {
  const vuIndex = exec.vu.idInInstance - 1

  const conversationId = conversations[vuIndex]
  const speakerName = `Speaker-${conversationId}`

  console.log(`[TRANSCRIPT] Starting for user ${vuIndex} and conversation ${conversationId}`)

  for (let i = 0; i < TRANSCRIPT_CHUNKS.length; i++) {
    const chunk = TRANSCRIPT_CHUNKS[i]
    const webhookPayload = createTranscriptWebhook(speakerName, chunk)

    const params = {
      headers: {
        'Content-Type': 'application/json'
      },
      tags: { conversation_id: conversationId }
    }

    const url = `${__ENV.API_BASE}/webhooks/recall?token=${__ENV.RECALL_WEBHOOK_TOKEN}&conversationId=${conversationId}`

    const startTime = Date.now()
    const res = http.post(url, JSON.stringify(webhookPayload), params)
    const duration = Date.now() - startTime

    // Record transcript-specific metrics
    transcriptDuration.add(duration)

    check(res, {
      'transcript status is 200': (r) => r.status === 200,
      'transcript response is ok': (r) => r.body === 'ok',
      'transcript under 1s': (r) => r.timings.duration < 1000
    })

    if (res.status !== 200) {
      console.error(`[TRANSCRIPT] Chunk ${i + 1} failed: ${res.status}`)
    }

    if (i < TRANSCRIPT_CHUNKS.length - 1) {
      sleep(TRANSCRIPT_CHUNK_DELAY)
    }
  }

  console.log(`[TRANSCRIPT] Completed for conversation ${conversationId}`)
}

// ============================================================================
// SETUP - Runs once at start
// ============================================================================

export function setup() {
  // Get new pseudonym for session
  const pseudonymResponse = http.get(`${__ENV.API_BASE}/auth/newPseudonym`)

  const { token, pseudonym } = pseudonymResponse.json()

  // Register pseudonym with token from above request
  const registerResponse = http.post(`${__ENV.API_BASE}/auth/register`, {
    token,
    pseudonym,
    username: __ENV.USERNAME,
    password: __ENV.PASSWORD
  })

  const { tokens } = registerResponse.json()
  const topicId = createTopic(tokens.access.token)

  const conversations = []
  for (let i = 0; i < NUM_CONVERSATIONS; i++) {
    const conversationId = createConversation(tokens.access.token, topicId, i)
    conversations.push(conversationId)
  }
  console.log(`\n=== Load Test Configuration ===`)
  console.log(`API Base: ${__ENV.API_BASE}`)
  console.log(`Number of Conversations: ${conversations.length}`)
  console.log(`Conversation IDs: ${conversations.join(', ')}`)
  console.log(`================================\n`)
  return conversations
}

// ============================================================================
// CUSTOM METRICS & SUMMARY
// ============================================================================

// Enhanced summary with degradation analysis
export function handleSummary(data) {
  console.log('\n=== Performance Analysis ===')
  console.log(`\nTotal Duration: ${(data.state.testRunDurationMs / 1000 / 60).toFixed(2)} minutes`)
  console.log(`Total Requests: ${data.metrics.http_reqs.values.count}`)
  console.log(
    `Failed Requests: ${data.metrics.http_req_failed.values.passes} (${(
      data.metrics.http_req_failed.values.rate * 100
    ).toFixed(2)}%)`
  )

  // Overall performance
  const duration = data.metrics.http_req_duration
  console.log(`\nResponse Times:`)
  console.log(`  Avg: ${duration.values.avg.toFixed(2)}ms`)
  console.log(`  Med: ${duration.values.med.toFixed(2)}ms`)
  console.log(`  P90: ${duration.values['p(90)'].toFixed(2)}ms`)
  console.log(`  P95: ${duration.values['p(95)'].toFixed(2)}ms`)
  console.log(`  P99: ${duration.values['p(99)'] ? duration.values['p(99)'].toFixed(2) : 'N/A'}ms`)
  console.log(`  Max: ${duration.values.max.toFixed(2)}ms`)

  // Check breakdown
  const { checks } = data.metrics
  console.log(`\nCheck Success Rate: ${(checks.values.rate * 100).toFixed(2)}%`)

  // VU information
  console.log(`\nVirtual Users:`)
  console.log(`  Max VUs: ${data.metrics.vus_max.values.value}`)

  const failRate = data.metrics.http_req_failed.values.rate
  const p95 = duration.values['p(95)']

  if (failRate > 0.05) {
    console.log(`⚠️  Failure rate (${(failRate * 100).toFixed(2)}%) exceeds 5% threshold`)
  }
  if (p95 > 5000) {
    console.log(`⚠️  P95 response time (${p95.toFixed(2)}ms) exceeds 5000ms threshold`)
  }

  return {
    stdout: '', // Don't print full summary to console
    'transcriptSummary.json': JSON.stringify(data, null, 2)
  }
}
