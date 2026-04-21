# Browser Harness — ScummBench

Lets an AI agent drive ScummVM from the terminal via `eval` on `window.__scumm*` globals.

```
Agent (terminal) → browser.js → CDP WebSocket → Chromium → window.__scumm* API
```

## Setup

```bash
pnpm install
npx playwright install chromium  # one-time: downloads Chromium binary
```

## Commands

Almost everything goes through `eval`. Three commands cover 99% of usage:

```bash
pnpm browser:open                          # launch Chromium, open briefing page
pnpm browser:eval -- "<js expression>"     # eval JS in page, get JSON back
pnpm browser:screenshot                    # save PNG to state/
pnpm browser:close                         # kill browser
```

## Usage

```bash
# Navigate to game (upload UI)
pnpm browser:eval -- "location.href='/game'"

# Navigate to a pre-staged local game (see scripts/add-game.sh)
pnpm browser:eval -- "location.href='/game?game=monkey1'"

# Read state
pnpm browser:eval -- "__scummRead()"

# Do an action (preferred method)
pnpm browser:eval -- "__scummDoSentence({verb:8, objectA:429})"

# Dialog
pnpm browser:eval -- "__scummSelectDialog(0)"
pnpm browser:eval -- "__scummSkipMessage()"

# Events since cursor
pnpm browser:eval -- "__scummEventsSince(0)"

# Walk / click (fallback)
pnpm browser:eval -- "__scummWalkTo(160, 130)"
pnpm browser:eval -- "__scummClickAt(160, 130)"
```

All output is JSON: `{ "ok": true, "value": <result> }` or `{ "ok": false, "error": "..." }`.

## Convenience aliases

These are thin wrappers around eval — use them or don't:

```bash
pnpm browser:state                         # same as eval "__scummRead()"
pnpm browser:events -- 0                   # same as eval "__scummEventsSince(0)"
pnpm browser:action -- '{"type":"doSentence","verb":8,"objectA":429}'
```

## Agent play loop

1. `pnpm browser:open`
2. `eval` — navigate to game page
3. `eval` — `__scummRead()` to see room, objects, verbs, inventory
4. Decide next action
5. `eval` — call the appropriate `__scumm*` function
6. `eval` — `__scummEventsSince(cursor)` to see what happened
7. Repeat from 3. Use `screenshot` when you need visual confirmation.

## Browser persistence

Chromium stays alive between commands via CDP on port 9222. First call launches it, subsequent calls reuse it. `pnpm browser:close` kills it.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `SCUMM_URL` | `http://127.0.0.1:5173` | Base URL of the dev server |
