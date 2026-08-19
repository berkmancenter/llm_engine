# LLM Engine Load Testing

This load test uses `k6` to simulate concurrent 15 minute conversations in which a variable number of users interact with the Event Assistant while a speaker delivers a talk. It uses the same API endpoints that Recall uses to send data to our system from Zoom, in order to emulate Zoom meetings.

## These tests cost real money — pick the smallest one that answers your question

Two of the three scripts drive live LLM inference, and against a deployed environment that
is billed provider spend, not just CPU. Measured on the 2026-08-19 preview run:

| Script | Requests | LLM inference | Notes |
| --- | --- | --- | --- |
| `eventAssistantLoad.js` | 3,486 chat requests | **Yes — the bulk of the cost** | every question ramps an agent response chain |
| `transcriptLoad.js` | 3,023 transcript posts | **Yes** | transcript chunks drive periodic/proactive agents |
| `websocketStampede.js` | 1,000 connections | **No — effectively zero** | only Engine.IO frames (`3` pong, `40`, `42 conversation:join`); it never posts a message |

So the cost is roughly proportional to how much of the trio you run, and the websocket
stampede is nearly free. Before reaching for all three, ask what you are actually trying to
learn:

- **Connection establishment, sticky routing, autoscaler reaction, scale-out latency** —
  run `websocketStampede.js` alone. It exercises the `concurrent_connections` metric the
  autoscaler scales on and costs essentially nothing in inference. It does need
  conversations to already exist, so either reuse a previous run's test user or run
  `transcriptLoad.js` once to create the fixtures.
- **Agent response quality, chat latency, end-to-end behaviour under load** — you need the
  full trio, and you should expect to pay for it. Run it deliberately, not as a smoke test.

Other levers when you do need the expensive scripts: shorten the run (most scale-out
behaviour resolves in the first ~5 minutes, though a 2026-08-19 run saw a burst of
connection closes at ~10 minutes), lower `NUM_CONVERSATIONS` (inference scales with
conversations and agents, not with websocket count), or point the target environment at a
cheaper model — the last of which invalidates latency comparisons against earlier runs, so
note it in the results if you do.

## Getting started

### Install k6

https://grafana.com/docs/k6/latest/set-up/install-k6/

#### Mac

brew install k6

#### Debian/Ubuntu

```
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

### Select an empty database

It is important to run this in a clean environment (new Mongo database), because the second participant simulation script will attempt to use any conversations created by the test user. It has no way of determining which conversations were created by the most recent run. Set the database name in your `.env` file before running these tests.

If you interrupt your tests, or the tests fail, or you want to re-run them, drop/delete your database before restarting your test run.

### Ensure the llm_engine server is running

Confirm your desired llm_engine instance is running, starting it if necessary. Also start chroma with `yarn chroma:up` in a separate tab if needed.

### Preparing to run the tests

NOTE! Each of the two tests scripts below takes approximately 15 mins to run. Do you have enough time?

### Running the tests

The load test consists of two separate scripts that have to be run together (unfortunately, combining scenarios into a single test produces non-sequential VU indexes, which makes it impossible to ensure one dedicated speaker per conversation for sending the transcript).

Follow the instructions below to first run the script that simulates speakers. Wait about ten seconds and then start the second script that emulates participants.

#### Simulating a speaker

This script emulates a speaker giving an approximately 15 minute talk in a specified number of concurrent conversations. A single dedicated user in each conversation sends transcript chunks and then pauses for (default) six seconds to roughly emulate human speech.

This script should start first, at least ten seconds before you run the script to emulate users chatting with the Event Assistant. Be sure to update the `NUM_CONVERSATIONS` constant to the number of conversations you want to simulate. This should be the same for all scripts below.

The script first creates a new user, a new topic, and the specified number of conversations. It then starts the transcript feed. Pass any USERNAME and PASSWORD you wish (password must contain at least one number), but again, these should be the same across all scripts. The API_BASE should point to the server you are testing.

`RECALL_REALTIME_SECRET` must be the target server's actual `RECALL_REALTIME_SECRET` value (a `whsec_...` string - see `src/handlers/recall.ts`'s `verifyRequestFromRecall` and `src/config/config.ts`'s `recall.realtimeSecret`), not an arbitrary token: every request is HMAC-signed with it and the server rejects anything that doesn't verify. For a local server this is whatever's in your `.env`; for a deployed environment it's in the `app_env_secret_id` Secret Manager secret.

```sh
k6 run -e API_BASE=http://localhost:3000/v1 -e RECALL_REALTIME_SECRET=whsec_... -e USERNAME=loadtest -e PASSWORD=loadtestload1 transcriptLoad.js
```

#### Simulating participants chatting with the Event Assistant

One you are sure the transcript script has created the necessary conversations, run this script in parallel to do a ramping load test of users interacting with the Event Assistant across the specified number of conversations. Ensure that the `NUM_CONVERSATIONS` variable matches what is set in the transcript script.

By default, this test will run for 15 minutes (roughly the duration of the transcript) and ramp up to 1000 total users across 20 conversations (50 users per conversation). The test randomly chooses from a generic question bank (questions that can be answered at any point in the talk).

Each user sends a question and then waits 1-3 minutes to simulate natural pacing. This wait period can be configured by changing the `MIN_TIME_BETWEEN_MESSAGES` and `MAX_TIME_BETWEEN_MESSAGES` values (in seconds).

```sh
k6 run -e API_BASE=http://localhost:3000/v1 -e RECALL_REALTIME_SECRET=whsec_... -e USERNAME=loadtest -e PASSWORD=loadtestload1 --out json=results.json eventAssistantLoad.js
```

#### Simulating the websocket connection stampede

The two scripts above only exercise the HTTP webhook path - they never open a real websocket connection, so they can't tell you anything about connection-establishment behavior or broadcast fan-out latency under load, which matter most for autoscaling since that's what actually drives the `concurrent_connections` custom metric the autoscaler scales on (see `infra/modules/webserver-mig/autoscaler.tf`).

`websocketStampede.js` opens `NUM_CONVERSATIONS * PARTICIPANTS_PER_CONVERSATION` real Socket.IO connections nearly simultaneously (a stampede, not a ramp), joins each into its conversation's rooms, and holds them open for the rest of the simulated talk, listening for broadcasts. Run it as a third parallel process, after the transcript script has created conversations:

```sh
k6 run -e API_BASE=http://localhost:3000/v1 -e USERNAME=loadtest -e PASSWORD=loadtestload1 websocketStampede.js
```

It doesn't need `RECALL_REALTIME_SECRET` (it never posts to the webhook endpoint) but does need a valid access token, which it gets itself via login - see its `setup()`.

Against a **local** server, also pass `-e WEBSOCKET_BASE=ws://localhost:5555` (or whatever `WEBSOCKET_BASE_PORT` is in your `.env`, default 5555) - locally there's no load balancer doing path-based routing, so the websocket sticky-dispatcher's own port has to be addressed directly (see `src/websockets/index.ts`). Against a deployed environment, omit `WEBSOCKET_BASE` entirely - the GCLB puts `/socket.io/*` on the same host/443 as the API, so the script derives it from `API_BASE` automatically.

Notes:

- This is most useful run against a real deployed (e.g. staging) environment, not localhost - the whole point is observing whether the MIG autoscaler reacts to the connection stampede fast enough (60s cooldown) and whether the load balancer keeps connections stable while it does. Correlate the `ws_unexpected_closes` / `ws_connect_errors` metrics against GCP Monitoring's instance count, CPU, and `custom.googleapis.com/app/concurrent_connections` series for the same time window.
- The websocket backend service (`google_compute_backend_service.websocket` in `lb.tf`) currently has no `session_affinity` set. If you see a spike in `ws_unexpected_closes` once the MIG has more than one healthy instance, this is the likely cause - Socket.IO's handshake does several HTTP requests before upgrading, and without sticky routing they can land on different instances mid-handshake.
- It hand-rolls the Engine.IO/Socket.IO v4 wire protocol directly over `k6/websockets` (there's no Socket.IO client for k6) - see the comments in the script if the server-side protocol details (room naming, the `conversation:join` payload shape, the per-event JWT check) ever change.

### Analyzing the results

Summary results will be printed to the console and available in `transcriptSummary.json`, `summary.json`, and `websocketSummary.json` files. The `eventAssistantLoad` time-series results are saved to `results.json' (as specified in the run command).

Run the following script to analyze time series data to determine if/when performance degraded over time:

```sh
node analyzeTimeline.js results.json
```
