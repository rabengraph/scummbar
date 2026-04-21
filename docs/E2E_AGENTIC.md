# E2E agentic tests — design

ScummBench ships unit tests against `bridge.js` today (stubbed `vm`
context, fast, deterministic). Those catch regressions in the JS bridge
in isolation but they do not exercise the full stack — WASM engine, the
Emscripten bridge, route wiring, upload flow, or the agent-facing API
contract on a real deployment.

This doc describes the **agentic E2E layer**: a headless browser + a
Claude agent, driving the real site end-to-end to verify a feature. The
initial implementation lives under [`tests/e2e-agentic/`](../tests/e2e-agentic/).

## Goals

- Verify features on a live deployment (local dev server OR a Vercel preview).
- Catch regressions that escape unit tests (e.g. the WASM engine
  crashing on cold start; bridge semantics drifting across fork rebuilds;
  an API being removed).
- Be cheap enough per-PR that we can afford to run the NEW test on every
  preview push during development (TDD-style).
- Be extensible: adding a test = adding one JSON manifest file.

## Non-goals

- Running the full suite on every PR push — too token-costly.
- Replacing unit tests. Unit tests are the first line of defense; E2E
  tests the last.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  node tests/e2e-agentic/run.mjs --test=X --base-url=Y         │
│                                                               │
│  ┌────────────────┐                                           │
│  │ tests/X.json   │  manifest: pretest + agent + assertions   │
│  └────────────────┘                                           │
│         │                                                     │
│         ▼                                                     │
│  ┌────────────────┐   browser.eval()    ┌─────────────────┐   │
│  │ pretest.mjs    │ ───────────────────▶│ headless        │   │
│  │ (deterministic)│                     │ Chromium        │   │
│  └────────────────┘                     │ (Playwright)    │   │
│         │                               │                 │   │
│         ▼                               │ loaded at:      │   │
│  ┌────────────────┐                     │ baseUrl/game    │   │
│  │ agent.mjs      │ ──tool: browser_eval│ ?game=<id>      │   │
│  │ (Anthropic SDK)│─────────────────────▶                 │   │
│  └────────────────┘                     └─────────────────┘   │
│         │                                       ▲             │
│         ▼                                       │             │
│  ┌────────────────┐   browser.eval()            │             │
│  │ assertions.mjs │─────────────────────────────┘             │
│  │ (deterministic)│                                           │
│  └────────────────┘                                           │
│         │                                                     │
│         ▼                                                     │
│    report.json + exit 0|1                                     │
└───────────────────────────────────────────────────────────────┘
```

### Why split pretest / agent / assertions?

The analysis document from the first interactive run showed a clear
three-part structure:

- **Deterministic prefix** — load game, wait WASM, skip intro, navigate
  to the puzzle room. Identical every run. No LLM needed; running it
  with an LLM wastes tokens and invites flakes.
- **Adaptive middle** — timing-sensitive interactions (grab herring
  while bird is far enough away). An LLM is actually useful here because
  thresholds vary per run.
- **Deterministic verdict** — check the final state against a fixed
  assertion list. Must NOT be decided by the agent — the agent can't
  be trusted to fail itself reliably.

This split is the main reason this design is extensible: when we add
new tests, only the middle is novel; the prefix is semi-automatically
extracted by the `/extract-pretest` skill.

## Authoring workflow

1. **Write a failing test first** (TDD). Drive the game manually in an
   interactive Claude Code session using the existing
   `node tools/browser/browser.js …` commands until you reach the
   starting state of your new feature.
2. **Invoke `/extract-pretest <name>`.** The skill reads the session's
   recent browser calls and writes
   `tests/e2e-agentic/tests/<name>.json` with the `pretest` block
   populated and `agent` + `assertions` as TODOs.
3. **Fill in `agent.task`** — prose instructions for the agent. Tell it
   exactly what to observe and have it record observations to
   `window.__e2eTestResults`. The runner reads that object for
   assertions.
4. **Fill in `assertions`** — predicates against
   `window.__e2eTestResults` or `__scummRead()`.
5. **Run locally** against `http://127.0.0.1:5173` to confirm the test
   is red before the fix lands.
6. **Implement the fix, push to a PR.** The CI workflow (below) runs
   the new test against the Vercel preview on every push. Iterate until
   it goes green, then merge.

## CI design

**Not implemented yet.** The runner is CLI-friendly and ready to wire up;
this section describes the plan so the final implementation doesn't drift.

### Triggers

1. **Per-PR, scoped to changed tests** (default — cheap, TDD-friendly).
   - Triggered by `deployment_status` events from Vercel (so the preview
     URL is available).
   - For each push, diff the PR against `main`; find `tests/e2e-agentic/tests/*.json`
     files that were **added or modified**; run only those.
   - Rationale: if you're working on a test, you want fast feedback on
     it. You don't want to pay for every other test every push.

2. **Full-suite on-demand** (label `e2e:full`).
   - When a maintainer adds the `e2e:full` label to a PR, run every
     test in `tests/e2e-agentic/tests/` against the latest preview.
   - Exists for sanity-check before merging a large change.

3. **Pre-merge on main** (future — requires merge queue or manual step).
   - GitHub's `merge_group` event (merge queue) is the cleanest hook;
     alternative is a required check that a maintainer manually dispatches
     via `workflow_dispatch` before clicking merge.
   - Not automatic on every push to `main` — too token-costly.

Not triggered on every merge to main automatically. Details TBD;
current preference is the merge queue or a label-gated full run.

### Secrets

- `ANTHROPIC_API_KEY` — repository secret. Required for the agent loop.

### Rough workflow sketch

```yaml
# .github/workflows/e2e-agentic.yml  (TO BE IMPLEMENTED)
name: e2e-agentic
on:
  deployment_status:
  pull_request:
    types: [labeled]

jobs:
  run:
    # Only run on successful Vercel previews OR when the e2e:full label is added.
    if: |
      (github.event_name == 'deployment_status' && github.event.deployment_status.state == 'success') ||
      (github.event_name == 'pull_request' && github.event.label.name == 'e2e:full')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm --dir tests/e2e-agentic install
      - run: pnpm --dir tests/e2e-agentic exec playwright install --with-deps chromium

      - name: Select tests
        id: select
        run: |
          if [[ "${{ github.event.label.name }}" == "e2e:full" ]]; then
            ls tests/e2e-agentic/tests/*.json | xargs -n1 basename | sed 's/\.json$//' > selected.txt
          else
            git diff --name-only --diff-filter=AM origin/main..HEAD \
              | grep '^tests/e2e-agentic/tests/.*\.json$' \
              | xargs -n1 basename | sed 's/\.json$//' > selected.txt || true
          fi
          echo "count=$(wc -l < selected.txt)" >> $GITHUB_OUTPUT

      - name: Run selected tests
        if: steps.select.outputs.count != '0'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          BASE_URL: ${{ github.event.deployment_status.environment_url || github.event.deployment.payload.web_url }}
        run: |
          while read name; do
            node tests/e2e-agentic/run.mjs --test="$name" --base-url="$BASE_URL"
          done < selected.txt

      - uses: actions/upload-artifact@v4
        with: { name: e2e-reports, path: tests/e2e-agentic/reports/ }
```

### Token cost estimate (back-of-envelope)

- System prompt (cached briefing): ~8k tokens input, cached after first call (~90% discount).
- Per-turn: ~1-3k input tokens (tool results), ~500-1500 output tokens.
- Expected turns per test: 10-30.
- Per-test cost at Sonnet 4.6 prices: ~$0.10-0.60.
- Per-PR default (only changed tests): typically 1 test → <$1.
- Full-suite: N × per-test cost. At 2 tests today, ~$0.20-1.20.

These are rough; real numbers will land after the first few runs.

## Related

- Unit tests: [`tools/test/*.test.mjs`](../tools/test/) — fast, stubbed.
- Browser harness for interactive play: [`tools/browser/browser.js`](../tools/browser/browser.js).
- Agent briefing (the API surface being tested): [`web/briefing/index.html`](../web/briefing/index.html).
