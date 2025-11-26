# LLM Engine Load Testing

This load test uses `k6` to simulate concurrent 15 minute conversations in which a variable number of users interact with the Event Assistant while a speaker delivers a talk. It uses the same API endpoints that Recall uses to send data to our system from Zoom, in order to emulate Zoom meetings.

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

This script should start first, at least ten seconds before you run the script to emulate users chatting with the Event Assistant. Be sure to update the `NUM_CONVERSATIONS` constant to the number of conversations you want to simulate. This should be the same for both scripts.

The script first creates a new user, a new topic, and the specified number of conversations. It then starts the transcript feed. Pass any USERNAME and PASSWORD you wish (password must contain at least one number), but again, these should be the same for both scripts. The API_BASE should point to the server you are testing and the RECALL_WEBHOOK_TOKEN should match the RECALL_TOKEN defined in the server's `.env` file.

```sh
k6 run -e API_BASE=http://localhost:3000/v1 -e RECALL_WEBHOOK_TOKEN=[token] -e USERNAME=loadtest -e PASSWORD=loadtestload1 transcriptLoad.js
```

#### Simulating participants chatting with the Event Assistant

One you are sure the transcript script has created the necessary conversations, run this script in parallel to do a ramping load test of users interacting with the Event Assistant across the specified number of conversations. Ensure that the `NUM_CONVERSATIONS` variable matches what is set in the transcript script.

By default, this test will run for 15 minutes (roughly the duration of the transcript) and ramp up to 500 total users across 25 conversations (20 users per conversation). The test randomly chooses from a generic question bank (questions that can be answered at any point in the talk).

Each user sends a question and then waits 1-3 minutes to simulate natural pacing. This wait period can be configured by changing the `MIN_TIME_BETWEEN_MESSAGES` and `MAX_TIME_BETWEEN_MESSAGES` values (in seconds).

```sh
k6 run -e API_BASE=http://localhost:3000/v1 -e RECALL_WEBHOOK_TOKEN=[token] -e USERNAME=loadtest -e PASSWORD=loadtestload1 --out json=results.json eventAssistantLoad.js
```

### Analyzing the results

Summary results will be printed to the console and available in `transcriptSummary.json` and `summary.json` files. The `eventAssistantLoad` time-series results are saved to `results.json' (as specified in the run command).

Run the following script to analyze time series data to determine if/when performance degraded over time:

```sh
node analyzeTimeline.js results.json
```
