# k6 load tests — STOP AND ASK BEFORE RUNNING ANYTHING THAT COSTS INFERENCE

**Two of the three scripts in this directory spend real money on LLM inference every time
they run.** Against a deployed environment that is billed provider spend, and a single full
run is thousands of agent invocations.

## The rule

**Never start a run that drives inference without asking the user for approval of *that
specific run*, and telling them what it will cost first.**

- Approval to "run a load test", "do the stampede test", "test autoscaling", or "go ahead"
  is **NOT** approval to spend on inference. Neither is approval of an earlier run.
- If a run fails, is invalid, or has to be repeated for any reason — **including your own
  mistake** — that is a **new** spend and needs a **new** approval. Do not silently re-run.
- Say the expected volume out loud before starting: how many chat requests, how many
  transcript posts, roughly how long. Let the user decide.
- If the user has expressed any concern about cost, treat every inference-driving run as
  blocked until they explicitly unblock that run.

## What costs what

| Script | Inference (its own traffic) | Notes |
| --- | --- | --- |
| `eventAssistantLoad.js` | **Expensive** | ~3,500 chat requests per run, each an agent/LLM chain |
| `transcriptLoad.js` | **Expensive** | ~3,000 transcript posts driving periodic/proactive agents |
| `websocketStampede.js` | **Effectively free** | only Engine.IO frames (`3` pong, `40`, `42 conversation:join`); never posts a message |

**"Effectively free" is about the traffic this script generates, not the conversations it
uses — see the auto-stop trap below.** A run that sends zero chat/transcript messages can
still bill real inference on its own, later, unattended.

## The auto-stop trap — read this before reusing conversations

Every conversation with a transcript channel arms an idle auto-stop timer the moment it
starts (`scheduleAutoStop` in `../src/services/conversation.service/lifecycle.ts`): a
15-minute grace period, then a check every 5 minutes, and it stops the conversation once its
last transcript message is ≥5 minutes old (`IDLE_TIMEOUT_MS` in
`../src/jobs/handlers/conversation.ts`). Stopping a conversation — however it's triggered —
unconditionally does two inference-costing things in `doStopConversation`: an LLM call to
summarize the event (even with zero messages), and a `conversationStopped` dispatch that, for
a public topic, runs Vibes Analyst's full LLM-backed engagement-card pipeline. Neither is
gated on why the conversation was created.

`websocketStampede.js` (and any other zero-message fixture — the cross-instance broadcast
test, a stampede at 150/300, an instance-loss drill) reuses **existing** conversations and
posts no transcript/chat traffic itself, so nothing resets that idle clock. 15–20 minutes
after the *last* transcript message those conversations ever received — possibly from a
completely different, earlier run — the timer fires on its own and pays for a summary plus a
Vibes Analyst recap. This is exactly how a "no inference" run has still shown up as real
spend: the cost isn't in the test's traffic, it's in conversations left to idle out
unattended.

**Before and during any zero-message run:**

- Don't leave reused conversations idling across a session boundary. If you're not actively
  about to run `transcriptLoad.js`/`eventAssistantLoad.js` again soon, either let the timer
  run its course intentionally (it's a fixed, known cost per pending conversation) or note
  explicitly that you're accepting it — don't assume "no inference" ports the label across
  a gap of unattended time.
- For a **deployed environment being used purely for connection/broadcast testing** (no
  interest in the real summary/recap), set `DISABLE_POST_EVENT_ANALYSIS=true` in that
  environment's config. It skips both inference-costing steps in `doStopConversation`
  without touching agent/adapter teardown, scheduling, or anything else stop normally does —
  see the flag's description in `../src/config/config.ts`. This is a standing environment
  setting, not a per-run toggle; only enable it somewhere real events never happen.

## Pick the cheapest experiment that answers the question

Most infrastructure questions do **not** need the expensive scripts:

- Connection establishment, sticky routing, autoscaler reaction, scale-out timing,
  boot-to-healthy, baked images → **`websocketStampede.js` alone**. Free of its own inference
  — but see the auto-stop trap above before assuming that's the whole cost picture. It still
  needs conversations to exist, so reuse a previous run's test user rather than recreating
  fixtures.
- Agent behaviour, chat latency, end-to-end quality under load → needs the expensive
  scripts. Ask first, every time.

Other levers when the expensive scripts genuinely are required: shorten the run, lower
`NUM_CONVERSATIONS` (inference scales with conversations and agents, not with websocket
count), or point the environment at a cheaper model (note it in the results — it
invalidates latency comparisons against earlier runs).

## Why this file exists

On 2026-08-19 the user raised concerns about LLM expense. The agreed plan was
stampede-only runs, which are free. Two subsequent full three-script runs were then started
anyway — the second to repeat the first after a harness mistake (the load-generator VM had
no external IP, so Cloud NAT throttled it to 56 of 1,000 connections) — without putting the
cost decision back in front of the user. That was roughly 7,000 chat requests and 6,000
transcript posts of avoidable spend, on a project whose billing budget alert is currently
disabled, so nothing would have flagged it.

The failure was not misunderstanding the cost. The cost was already measured and documented
in `README.md` at the time. The failure was treating approval of an *experiment* as
approval of its *spend*. Ask separately.

**2026-08-20 addendum.** A run believed to be "no inference" (per the table above) still
billed real spend — the post-event summary and Vibes Analyst's engagement-card pipeline ran
on their own. The mechanism is the auto-stop trap described above: this table was true about
the script's own traffic and silent about the idle-timeout cascade that follows it. Fixed by
adding `DISABLE_POST_EVENT_ANALYSIS` (see above); the table's "Notes" column and this section
were rewritten so the next person reading it before a run sees the whole cost, not just the
part the script itself generates.
