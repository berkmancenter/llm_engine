/* eslint-disable no-undef */
/* eslint-disable no-console */
import http from 'k6/http'
import exec from 'k6/execution'
import { WebSocket } from 'k6/websockets'
import { Counter, Trend } from 'k6/metrics'

// ============================================================================
// This simulates the "everyone joins the event at once" pattern: a burst of
// participants opening a websocket connection and joining a conversation's
// room(s) within a few seconds of each other, then holding the connection
// open (like a real client would) to receive whatever transcriptLoad.js and
// eventAssistantLoad.js broadcast into that conversation for the rest of the
// simulated talk. Run this as a THIRD parallel k6 process alongside those
// two - it doesn't send transcript chunks or chat messages itself, it only
// measures how connecting and receiving broadcasts behaves under load
// (i.e. whether the autoscaler/LB keep up with the stampede, and whether
// connections survive scale-out/scale-in events during the session).
//
// This talks raw Engine.IO v4 / Socket.IO v4 framing over k6's stable
// k6/websockets module - there's no Socket.IO client for k6, so the
// handshake and event framing are hand-rolled below. See
// src/websockets/handlers/conversationHandlers.ts and src/websockets/utils.ts
// for the server side of this protocol (room naming, the conversation:join
// event shape, and the per-event JWT check in the `socket.use` middleware).
// ============================================================================

// Overridable via -e so smaller-scale runs (e.g. the 150/300-connection
// tiers in docs/autoscaling-completion-checklist.md) don't require editing
// this file - defaults match the original 1,000-connection stampede.
const NUM_CONVERSATIONS = __ENV.NUM_CONVERSATIONS ? parseInt(__ENV.NUM_CONVERSATIONS, 10) : 20
// 50 participants/conversation matches eventAssistantLoad.js's "realistic
// max" tier (1000 total) - but ramped there over 5+ minutes. Here they all
// arrive in one burst, which is the actual scenario under test.
const PARTICIPANTS_PER_CONVERSATION = __ENV.PARTICIPANTS_PER_CONVERSATION
  ? parseInt(__ENV.PARTICIPANTS_PER_CONVERSATION, 10)
  : 50

// Roughly the transcript talk's length (see TRANSCRIPT_CHUNKS.length * 6s in
// transcriptLoad.js) plus a buffer so sockets stay open for the full run.
const SESSION_DURATION_SEC = __ENV.SESSION_DURATION_SEC ? parseInt(__ENV.SESSION_DURATION_SEC, 10) : 16 * 60

const wsConnectDuration = new Trend('ws_connect_duration', true)
const wsJoinDuration = new Trend('ws_join_duration', true)
const wsMessageLatency = new Trend('ws_message_latency', true)
const wsConnectErrors = new Counter('ws_connect_errors')
const wsUnexpectedCloses = new Counter('ws_unexpected_closes')
const wsMessagesReceived = new Counter('ws_messages_received')

export const options = {
  scenarios: {
    connection_stampede: {
      executor: 'per-vu-iterations',
      // per-vu-iterations preallocates every VU before the run starts and
      // fires them together, which is the closest k6 executor to a real
      // "everyone connects within a few seconds" stampede (ramping-vus
      // instead spreads the ramp out over a configured duration).
      vus: NUM_CONVERSATIONS * PARTICIPANTS_PER_CONVERSATION,
      iterations: 1,
      maxDuration: `${SESSION_DURATION_SEC + 120}s`,
      exec: 'joinAndListen'
    }
  },
  thresholds: {
    ws_connect_errors: ['count<50'], // <5% of 1000
    ws_unexpected_closes: ['count<50'],
    ws_connect_duration: ['p(95)<3000']
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function websocketUrl(apiBase) {
  // Behind the GCLB, /socket.io/* path-routes to the same 443 as the API
  // (lb.tf), so deriving ws(s):// from API_BASE is correct there. Locally
  // there's no LB - the app binds the websocket sticky-dispatcher on its own
  // port (WEBSOCKET_BASE_PORT, default 5555; see src/websockets/index.ts),
  // separate from the API's PORT (3000). Override via WEBSOCKET_BASE for
  // local runs, e.g. -e WEBSOCKET_BASE=ws://localhost:5555.
  if (__ENV.WEBSOCKET_BASE) {
    return `${__ENV.WEBSOCKET_BASE.replace(/\/$/, '')}/socket.io/?EIO=4&transport=websocket`
  }
  const wsBase = apiBase.replace(/^http/, 'ws').replace(/\/v1\/?$/, '')
  return `${wsBase}/socket.io/?EIO=4&transport=websocket`
}

// ============================================================================
// SETUP - Runs once at start. Assumes transcriptLoad.js's setup() has
// already created NUM_CONVERSATIONS conversations for USERNAME/PASSWORD -
// same assumption eventAssistantLoad.js makes.
// ============================================================================

export function setup() {
  const pseudonymResponse = http.get(`${__ENV.API_BASE}/auth/newPseudonym`)
  const { token } = pseudonymResponse.json()

  const authResponse = http.post(
    `${__ENV.API_BASE}/auth/login`,
    JSON.stringify({
      username: __ENV.USERNAME,
      password: __ENV.PASSWORD
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    }
  )
  const { tokens } = authResponse.json()
  const accessToken = tokens.access.token

  const resp = http.get(`${__ENV.API_BASE}/conversations/userConversations`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    }
  })
  const userConvos = resp.json()

  const conversations = []
  for (let i = 0; i < NUM_CONVERSATIONS; i++) {
    conversations.push(userConvos[i].id)
  }

  console.log(`\n=== Websocket Stampede Configuration ===`)
  console.log(`API Base: ${__ENV.API_BASE}`)
  console.log(`Conversations: ${conversations.length}`)
  console.log(`Participants/conversation: ${PARTICIPANTS_PER_CONVERSATION}`)
  console.log(`Total simultaneous connections: ${conversations.length * PARTICIPANTS_PER_CONVERSATION}`)
  console.log(`=========================================\n`)

  return { conversations, accessToken }
}

// ============================================================================
// SCENARIO
// ============================================================================

export function joinAndListen(data) {
  const { conversations, accessToken } = data
  const vuIndex = exec.vu.idInInstance - 1
  const conversationId = conversations[vuIndex % conversations.length]

  const url = websocketUrl(__ENV.API_BASE)
  const connectStart = Date.now()

  let engineOpened = false
  let joined = false
  let closedByUs = false

  const ws = new WebSocket(url)

  ws.addEventListener('message', (msg) => {
    const raw = msg.data

    // Engine.IO ping - server pings, client must pong or it disconnects us
    // after pingTimeout (see the open packet's payload for the interval).
    if (raw === '2') {
      ws.send('3')
      return
    }

    // Engine.IO "open" packet - handshake to the transport itself is done;
    // now open the Socket.IO connection on top of it.
    if (!engineOpened && raw[0] === '0') {
      engineOpened = true
      wsConnectDuration.add(Date.now() - connectStart)
      ws.send('40')
      return
    }

    // Socket.IO "connected to default namespace" ack - now join the
    // conversation's room(s). See conversationHandlers.ts's joinConversation:
    // it expects {conversationId, channels, token} and the socket.use
    // middleware jwt.verify()s args.token on every emitted event, not just
    // at handshake.
    if (!joined && raw.indexOf('40') === 0) {
      joined = true
      wsJoinDuration.add(Date.now() - connectStart)
      const joinPayload = JSON.stringify([
        'conversation:join',
        {
          conversationId,
          channels: [{ name: 'transcript' }],
          token: accessToken
        }
      ])
      ws.send(`42${joinPayload}`)
      return
    }

    // Socket.IO EVENT packet - a broadcast (message:new, transcript:status,
    // poll:new, etc.) or the join's ack, if one gets sent with an id.
    if (raw.indexOf('42') === 0) {
      wsMessagesReceived.add(1)
      try {
        const [, eventData] = JSON.parse(raw.slice(2))
        if (eventData && eventData.createdAt) {
          wsMessageLatency.add(Date.now() - new Date(eventData.createdAt).getTime())
        }
      } catch (err) {
        console.error(`[VU ${vuIndex}] Failed to parse event payload: ${raw}`)
      }
    }
  })

  ws.addEventListener('open', () => {
    console.log(`[VU ${vuIndex}] Socket opened for conversation ${conversationId}`)
  })

  ws.addEventListener('error', (err) => {
    wsConnectErrors.add(1)
    console.error(`[VU ${vuIndex}] Socket error: ${JSON.stringify(err)}`)
  })

  ws.addEventListener('close', () => {
    if (!closedByUs) {
      wsUnexpectedCloses.add(1)
      console.error(`[VU ${vuIndex}] Socket closed unexpectedly (conversation ${conversationId})`)
    }
  })

  // Hold the connection open for the session, then close it ourselves - k6's
  // websockets module keeps the iteration alive until the socket closes and
  // any pending timers fire, so this is what makes the VU "hold" the
  // connection for the duration instead of ending the iteration immediately.
  setTimeout(() => {
    closedByUs = true
    ws.close()
  }, SESSION_DURATION_SEC * 1000)
}

// ============================================================================
// SUMMARY
// ============================================================================

export function handleSummary(data) {
  console.log('\n=== Websocket Stampede Analysis ===')

  const connectDuration = data.metrics.ws_connect_duration
  if (connectDuration) {
    console.log(`\nConnect Time (transport handshake):`)
    console.log(`  Avg: ${connectDuration.values.avg.toFixed(2)}ms`)
    console.log(`  P95: ${connectDuration.values['p(95)'].toFixed(2)}ms`)
    console.log(`  Max: ${connectDuration.values.max.toFixed(2)}ms`)
  }

  const joinDuration = data.metrics.ws_join_duration
  if (joinDuration) {
    console.log(`\nJoin Time (through Socket.IO namespace connect):`)
    console.log(`  Avg: ${joinDuration.values.avg.toFixed(2)}ms`)
    console.log(`  P95: ${joinDuration.values['p(95)'].toFixed(2)}ms`)
  }

  const messageLatency = data.metrics.ws_message_latency
  if (messageLatency) {
    console.log(`\nBroadcast Fan-out Latency (server createdAt -> client receipt):`)
    console.log(`  Avg: ${messageLatency.values.avg.toFixed(2)}ms`)
    console.log(`  P95: ${messageLatency.values['p(95)'].toFixed(2)}ms`)
    console.log(`  Max: ${messageLatency.values.max.toFixed(2)}ms`)
    console.log(`  (Assumes test runner and server clocks are reasonably in sync.)`)
  }

  if (data.metrics.ws_connect_errors) {
    console.log(`\nConnect Errors: ${data.metrics.ws_connect_errors.values.count}`)
  }
  if (data.metrics.ws_unexpected_closes) {
    console.log(`Unexpected Closes: ${data.metrics.ws_unexpected_closes.values.count}`)
    console.log(`  (A spike here during a scale-out/scale-in event points at the`)
    console.log(`  websocket backend service's missing session_affinity - see lb.tf.)`)
  }
  if (data.metrics.ws_messages_received) {
    console.log(`Messages Received: ${data.metrics.ws_messages_received.values.count}`)
  }

  return {
    stdout: '',
    'websocketSummary.json': JSON.stringify(data, null, 2)
  }
}
