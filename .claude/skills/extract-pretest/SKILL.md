---
name: extract-pretest
description: Extract an E2E test pretest from the current interactive Claude Code session. Use when the user has driven the ScummBench game to a desired starting state via `node tools/browser/browser.js ...` calls (or the `pnpm browser:*` aliases) and wants to save those calls as a deterministic pretest block for a new e2e-agentic test. Invoke with the test name, e.g. `/extract-pretest red-herring-v2`.
---

# extract-pretest

Turn the last N browser-driving calls in THIS session into a pretest block
for `tests/e2e-agentic/tests/<name>.json`.

## When to use

The user has just run a sequence of `node tools/browser/browser.js`
commands (or `pnpm browser:*` aliases) in this same session to navigate
the game to a test's starting state. They now want to lock that sequence
in as a deterministic pretest so the E2E agent can start from there
every run.

If no such calls exist in the session yet, stop and ask the user to drive
the game first.

## How it works

1. **Parse args** — the test name is the single argument. If missing, ask
   the user for one.
2. **Scan the session transcript** for Bash tool calls whose command
   starts with `node tools/browser/browser.js`, `pnpm browser:`, or any
   equivalent invocation of the browser harness. Ignore read-only calls
   (`state`, `events`, `screenshot`); collect action and navigation
   calls. Stop at the user's most recent "good state" — usually the last
   `state` or `eval "__scummRead()"` they ran, where they confirmed the
   game was at the starting state.
3. **Classify each call** into a pretest step:
   - `browser.js open <url>` → `{ kind: "navigate", path: "<url minus host>" }`
   - `browser.js eval "location.href='...'"` → `{ kind: "navigate", path }`
   - `browser.js eval "__scummActionsReady()"` (as a readiness gate) →
     `{ kind: "waitFor", expression: "typeof __scummActionsReady === 'function' && __scummActionsReady()", timeoutMs: 30000, pollMs: 500 }`
   - `browser.js action '{"type":"doSentence",...}'` → `{ kind: "eval", expression: "__scummDoSentence({verb: V, objectA: A})" }`
     followed by a `waitFor` step for the expected room / dialog / cutscene change (infer from what the user read next).
   - `browser.js action '{"type":"walkTo", ...}'` → `{ kind: "eval", expression: "__scummWalkTo(X, Y)" }`
   - `browser.js action '{"type":"skipMessage"}'` → `{ kind: "eval", expression: "__scummSkipMessage()" }`
   - Explicit shell `sleep N` between calls → `{ kind: "sleep", ms: N*1000 }`.
4. **Always prepend the standard bootstrap** unless it's already there:
   ```json
   [
     { "kind": "navigate", "path": "/game?game=<gameId>" },
     { "kind": "waitFor", "expression": "typeof __scummActionsReady === 'function' && __scummActionsReady()", "timeoutMs": 30000, "pollMs": 500 },
     { "kind": "sleep", "ms": 3000 },
     { "kind": "waitFor", "expression": "(() => { const s = __scummRead(); return s && !s.inputLocked; })()", "timeoutMs": 60000, "pollMs": 500 }
   ]
   ```
5. **Always append** a final step that zeroes out `window.__e2eTestResults`
   so the agent has a clean results object to populate:
   ```json
   { "kind": "eval", "expression": "window.__e2eTestResults = {}; true" }
   ```
6. **Add `waitFor` guards after every action** that expects a state
   change. Default pattern:
   - after `doSentence` that walks to another room → `{ "kind": "waitFor", "expression": "__scummRead().room === <N>", "timeoutMs": 20000, "pollMs": 500 }`
   - after `skipMessage` → `{ "kind": "waitFor", "expression": "__scummRead().haveMsg === 0", "timeoutMs": 10000, "pollMs": 300 }`
   If the expected post-condition is not obvious from the session, insert
   a TODO comment in the step and flag it at the end.
7. **Write the manifest** at
   `tests/e2e-agentic/tests/<name>.json` with `pretest` populated, and
   `agent.task` + `assertions` as empty placeholders for the user to fill:
   ```json
   {
     "name": "<name>",
     "feature": "TODO: describe the feature this test covers",
     "gameId": "monkey1-demo",
     "pretest": [ ... ],
     "agent": {
       "task": "TODO: prose instructions for the agent — what to verify and how to record it to window.__e2eTestResults",
       "maxTurns": 30,
       "model": "claude-sonnet-4-6"
     },
     "assertions": [
       { "name": "TODO", "expression": "window.__e2eTestResults.TODO", "predicate": { "equals": true } }
     ]
   }
   ```
   If the file already exists, refuse and ask the user to pick a different name or delete it.
8. **Report back** a one-line summary and the path, plus any TODOs /
   unresolved waits you couldn't classify.

## Rules

- Do not invent calls the user did not make. Skip anything you cannot
  classify.
- Preserve order — the pretest must be a linear, deterministic script.
- Strip all dynamic values (cursors, timestamps) — they don't belong in
  a deterministic pretest.
- Leave `agent.task` and `assertions` blank with TODO markers. Those are
  the author's job, not the skill's.
- Do NOT overwrite an existing manifest.
- Do NOT commit or push — let the user review first.

## Example

User session transcript:
```
$ node tools/browser/browser.js open "http://127.0.0.1:5173/game?game=monkey1-demo"
$ node tools/browser/browser.js eval "__scummActionsReady()"       # -> true
$ node tools/browser/browser.js action '{"type":"doSentence","verb":10,"objectA":421}'
$ sleep 3
$ node tools/browser/browser.js state                              # room === 57
$ node tools/browser/browser.js action '{"type":"doSentence","verb":13,"objectA":428}'
$ sleep 2
$ node tools/browser/browser.js state                              # dialogChoices.length > 0
```

`/extract-pretest conversation-lock-v2` produces:
```json
{
  "pretest": [
    { "kind": "navigate", "path": "/game?game=monkey1-demo" },
    { "kind": "waitFor", "expression": "typeof __scummActionsReady === 'function' && __scummActionsReady()", "timeoutMs": 30000, "pollMs": 500 },
    { "kind": "sleep", "ms": 3000 },
    { "kind": "waitFor", "expression": "(() => { const s = __scummRead(); return s && !s.inputLocked; })()", "timeoutMs": 60000, "pollMs": 500 },
    { "kind": "eval", "expression": "__scummDoSentence({verb: 10, objectA: 421})" },
    { "kind": "waitFor", "expression": "__scummRead().room === 57", "timeoutMs": 20000, "pollMs": 500 },
    { "kind": "eval", "expression": "__scummDoSentence({verb: 13, objectA: 428})" },
    { "kind": "waitFor", "expression": "__scummRead().dialogChoices.length > 0", "timeoutMs": 10000, "pollMs": 300 },
    { "kind": "eval", "expression": "window.__e2eTestResults = {}; true" }
  ]
}
```
