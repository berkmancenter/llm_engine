/* eslint-disable no-undef */
/* eslint-disable no-console */
import http from 'k6/http'
import exec from 'k6/execution'
import { WebSocket } from 'k6/websockets'
import { Counter, Trend } from 'k6/metrics'

// ============================================================================
// docs/autoscaling-completion-checklist.md (llm_engine-infra), open question 1:
// "Does a broadcast reach clients on other instances?" This is the purpose-built
// fixture the checklist calls for - load-test leftovers are unusable because
// their adapters are inactive and their agent replies live in per-participant
// direct channels.
//
// It never touches an LLM. The broadcast trigger is a poll creation
// (POST /polls -> poll.service's createPoll -> websocketGateway.broadcastNewPoll),
// a plain DB write with no agent/Recall path - see src/services/poll.service/index.ts.
// The alternative (posting a transcript chunk) drives periodic/proactive agents
// and costs real inference; this doesn't.
//
// Clients join the *bare* conversation room only (channels: [] in the
// conversation:join payload) - joinConversation always joins that room
// regardless of requested channels (see conversationHandlers.ts), and
// broadcastNewPoll broadcasts to exactly that room with no channel filter.
//
// Run against a target with max_replicas >= 2 so there's a second instance to
// cross. Correlate against GCP Monitoring's per-instance
// custom.googleapis.com/app/concurrent_connections to confirm clients actually
// landed on both instances - this script can't see which instance a socket is
// on, only whether the broadcast reached it.
// ============================================================================

const NUM_CLIENTS = __ENV.NUM_CLIENTS ? parseInt(__ENV.NUM_CLIENTS, 10) : 60
// How long clients hold the connection open after joining, listening for the
// broadcast, before closing themselves.
const HOLD_SECONDS = __ENV.HOLD_SECONDS ? parseInt(__ENV.HOLD_SECONDS, 10) : 90
// How long after the run starts to fire the poll - must be well after all
// clients have connected and joined. 1,000 connections completed handshake
// within ~14s in the 2026-08-19 run; this is far fewer.
const TRIGGER_DELAY_SEC = __ENV.TRIGGER_DELAY_SEC ? parseInt(__ENV.TRIGGER_DELAY_SEC, 10) : 20

const wsConnectDuration = new Trend('ws_connect_duration', true)
const wsJoinDuration = new Trend('ws_join_duration', true)
const wsConnectErrors = new Counter('ws_connect_errors')
const wsUnexpectedCloses = new Counter('ws_unexpected_closes')
const pollBroadcastReceived = new Counter('poll_broadcast_received')
const pollBroadcastLatency = new Trend('poll_broadcast_latency', true)
const pollCreateErrors = new Counter('poll_create_errors')

export const options = {
  scenarios: {
    join_clients: {
      executor: 'per-vu-iterations',
      vus: NUM_CLIENTS,
      iterations: 1,
      maxDuration: `${HOLD_SECONDS + 60}s`,
      exec: 'joinAndListen'
    },
    trigger_broadcast: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      startTime: `${TRIGGER_DELAY_SEC}s`,
      maxDuration: '30s',
      exec: 'triggerBroadcast'
    }
  }
}

function websocketUrl(apiBase) {
  if (__ENV.WEBSOCKET_BASE) {
    return `${__ENV.WEBSOCKET_BASE.replace(/\/$/, '')}/socket.io/?EIO=4&transport=websocket`
  }
  const wsBase = apiBase.replace(/^http/, 'ws').replace(/\/v1\/?$/, '')
  return `${wsBase}/socket.io/?EIO=4&transport=websocket`
}

// ============================================================================
// SETUP - creates one fresh topic + conversation. No adapters/agentTypes -
// these don't need a Zoom/Recall integration or agent processing, only a
// websocket-joinable room (see also websocketStampede.js's setup(), which
// assumes conversations already exist; this one makes its own so it isn't
// exposed to leftover fixtures from other runs).
// ============================================================================

export function setup() {
  const pseudonymResponse = http.get(`${__ENV.API_BASE}/auth/newPseudonym`)
  const { token, pseudonym } = pseudonymResponse.json()

  let accessToken
  const registerResponse = http.post(`${__ENV.API_BASE}/auth/register`, {
    token,
    pseudonym,
    username: __ENV.USERNAME,
    password: __ENV.PASSWORD
  })
  if (registerResponse.status === 201) {
    accessToken = registerResponse.json().tokens.access.token
  } else {
    const loginResponse = http.post(
      `${__ENV.API_BASE}/auth/login`,
      JSON.stringify({ username: __ENV.USERNAME, password: __ENV.PASSWORD }),
      { headers: { 'Content-Type': 'application/json' } }
    )
    accessToken = loginResponse.json().tokens.access.token
  }

  const topicResponse = http.post(
    `${__ENV.API_BASE}/topics`,
    JSON.stringify({
      name: 'Cross-instance Broadcast Probe',
      votingAllowed: true,
      conversationCreationAllowed: true,
      private: false,
      archivable: true
    }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } }
  )
  if (topicResponse.status !== 201) {
    throw new Error(`Failed to create topic: ${topicResponse.status} ${topicResponse.body}`)
  }
  const topicId = topicResponse.json().id

  const conversationResponse = http.post(
    `${__ENV.API_BASE}/conversations`,
    JSON.stringify({
      name: `Cross-instance broadcast probe ${Date.now()}`,
      topicId,
      channels: [{ name: 'transcript' }]
    }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } }
  )
  if (conversationResponse.status !== 201) {
    throw new Error(`Failed to create conversation: ${conversationResponse.status} ${conversationResponse.body}`)
  }
  const conversationId = conversationResponse.json().id

  console.log(`\n=== Cross-instance Broadcast Probe ===`)
  console.log(`API Base: ${__ENV.API_BASE}`)
  console.log(`Conversation: ${conversationId}`)
  console.log(`Clients: ${NUM_CLIENTS}`)
  console.log(`Trigger delay: ${TRIGGER_DELAY_SEC}s, hold: ${HOLD_SECONDS}s`)
  console.log(`=======================================\n`)

  return { conversationId, accessToken }
}

// ============================================================================
// join_clients scenario
// ============================================================================

export function joinAndListen(data) {
  const { conversationId } = data
  const vuIndex = exec.vu.idInInstance - 1

  const url = websocketUrl(__ENV.API_BASE)
  const connectStart = Date.now()

  let engineOpened = false
  let joined = false
  let closedByUs = false

  const ws = new WebSocket(url)

  ws.addEventListener('message', (msg) => {
    const raw = msg.data

    if (raw === '2') {
      ws.send('3')
      return
    }

    if (!engineOpened && raw[0] === '0') {
      engineOpened = true
      wsConnectDuration.add(Date.now() - connectStart)
      ws.send('40')
      return
    }

    if (!joined && raw.indexOf('40') === 0) {
      joined = true
      wsJoinDuration.add(Date.now() - connectStart)
      // channels: [] - we only need the bare conversation room, which
      // joinConversation always joins regardless of requested channels.
      const joinPayload = JSON.stringify([
        'conversation:join',
        { conversationId, channels: [], token: data.accessToken }
      ])
      ws.send(`42${joinPayload}`)
      return
    }

    if (raw.indexOf('42') === 0) {
      try {
        const [eventName, eventData] = JSON.parse(raw.slice(2))
        if (eventName === 'poll:new') {
          pollBroadcastReceived.add(1)
          if (eventData && eventData.createdAt) {
            pollBroadcastLatency.add(Date.now() - new Date(eventData.createdAt).getTime())
          }
          console.log(`[VU ${vuIndex}] Received poll:new`)
        }
      } catch (err) {
        console.error(`[VU ${vuIndex}] Failed to parse event payload: ${raw}`)
      }
    }
  })

  ws.addEventListener('error', (err) => {
    wsConnectErrors.add(1)
    console.error(`[VU ${vuIndex}] Socket error: ${JSON.stringify(err)}`)
  })

  ws.addEventListener('close', () => {
    if (!closedByUs) {
      wsUnexpectedCloses.add(1)
      console.error(`[VU ${vuIndex}] Socket closed unexpectedly`)
    }
  })

  setTimeout(() => {
    closedByUs = true
    ws.close()
  }, HOLD_SECONDS * 1000)
}

// ============================================================================
// trigger_broadcast scenario - fires once, after clients should have joined
// ============================================================================

export function triggerBroadcast(data) {
  const { conversationId, accessToken } = data
  const resp = http.post(
    `${__ENV.API_BASE}/polls`,
    JSON.stringify({
      conversationId,
      title: `Cross-instance broadcast trigger ${Date.now()}`
    }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } }
  )
  console.log(`[trigger] poll create status: ${resp.status}`)
  if (resp.status !== 201) {
    pollCreateErrors.add(1)
    console.error(`[trigger] Failed to create poll: ${resp.status} ${resp.body}`)
  }
}

// ============================================================================
// SUMMARY
// ============================================================================

export function handleSummary(data) {
  console.log('\n=== Cross-instance Broadcast Analysis ===')
  const joined = data.metrics.ws_join_duration ? data.metrics.ws_join_duration.values.count : 0
  const received = data.metrics.poll_broadcast_received ? data.metrics.poll_broadcast_received.values.count : 0
  console.log(`Clients joined: ${joined}`)
  console.log(`Clients that received poll:new: ${received}`)
  console.log(
    received < joined
      ? `MISSED ${joined - received} client(s) - broadcast did not reach every joined client.`
      : `All joined clients received the broadcast.`
  )
  const latency = data.metrics.poll_broadcast_latency
  if (latency) {
    console.log(`Broadcast latency - avg: ${latency.values.avg.toFixed(1)}ms, p95: ${latency.values['p(95)'].toFixed(1)}ms`)
  }
  return {
    stdout: JSON.stringify(data, null, 2),
    'crossInstanceBroadcastSummary.json': JSON.stringify(data, null, 2)
  }
}
