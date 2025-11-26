/* eslint-disable no-undef */
/* eslint-disable no-console */
import http from 'k6/http'
import { check, sleep } from 'k6'
import exec from 'k6/execution'

import { Trend, Counter } from 'k6/metrics'

const userMessageDuration = new Trend('user_message_duration')
const timeoutCounter = new Counter('timeout_errors')
const serverErrorCounter = new Counter('server_errors')

// Per-conversation metrics
const conversationMessageCount = new Counter('conversation_message_count')
const conversationErrorCount = new Counter('conversation_error_count')

// 20 users per meeting in max 500 scenario
const NUM_CONVERSATIONS = 25

// this must be set to loadtest so that server will bypass sending agent messages to Recall
const BOT_ID = 'loadtest'

const QUESTIONS = [
  'Can you summarize the last 5 minutes?',
  'What did they just say?',
  'What is this event about?',
  'What topics have been covered so far?',
  'Can you explain the last point in more detail?',
  'I stepped out for am minute, what did I miss?'
]

const MIN_TIME_BETWEEN_MESSAGES = 60

const MAX_TIME_BETWEEN_MESSAGES = 180

// ============================================================================
// TEST SCENARIOS
// ============================================================================
export const options = {
  scenarios: {
    ramp_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      startTime: '10s',
      stages: [
        { duration: '1m', target: 150 }, // 6 users/conv (light)
        { duration: '2m', target: 150 },

        { duration: '1m', target: 250 }, // 10 users/conv (realistic)
        { duration: '2m', target: 250 },

        { duration: '1m', target: 375 }, // 15 users/conv (realistic)
        { duration: '2m', target: 375 },

        { duration: '1m', target: 500 }, // 20 users/conv (realistic max)
        { duration: '2m', target: 500 },

        { duration: '30s', target: 0 }
      ],
      exec: 'sendUserMessage'
    }
  },
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    http_req_failed: ['rate<0.05'],
    // Add thresholds for custom metrics
    user_message_duration: ['p(95)<5000', 'p(99)<10000'],
    timeout_errors: ['count<50'],
    server_errors: ['count<50']
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function createChatMessageWebhook(username, message) {
  return {
    event: 'participant_events.chat_message',
    data: {
      bot: {
        id: BOT_ID
      },
      data: {
        participant: {
          name: username,
          id: `${username}-${Date.now()}`
        },
        data: {
          text: message,
          timestamp: new Date().toISOString(),
          to: 'only_bot'
        }
      }
    }
  }
}

function getRandomElement(array) {
  return array[Math.floor(Math.random() * array.length)]
}

export function sendUserMessage(conversations) {
  // Round robin user assignment to conversation - user always sends in the same convo
  const vuIndex = exec.vu.idInInstance - 1
  const conversationId = conversations[vuIndex % conversations.length]
  console.log(`Sending message vuIndex: ${vuIndex} and conversationId ${conversationId}`)
  const username = `user${vuIndex}`
  const question = getRandomElement(QUESTIONS)
  const webhookPayload = createChatMessageWebhook(username, question)

  const params = {
    headers: {
      'Content-Type': 'application/json'
    },
    tags: {
      conversation_id: conversationId,
      current_vus: __VU // Track VUs per request
    }
  }

  const url = `${__ENV.API_BASE}/webhooks/recall?token=${__ENV.RECALL_WEBHOOK_TOKEN}&conversationId=${conversationId}`

  const startTime = Date.now()
  const res = http.post(url, JSON.stringify(webhookPayload), params)
  const duration = Date.now() - startTime

  // Record custom metrics
  userMessageDuration.add(duration)
  conversationMessageCount.add(1, { conversation: conversationId })

  // Track specific error types
  if (res.status === 0 || res.timings.duration > 60000) {
    timeoutCounter.add(1)
    conversationErrorCount.add(1, { conversation: conversationId })
  }
  if (res.status >= 500) {
    serverErrorCounter.add(1)
    conversationErrorCount.add(1, { conversation: conversationId })
  }

  const checkResult = check(res, {
    'status is 200': (r) => r.status === 200,
    'response is ok': (r) => r.body === 'ok',
    'response under 5s': (r) => r.timings.duration < 5000,
    'response under 10s': (r) => r.timings.duration < 10000,
    'response under 30s': (r) => r.timings.duration < 30000
  })

  if (!checkResult) {
    console.error(`[VU:${__VU}] Failed - Status: ${res.status}, Duration: ${duration}ms, User: ${username}`)
  }

  sleep(MIN_TIME_BETWEEN_MESSAGES + Math.random() * MAX_TIME_BETWEEN_MESSAGES)
}

// ============================================================================
// SETUP - Runs once at start
// ============================================================================

export function setup() {
  // Get new pseudonym for session
  const pseudonymResponse = http.get(`${__ENV.API_BASE}/auth/newPseudonym`)

  const { token } = pseudonymResponse.json()

  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  }

  const authResponse = http.post(
    `${__ENV.API_BASE}/auth/login`,
    JSON.stringify({
      username: __ENV.USERNAME,
      password: __ENV.PASSWORD
    }),
    params
  )
  const { tokens } = authResponse.json()

  const url = `${__ENV.API_BASE}/conversations/userConversations`
  const resp = http.get(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.access.token}`
    }
  })

  const userConvos = resp.json()

  const conversations = []
  for (let i = 0; i < NUM_CONVERSATIONS; i++) {
    const conversationId = userConvos[i].id
    conversations.push(conversationId)
  }
  console.log(`\n=== Load Test Configuration ===`)
  console.log(`API Base: ${__ENV.API_BASE}`)
  console.log(`Number of Conversations: ${conversations.length}`)
  console.log(`Conversation IDs: ${conversations.join(', ')}`)
  console.log(`Question Pool: ${QUESTIONS.length}`)
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

  // Custom metrics
  if (data.metrics.user_message_duration) {
    console.log(`\nUser Message Performance:`)
    console.log(`  P95: ${data.metrics.user_message_duration.values['p(95)'].toFixed(2)}ms`)
    console.log(
      `  P99: ${
        data.metrics.user_message_duration.values['p(99)']
          ? data.metrics.user_message_duration.values['p(99)'].toFixed(2)
          : 'N/A'
      }ms`
    )
  }

  if (data.metrics.timeout_errors) {
    console.log(`\nError Analysis:`)
    console.log(`  Timeouts: ${data.metrics.timeout_errors.values.count}`)
  }
  if (data.metrics.server_errors) {
    console.log(`  Server Errors (5xx): ${data.metrics.server_errors.values.count}`)
  }

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
    'summary.json': JSON.stringify(data, null, 2)
  }
}
