# Benchmark Design — Game-Agnostic Progress Scoring

Status: **draft / proposal**. Novelty vocabulary verified against the fork
(see *Fork verification findings* below). Not yet implemented.

## Goal

Turn the Scummbar harness into a benchmark tool that measures how well an AI
agent plays ScummVM games — not just lets it play them.

## Core premise

The benchmark must be **game-agnostic**. It should not know that Monkey Island
has a rubber chicken or that Day of the Tentacle has a time machine. This is a
feature, not a weakness:

> An agent that scores higher across a suite of different SCUMM games is, by
> construction, generally better at playing SCUMM. If we hand-author
> per-game milestones, we are testing memorization of one title, not the
> agent's ability to make progress in adventure games at large.

Therefore the benchmark must be a **pure function of the telemetry stream**
that the fork already publishes — no per-game goal lists, no hand-authored
milestones, nothing that reads the game manual.

## The only generalizable KPI: progress

Across all SCUMM games the only shared success signal is *making progress*. We
cannot know **what** progress means in a given title, only that the world
state advanced. That is enough: we approximate progress as **state novelty**.

## Run budget

Runs are time-boxed. The user **declares a budget up front**, chosen from four
tiers:

- **5 minutes** — quick smoke test (can the agent orient at all?)
- **10 minutes** — early-game fluency
- **30 minutes** — mid-game exploration
- **1 hour** — deeper puzzle-chaining

Longer tiers are not considered for v1 — token cost climbs quickly and
diminishing-return scoring (see below) means very long budgets don't add much
signal.

The declared budget is part of the run fingerprint and is **the denominator
for all rate-based scoring**, regardless of how the run actually ends.

### Stopping a run

Three stop conditions, in priority order:

1. **Explicit stop** — the agent calls `__benchmarkStop("done")` or a human
   watcher clicks an End button. Score is computed on the events up to that
   point. This is the normal, graceful exit.
2. **Hard ceiling** — if the run exceeds the declared budget (wall-clock or
   action count), the runner force-stops it. Backstop for agents that don't
   self-terminate.
3. **Crash / disconnect** — run marked invalid, excluded from leaderboards.

Rate-based scoring against the **declared** budget (not elapsed time) keeps
the two ends of the spectrum honest:

- Early-quit gaming is neutralized: an agent that finds one novelty and
  quits at 30 seconds gets scored as `1 / 5min`, not `1 / 30sec`.
- Overtime gaming is impossible: the hard ceiling enforces the declared
  budget.

Stopping early is only neutral if the agent had genuinely plateaued.

### Timebase

Two sources are available from the fork:

- `t` — wall-clock milliseconds (`g_system->getMillis()`). **Advances while
  the engine is paused** at a menu or during a modal, which skews rate if
  the agent stops to think at a menu prompt.
- `seq` — monotonic counter incremented per snapshot/event. Pause-safe
  for ordering, but it is not a time unit.

**v1** uses wall-clock `t` as the rate denominator and accepts the
menu-pause skew as a known minor bias, documented per run. `seq` is the
authoritative ordering key.

**v1.5** (once the bench API lands, see below) replaces `t` with the
proposed engine `tickCount` — a pause-safe monotonic tick count, which is
the correct denominator for rate metrics.

## Novelty primitives

Each primitive is a monotonic set that only grows within a run. Adding an
element counts as one novelty event. Primitives 1–8 are derivable from the
v1 telemetry contract today; primitive 9 is gated on the v1.5 bench API.

| # | Primitive | Derived from | Notes |
|---|---|---|---|
| 1 | `Set<roomId>` rooms visited | `snapshot.room` | Strongest universal signal. `agent_state.cpp:627`. |
| 2 | `Set<(roomId, objectId)>` objects seen | `roomObjects[]` | Catches mid-room script spawns via engine rewrites of `_objs[]`. `agent_state.cpp:386`. |
| 3 | `Set<(objectId, state)>` object-state transitions | `roomObjects[].state` | Door opened, box opened, lever pulled. Kept in sync via `putState` (`object.cpp:327`). Script-internal flag-only puzzles do not surface here — see primitive 9. |
| 4 | `Set<objectId>` inventory first-acquisitions | `inventory[]` | Drop/repick does not re-score. `agent_state.cpp:423`. |
| 5 | `Set<actorId>` actors encountered | `actors[]` | NPC discovery. **Caveat:** actors with `_costume == 0` are filtered out (`agent_state.cpp:566`); some games briefly null costume during scene swaps. |
| 6 | `Set<msgTextHash>` unique lines heard | `messageStateChanged.text` | Covers all charset-routed text: actor speech, narrator, notes, "Look at" inscriptions. `agent_state.cpp:639`. |
| 7 | `Set<(actorId, dialogChoiceId)>` dialog branches | `dialogChoicesChanged` | Reliable on v5/v6. Untested on v3/v4 — tag runs accordingly. |
| 8 | Cutscene count | bridge-derived `cutsceneChanged` event | No engine-side event fires on cutscene begin/end; the bridge already diffs `inCutscene` (`bridge.js:296`). For v1 we count bridge-derived transitions. |
| 9 | `Set<(objectId, newOwnerId)>` ownership transfers | `ownerChanged` (bench API) | **v1.5-conditional.** Catches give-to-NPC transfers our `inventory[]` diff misses. Core to every SCUMM game. Gated on the bench API being enabled. |

For v1 all primitives are weighted equally (weight = 1). The scoring function
should be structured so that per-primitive weights can be tuned later, but we
do not calibrate them now — that would be guessing.

## Scoring

### Primary score

Per run, maintain the cumulative novelty curve `N(x)` where `x` is elapsed
seconds. The primary per-run score blends **rate** (how good per unit time)
and **budget** (how long the agent committed to play):

```
rate_score = AUC(N(t)) / T_budget              // time-weighted avg novelty rate
run_score  = rate_score × sqrt(T_budget)       // reward longer budgets sublinearly
```

The `sqrt` term is intentional:

- A 1-hour run at half the rate of a 5-min run still beats it — longer
  commitment pays off.
- But the payoff is sublinear: 12x the budget yields only ~3.5x the
  multiplier. This prevents the benchmark from degenerating into "whoever
  rents the most compute wins," and matches the reality that SCUMM
  progress plateaus as puzzles get harder.

Worked example:

| Agent | Budget | Rate (novelty/min) | `rate × √T` |
|---|---|---|---|
| A | 5 min | 4 | 4 × √5 ≈ **8.94** |
| B | 60 min | 2 | 2 × √60 ≈ **15.49** ✓ |
| C | 60 min | 1 | 1 × √60 ≈ **7.75** ✗ (loses to 5-min agent) |

### Efficiency signals

Diagnostic metrics reported alongside the primary score. They capture the
three concerns from the design conversation (item-acquisition speed, room
thrashing, action repetition) and are cheap to compute from the event log:

| Signal | Formula | What it measures |
|---|---|---|
| Action efficiency | `N(end) / total_sentences` | Rubik's-cube ratio. **v1**: inferred from snapshot deltas. **v1.5**: measured directly via `sentenceResolved(anyEffect)`. |
| Sentence uniqueness | `unique (verb, objectA, objectB) / total_sentences` | Direct measure of repetition |
| Room revisit ratio | `roomEntered_events / unique_rooms` | Back-and-forth. Only penalized when it happens during a zero-novelty streak |
| Plateau | longest stretch where `dN = 0` | Stuck duration |
| Time-to-Nth-novelty | actions/seconds to the 1st, 5th, 10th, 25th novelty event | Discovery speed, chess-Elo style checkpoints |

These are **not** summed into the primary score for v1. They are reported for
diagnosis and later weighting experiments.

### Cross-game aggregation

Per-game scores are reported individually. A **suite score** is the geometric
mean of per-game run-scores, same shape as SPEC benchmarks. Geomean is the
standard choice when per-game scales may differ and no single game should
dominate. The per-game table is shown alongside, so it stays visible which
title contributed what.

## Run fingerprint

Each run record carries enough metadata for cross-run comparability:

- `gameId`, `gameVersion`, `schema`, `benchSchema` (when the bench API is enabled)
- `declaredBudget` (one of 5, 10, 30, 60 minutes)
- starting `room`, seed if available
- `stopReason` (explicit / ceiling / crash)
- agent id / version
- `timebase` (`"wallclock"` for v1, `"tickCount"` for v1.5)
- mock runs (`snapshot.mock === true`) are excluded from the benchmark pool

## Known farming mitigations

The novelty primitives are designed to resist trivial gaming:

- **Reversible state** (open/close loops): each `(obj, state)` tuple counts once
- **Inventory drop/pickup**: first-acquisition only
- **Dialog replay**: hash the text, each hash once
- **Script re-triggers**: cutscene counted per script-invocation-seq, not per transition
- **Early-quit**: rate computed against declared budget, not elapsed
- **Overtime**: hard ceiling enforces the budget

## Fork verification findings

The fork-side agent verified the eight original primitives against the C++
engine, confirmed reliable population across SCUMM v3–v6, and proposed a
dedicated `__scummBench*` API surface. Key outcomes:

### Confirmed for v1 (no engine work required)

- All eight primitives are reliably populated, with the per-primitive notes
  already folded into the table above.
- `t` is wall-clock and not pause-safe; `seq` is the safe monotonic counter.
  Documented in the Timebase section.
- Primitive 8 (cutscene) works for v1 via the existing bridge-derived
  `cutsceneChanged` event — no engine-side event is required.

### Proposed `__scummBench*` API (v1.5)

A separate publisher fed from existing engine funnels, behind the
`--enable-agent-telemetry` flag and schema-versioned independently from the
play-time snapshot schema. All hooks are **cheap** (single call in an
existing funnel) and **universal** (v3–v6):

| Hook | Source funnel | Benchmark use |
|---|---|---|
| `scriptEntered(scriptId, callerScriptId)` / `scriptExited(scriptId)` | `runScript` / `stopScript` (`script.cpp:38`, `script.cpp:262`) | Plateau diagnostics (is any script firing at all?) |
| `varWritten(var, old, new, scriptId)` | `writeVar` (`script.cpp:713`) | **Logged, not scored** in v1.5 — too noisy without a puzzle-var allowlist. Revisit in v2. |
| `objectStateChanged(obj, old, new)` | `putState` (`object.cpp:327`) | Upgrade path for primitive 3 |
| `ownerChanged(obj, old, new)` | `setOwnerOf` (`object.cpp:98`) | **Primitive 9** — ownership transfers |
| `sentenceResolved(verb, objA, objB, anyEffect)` | end of `checkAndRunSentenceScript` (`script.cpp:1166`) | **Directly measured Action Efficiency** — replaces v1 snapshot-diff inference |
| `tickCount` | per `scummLoop` (`scumm.cpp:3250`) | Pause-safe rate denominator; replaces wall-clock `t` |

### Deferred

- **`varWritten`** scoring — games write vars for cursor position, music state,
  and countless internal bookkeeping. Without a puzzle-relevant allowlist we
  would re-introduce novelty farming. Log it for offline analysis in v1.5;
  revisit in v2.
- **Room graph / exit topology** dump — medium cost (exits are script-encoded
  per room, not a flat table). Not worth the engine work for v1.

## Next steps

### v1 (no engine changes)

1. Build a minimal recorder on top of the existing `__scummEventsSince`
   stream that maintains primitives 1–8 and writes a run log.
2. Implement the run-start / run-stop handshake:
   `__benchmarkStart({ game, budgetMinutes, agentId })`,
   `__benchmarkStop(reason)`, plus a human End button in the overlay.
3. Implement the hard-ceiling watchdog.
4. Produce a scoring function that consumes the run log and emits the
   primary score plus the diagnostic efficiency metrics.
5. Build the per-game + suite-level (geomean) leaderboard view.
6. Run a baseline agent + random-action agent on the same game to
   sanity-check that the score separates them.

### v1.5 (adopts `__scummBench*`)

7. Fork lands the `__scummBench*` hooks behind `--enable-agent-telemetry`
   with an independent `benchSchema` version.
8. Recorder adds primitive 9 (ownership transfers) when the bench API is
   present.
9. Action Efficiency switches from snapshot-diff inference to
   `sentenceResolved(anyEffect)`.
10. Rate denominator switches from wall-clock `t` to engine `tickCount`.
11. `scriptEntered/Exited` and `varWritten` logged (not scored) for v2
    analysis.
