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

| Script | Inference | Notes |
| --- | --- | --- |
| `eventAssistantLoad.js` | **Expensive** | ~3,500 chat requests per run, each an agent/LLM chain |
| `transcriptLoad.js` | **Expensive** | ~3,000 transcript posts driving periodic/proactive agents |
| `websocketStampede.js` | **Effectively free** | only Engine.IO frames (`3` pong, `40`, `42 conversation:join`); never posts a message |

## Pick the cheapest experiment that answers the question

Most infrastructure questions do **not** need the expensive scripts:

- Connection establishment, sticky routing, autoscaler reaction, scale-out timing,
  boot-to-healthy, baked images → **`websocketStampede.js` alone**. Free. It still needs
  conversations to exist, so reuse a previous run's test user rather than recreating
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
