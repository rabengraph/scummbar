# ScummBench E2E agentic tests

Drive a headless browser + Claude agent against a live ScummBench
deployment and verify a feature end-to-end.

Each test is a JSON manifest with three parts:

1. **`pretest`** — deterministic bootstrap (navigate to game, wait WASM,
   skip intro, walk to the test's starting room). No LLM, no cost.
2. **`agent`** — a Claude agent given `browser_eval` as a tool and the
   test's prose `task`. It adapts to timing / transient state.
3. **`assertions`** — evaluated deterministically by the runner against
   the final state. The agent does not self-certify.

## Run one test

```bash
pnpm --dir tests/e2e-agentic install
pnpm --dir tests/e2e-agentic exec playwright install chromium

ANTHROPIC_API_KEY=sk-ant-... \
  node tests/e2e-agentic/run.mjs \
    --test=conversation-lock \
    --base-url=http://127.0.0.1:5173
```

Against a Vercel preview: `--base-url=https://scummbench-pr42.vercel.app`.

## Add a new test (the semi-automated flow)

1. Run an interactive Claude Code session and drive the game to the
   starting state of your new feature — use `pnpm browser:open` /
   `pnpm browser:eval` commands.
2. Once you're at the test's starting point, invoke
   `/extract-pretest <test-name>`. The skill reads the recent
   `browser:*` tool calls from the session and writes
   `tests/<test-name>.json` with a populated `pretest` block.
3. Fill in the `agent.task` prose and `assertions` list.
4. Run the test locally to verify it passes.
5. Open a PR — CI runs the new test against the Vercel preview.

## Test manifest shape

```jsonc
{
  "name": "conversation-lock",
  "feature": "PR #16 — reject non-dialog actions while conversation is open",
  "gameId": "monkey1-demo",

  "pretest": [
    { "kind": "navigate", "path": "/game?game=monkey1-demo" },
    { "kind": "waitFor",  "expression": "__scummActionsReady()", "timeoutMs": 30000 },
    { "kind": "sleep",    "ms": 3000 },
    { "kind": "waitFor",  "expression": "__scummRead() && __scummRead().room === 55 && !__scummRead().inputLocked", "timeoutMs": 30000 }
  ],

  "agent": {
    "task": "Navigate to room 57 via archway 421. Talk to object 428 (Citizen)...",
    "maxTurns": 40,
    "model": "claude-sonnet-4-6"
  },

  "assertions": [
    { "name": "room_is_57_or_later", "expression": "__scummRead().room", "predicate": { "in": [55, 57] } },
    { "name": "inventory_is_array",  "expression": "Array.isArray(__scummRead().inventory)", "predicate": { "equals": true } }
  ]
}
```

### Pretest step kinds

| kind        | fields                                    | behavior                                         |
|-------------|-------------------------------------------|--------------------------------------------------|
| `navigate`  | `path`                                    | `page.goto(baseUrl + path)`                      |
| `waitFor`   | `expression`, `timeoutMs?`, `pollMs?`     | poll `page.evaluate(expression)` until truthy    |
| `eval`      | `expression`                              | one-shot eval, no wait                           |
| `sleep`     | `ms`                                      | fixed delay                                      |

### Assertion predicates

| predicate          | matches                                      |
|--------------------|----------------------------------------------|
| `equals: <v>`      | `===`                                        |
| `in: [<v>, ...]`   | membership                                   |
| `contains: <s>`    | substring (string) or element (array)        |
| `gte`, `lte`, `gt`, `lt`: `<n>` | numeric comparison              |
| `matches: "<re>"`  | regex test on string                         |

## Design notes

See [`docs/E2E_AGENTIC.md`](../../docs/E2E_AGENTIC.md) for architecture,
CI plan (Vercel preview integration), and TDD workflow.
