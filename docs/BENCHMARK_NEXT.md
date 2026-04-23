# Benchmark — Follow-up Prompt for the Next Agent

Hand-off document. The previous session designed a game-agnostic benchmark
scoring system on top of the existing Scummbar harness. Only the design is
committed — **no implementation yet**. This file tells the next agent where
we left off and what to do first.

## Read first

1. `docs/BENCHMARK_DESIGN.md` — the full spec. Read all of it before doing
   anything else. It is the source of truth for the primitives, scoring
   formula, run budget, stop handshake, farming mitigations, and the
   fork-side verification findings.
2. `CLAUDE.md` — project overview, routes, browser harness commands.
3. `web/shared/bridge.js` — the telemetry consumer already runs in every
   `/game` page. The benchmark sits on top of this, not beside it.
4. `web/shared/mock.js` — `?mock=1` emits fake telemetry in the v1 shape.
   Use this to develop and test without a fork build.

## Current state

- Branch: **`claude/add-game-telemetry-vpbck`** (also the target for
  subsequent pushes).
- Commits so far: three docs commits only (`c5966c6`, `87e2ff6`, `b20f717`).
  No code.
- The fork-side verification report is already folded into
  `docs/BENCHMARK_DESIGN.md`. You do not need to re-prompt the fork agent.

## What is decided (do not re-litigate)

- **Benchmark is game-agnostic.** No per-game milestones, no hand-authored
  goal lists. The user is emphatic that this is a feature, not a weakness —
  an agent good at making progress in one SCUMM game should be good at all
  of them, so a game-agnostic score is a stronger measure than a per-game
  one.
- **Progress = monotonic state novelty** over 8 primitives (primitive 9 is
  v1.5-conditional on the bench API).
- **Run budget tiers**: 5 / 10 / 30 / 60 minutes. No 3h. User declares up
  front.
- **Score formula**: `rate_score × sqrt(T_budget)` where
  `rate_score = AUC(N(t)) / T_budget`. Sublinear reward for longer budgets.
- **Stop handshake**: explicit stop (agent or human) + hard ceiling
  backstop. Rate is computed against the **declared** budget, not elapsed
  time — neutralizes early-quit and overtime gaming.
- **Cross-game aggregation**: geomean of per-game run-scores, with the
  per-game table shown alongside.
- **Timebase for v1**: wall-clock `t` with a documented menu-pause skew.
  Swap to engine `tickCount` in v1.5.
- **Action Efficiency for v1**: inferred from snapshot deltas. Direct
  measurement via `sentenceResolved(anyEffect)` is v1.5-conditional on the
  bench API.
- **Keep v1 simple.** User explicitly said it doesn't need to be perfect —
  it needs to give a good first direction with the cheapest heuristics.

## What's next: thinnest end-to-end vertical slice

The user and I agreed the next concrete step is a **minimal working loop**
before building the pretty pieces. Goal: prove the data pipeline against
`/game?mock=1` in roughly a day.

Suggested shape — a new module `web/shared/benchmark.js`:

- Loaded on the `/game` page, alongside `bridge.js`.
- Subscribes to `window.addEventListener("scumm:state", ...)` and
  `"scumm:event"` — **do not** modify `bridge.js`.
- Exposes:
  - `window.__benchmarkStart({ game, budgetMinutes, agentId })` — records a
    fingerprint, starts the wall-clock, resets the monotonic sets.
  - `window.__benchmarkStop(reason)` — freezes the run, dumps the run log.
  - `window.__benchmarkStatus()` — elapsed, remaining, current novelty count.
- Maintains a **subset** of the primitives first — pick 1, 3, 4, 8 (rooms,
  object-state, inventory, cutscene). These are the easiest to derive and
  cover the most universal signals. Add 2, 5, 6, 7 after the loop works.
- Computes a **trivial score** at stop (e.g. total novelty count). The
  real `rate × √T` formula and AUC can come in a second pass once we have
  real run logs to eyeball.
- Writes the run log to `sessionStorage` and/or offers a download-as-JSON
  button. Do not persist to disk-side storage in v1.
- Enforces the hard ceiling via `setTimeout(budgetMinutes * 60 * 1000)`.

Explicitly **not** in the first slice:

- No UI beyond an End button in the overlay (optional for first pass).
- No leaderboard view.
- No per-game normalization, no geomean yet.
- No fork changes. Do not touch `vendor/scummvm-agent/`.
- No `__scummBench*` work — that's v1.5.

## Validation

Develop against `/game?mock=1`. The mock script emits faithful v1 snapshots
and events and has a few test helpers (`__scummMock.simulateDialog()`,
`.simulateCutscene()`, `.goToRoom(n)`). You should be able to:

1. Open `/game?mock=1`.
2. Call `__benchmarkStart({ game: "mock", budgetMinutes: 5, agentId: "test" })`.
3. Drive the mock through a few rooms / pickups / cutscenes.
4. Call `__benchmarkStop("done")`.
5. Inspect the run log and confirm primitives were counted correctly.

Use the existing browser harness commands from `CLAUDE.md` (`pnpm
browser:open`, `pnpm browser:eval -- "..."`) rather than hand-clicking.

## Style preferences the user cares about

- Small, focused v1. Don't build abstractions you won't use yet.
- Prefer editing existing files to creating new ones when possible — but
  `benchmark.js` is a legitimately new module.
- No per-game knowledge anywhere in the benchmark code. If you find
  yourself typing "if (game === ...)" stop and rethink.
- Keep the scoring code structured so per-primitive weights can be added
  later without rewriting, but **do not** calibrate weights now.

## Suggested opening move

Read `docs/BENCHMARK_DESIGN.md` end-to-end, then read `web/shared/bridge.js`
and `web/shared/mock.js` to confirm the event shape. Then propose a
one-paragraph module sketch (exports, subscriptions, storage) before
writing any code, so the user can redirect cheaply if the shape is wrong.
