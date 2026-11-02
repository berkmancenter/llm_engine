# Socratic probe

`socratic_probe` is a goal of the proactive group agent (`src/agents/proactiveGroupAgent/PROACTIVE_GROUP_AGENT.md`). It posts one short question to the group chat that ties what the room is saying to an idea in the community's readings, without ever saying what the reading concluded. This page describes how the question is produced and checked, how to debug it from the logs, and how it was evaluated.

## What it does and when it fires

The goal definition is `goals/socratic_probe.json` (channel `groupChat`, `silenceCompatible: true`, minimum confidence 70). It is meant for four situations: the group makes a claim a retrieved passage complicates or supports, circles a concept the readings define or dispute, agrees quickly on something the readings treat as contested, or keeps repeating a loaded word ("healthy", "fair") the passage uses differently. The message is always a single question, never a statement followed by a question.

Gating in `proactiveGroupAgent.ts`:

- **Grounded only.** The goal is offered to the decision model only when passages were actually retrieved. The agent prefetches background reading just before the decision call, and only if `socratic_probe` is active and at least one conversation resource has a `fileName`. The query is built from the last few human chat messages. If there is no resource, no query, empty retrieval or a failed retrieval, the goal is removed from the eligible set.
- **Nothing else active.** If `socratic_probe` was the only eligible goal and no passage was retrieved, the agent returns without calling the model.
- **Quiet chat.** Because the goal is `silenceCompatible`, it keeps the agent running when chat is quiet but the transcript is active (see the activity gate in `evaluate()`). With chat and transcript both quiet the agent skips regardless.
- **Decision `none`.** A decision with `goalId` of `"none"` is ignored. A `socratic_probe` decision with no retrieved passage is discarded.
- **Strict safety posture.** If the conversation's `behaviorPolicy` has `safetyPosture: 'strict'`, the final message also goes through the generic professionalism guardrail, which can drop it (see Known gaps).

## The pipeline

1. **Decision call.** The existing proactive decision call picks a goal. For `socratic_probe` it is told not to write the question: `sharedChatMessage` is the placeholder `question`, and it fills three slots, `sourceLabel`, `concept` and `loadedWord`. The decision call's own message is never used.
2. **Slot validation** (`socraticSlots.ts`, `validateSocraticSlots`). A bad concept or source silences the goal for this cycle (`slots rejected (<reason>)` warning).
    - `concept` must be present, at most 6 words, free of digits, and appear in the retrieved passage (case-insensitive).
    - `concept` must name a topic, not an outcome. It is rejected when it contains a finding verb (found, fell, rose, dropped, led to, ...), or when it shares an outcome-ish word (past participle or comparative) with a passage sentence that reports a quantity. A term the passage itself coins in quotation marks is exempt from the second test and from the outcome-only words.
    - `sourceLabel` is trimmed to the part naming the source (years and full citations are cut) and must match the passage text or a conversation resource's title, authors or citation.
    - `loadedWord` is silently dropped (not an error) if it is over 3 words, contains a quote or question mark, or the group has used it fewer than twice in the last 15 human chat lines.
3. **Passage-blind writer** (`socraticQuestionWriter.ts`). A separate model call receives the source name, the concept, the loaded word, the last 8 human chat lines and the agent's last 5 posts. It never receives the passage, so it cannot leak a finding it was never shown. When a loaded word is set, the concept is withheld (shown as `(none)`): pairing the group's word with a reading term invited presuppositions about the reading.
4. **Deterministic shape checks** (`socraticChecks.ts`, `checkSocraticShape`), each with its reason:

    | Check | Why |
    | --- | --- |
    | exactly one `?`, at the very end | one ask only |
    | at most 40 words | keeps it a question, not a paragraph |
    | names the source (full label, or surname for a 2-3 token label) | the room must know where the idea comes from |
    | quotes the loaded word in double quotes, when one is set | marks the word as the group's, not the source's |
    | names no participant (pseudonym or last word of one) | never single anyone out |
    | loaded word and concept not both present | pairing smuggles in a presupposition about the reading |
    | no he/she/his/her/him outside quotes | the writer has not read the source and cannot know the gender |
    | no analogy or hypothetical markers (imagine, what if, as if, ...) | the goal forbids invented examples |
    | no quoted foreign word credited to the source (`findQuotedWordCreditedToSource`) | "Lee uses 'healthy'" attributes the group's word to the source; a modal ("would mean") is allowed |
    | not a compound question (`isCompoundQuestion`) | a second clause is where presuppositions creep in; a leading framing clause ("When we say X, would ...") is not a second ask |
    | no trailing "given that / in light of / since you" clause | sets the room's view against the reading |
    | no digits | numbers imply a finding |
    | no finding verbs (found, fell, rose, ...) after slots are stripped | reports an outcome |
    | no 4-gram copied from the passage (after removing slot terms; all-function-word runs ignored) | copied wording can carry the finding |
    | content-word overlap with a recent agent post at most 0.5 (source-name words ignored) | do not re-ask the same question |

    Reasons returned to the writer are generic and contain no passage text, so they are safe to hand back.
5. **Redrafts.** A rejected draft is fed back to the writer with its reasons, up to 4 writer calls in all (one draft plus 3 redrafts; `MAX_WRITER_ATTEMPTS` in `socraticPipeline.ts`). The decision call is never re-run. A failed writer call counts as an attempt.
6. **Template fallback.** If no draft passes, a question is rendered from the validated slots with no model: `When we say "<word>", would <source> mean the same thing by it?`, or `How does <source> treat <concept>?` with no loaded word. The template goes through the same shape checks.
7. **Silence.** If the template itself fails the checks, nothing is posted.

## Logs

Search for `[SocraticStage]`:

- `draft rejected {"attempt","stage","reason","draft"}`: one per rejected draft. `stage` is `shape` (the only stage today), `reason` is the `; `-joined list of failed checks, `draft` is the full text.
- `no draft passed — using template fallback`, then `template fallback used` or `template fallback failed checks (...) — staying silent`.
- `summary {"outcome","attempts"}`: always the last line. `outcome` is `posted-writer`, `posted-template` or `silent`; `attempts` is the number of writer calls used.
- `writer call failed`: the model call threw; it counts as an attempt.

The agent itself logs `slots rejected (<reason>)` before the stage runs, `chosen without retrieved passages`, and the prefetch failure warning.

**Debugging a missing probe.** Work backwards: no `socratic_probe` decision means the goal was not eligible (no passages, so check the resource `fileName` and the prefetch warning) or the model chose another goal or `none`. A `slots rejected` line names the validation rule that fired. A `summary` with `silent`, or with `attempts` of 4 followed by the template, means the writer kept failing a check; the `draft rejected` lines show which. A guardrail rejection warning means the strict safety posture dropped it.

**Deciding what to prune.** Count `reason` fragments over a large sample of `draft rejected` lines. A check that never appears in the reasons, across many conversations, adds code without protecting anything. A check that appears on most first drafts is either a prompt problem (fix the writer prompt) or an over-strict rule (relax the check). Look at the `attempts` histogram too: mostly 1 means the prompt does the work and the checks are a backstop.

## Why there are no LLM judges

Two model-based judges were built and removed. One never fired. The other rejected about 80% of first drafts as over-strict, which burned redraft budget and pushed output toward the template. A variant that quoted the offending span back to the writer gave no measurable benefit. Deterministic checks are predictable, free, explain themselves with a one-line reason, and can be unit tested. The tradeoff is that they are shape checks and cannot catch every presupposition; the blind audit below is how that residual risk is measured.

## Evaluation method

**Fabricated readings.** Tests use invented papers and terms, so the model cannot know their contents from training and any leak must come from the pipeline. `tests/agents/proactiveGroupAgent/proactiveGroupAgent.socraticProbe.test.ts` and `...socraticProbe2.test.ts` each use one fabricated reading.

**Live suite.** `yarn test:agents` runs `tests/agents/**` against the configured test LLM, real Chroma and a shared Mongo. It runs serially (`-i`) because the tests share one database and wipe collections; do not run it in parallel or alongside another run against the same Mongo. The socratic tests hard-gate the message shape on every case: one question mark at the end, at most 40 words, source named, no participant names, no digits, no invented analogy, no copied passage wording, a quoted loaded word when the decision identified one, and no re-ask above 0.5 overlap. They also assert silence with no resources and with an irrelevant chat. Whether the decision fires is a model judgment and is logged (`socratic_probe responses:`) rather than gated. See `tests/CLAUDE.md`.

**Blind audit.** Shape checks cannot see a presupposition, so quality is measured by a person-like read. A separate model sees only the passage, the chat lines and a shuffled set of unlabeled messages (no indication whether a message came from the plain model or the pipeline) and labels each:

- `LEAK-ASSERT`: the message states something the passage says.
- `LEAK-PRESUPPOSE`: the message takes a claim from the passage for granted.
- `CLEAN`: neither.

plus flags for `misattributes` (credits the source with the group's words), `one_question`, `quotes_word` and `fabricates`. The secret key mapping messages to conditions is kept apart and applied only after labeling.

Lessons:

- **Calibrate the rubric explicitly.** Naming the reading's concept, or asking whether the author would use a word, is not a leak by itself. Without that line an auditor treats any reference to the reading as a leak.
- **Use two independent auditors** and compare; disagreement shows where the rubric is vague.
- **Require hand-reading.** An auditor that labels by keyword rule is useless; instruct it to read every message and say so in its output.
- **An untuned strict auditor can flag everything.** Check the rate on known-good messages before trusting a result.
- **Samples are small** (tens of messages). Treat differences of a few messages as noise.
- **Keep per-message notes**, not just counts, so a surprising label can be re-checked.

## Results

On the first reading (41 messages from the plain model, no pipeline): 18 clean, 22 presupposing, 1 asserting, 7 misattributing. The guarded pipeline (shape checks, concept withheld, redrafts) over 80 messages across two readings: 77 and 79 clean, 0 asserted, 0 misattributing, 0 compound.

For context, earlier rounds with a stricter auditor: misattribution went from about 35% to about 7%, then to 0 after the concept was withheld whenever a loaded word is set; presupposition was about 18-21% before the later fixes (single ask, no trailing given-that clause, no crediting the source with the group's words). Counts are from separate rounds with different samples and are indicative, not a controlled comparison.

## Known gaps and pruning plan

- **Small samples.** All figures come from tens of messages on two fabricated readings with one configured test LLM. Treat them as a regression tripwire, not a failure-rate bound.
- **Professionalism guardrail.** Under `safetyPosture: 'strict'` the generic guardrail runs after the pipeline and has dropped otherwise valid probes. Those drops are not covered by the `[SocraticStage]` logs; look for the `rejected by professionalism guardrail` warning.
- **Checks that did not fire in recent runs:** the finding-verb check, the analogy markers, the near-repeat overlap check and the digit check. The template fallback was used in about 0 of 80 messages. These are candidates for pruning.
- **Plan.** Collect `draft rejected` lines from real conversations for a few weeks, count reasons, and remove a check only if it never fired and the blind audit on a fresh reading shows no regression without it. Keep slot-validation rules (they gate the writer's inputs) and the checks that did fire in the audit: single ask, no credit to the source, no pronouns, and the loaded-word pairing rule. Keep the template fallback as the last line, since removing it turns every exhausted redraft into silence.
