# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Scummbar Game Harness** — agent-first browser harness for running ScummVM games with symbolic state exposed to AI agents. This is a proof-of-concept answering: **Does exposing symbolic SCUMM state in-browser materially improve an agent's ability to play the game compared to pure vision?**

Two-repo architecture developed in parallel:
- **This repo (`scummbar`)** — app shell, briefing page, game route, overlays, state panel, scripts, deployment
- **ScummVM fork** — SCUMM engine telemetry hooks, C++ to JavaScript bridge

## ScummVM Fork (vendor/scummvm-agent/)

The fork lives at `vendor/scummvm-agent/` as a separate git repository (gitignored from harness). It tracks `rabengraph/scummvm` branch `develop`.

**Active parallel development:** When making telemetry changes, work directly in `vendor/scummvm-agent/` and commit/push to `develop`. The fork's `master` stays as a pristine mirror of upstream ScummVM.

Key fork locations:
- `engines/scumm/AGENT_HARNESS.md` — canonical telemetry schema
- `engines/scumm/agent_state.{h,cpp}` — state collection
- `engines/scumm/agent_bridge_emscripten.cpp` — C++ to JS bridge

## Common Commands

```bash
# Setup (install Node via nvm, pnpm, deps)
./scripts/bootstrap.sh

# Build ScummVM fork (requires emsdk on PATH)
source ~/emsdk/emsdk_env.sh
./scripts/build-scummvm.sh

# Start dev server
pnpm dev                    # or ./scripts/start-dev.sh

# Add a game (from directory or zip)
./scripts/add-game.sh ~/games/MONKEY1 monkey1

# Open Chrome with fresh profile
./scripts/open-chrome.sh
```

## Key Routes

- `/briefing` — Agent briefing page with `#agent-brief` JSON and API reference
- `/game` — ScummVM wasm runtime. Default state shows the upload UI;
  state and events are exposed via `window.__scumm*`.
  - `?game=<id>` — auto-launch a pre-baked or locally staged game
    - Pre-baked: `/game?game=monkey1-demo` (available in deployments,
      declared in `scripts/prebaked-games.json`, fetched at build time)
    - Local dev: `/game?game=<id>` (any game added via `scripts/add-game.sh`)
  - `?mock=1` — use fake telemetry (no fork build needed)
  - `?overlay=1` — start with debug overlay visible
- `/status` — Debug view of snapshot and event history
- `/` redirects to `/briefing`

The Vercel config (`vercel.json`) also redirects the legacy `/routes/*`
paths to the new URLs.

Press `O` on the game page to toggle debug overlay.

## Directory Structure

```
web/
├── index.html       # Tiny redirect: / -> /briefing (local-dev fallback)
├── briefing/        # /briefing — agent briefing page
├── game/            # /game     — ScummVM wasm runtime + upload UI
├── status/          # /status   — debug snapshot + recent events
├── shared/          # JS modules: bridge.js, overlay.js, state-panel.js, mock.js, upload.js
├── public/scummvm/  # Build artifacts (scummvm.js, .wasm) - populated by build script
├── data/            # Engine runtime assets + games/<id>/ - gitignored
└── dev-tools/       # smoke.html for bridge contract testing
scripts/             # bootstrap.sh, build-scummvm.sh, add-game.sh, start-dev.sh
vendor/scummvm-agent/  # Fork repo (separate git) - gitignored
game-data/           # Commercial assets - gitignored
```

## Telemetry Architecture

The fork emits v1 snapshots via `window.__scummPublish()` → `bridge.js` fans out to:
- `window.__scummState` — latest state object
- `#scumm-state` — DOM node with JSON
- `console.debug("[SCUMM_STATE]", ...)` and `"[SCUMM_EVENT]"`
- Overlay (bounding boxes) and state panel

Key state fields: `room`, `ego`, `hover`, `sentence`, `roomObjects[]`, `inventory[]`, `verbs[]`

Coordinates are virtual-screen pixels (`roomWidth × roomHeight`), not canvas pixels.

## Browser Harness

Drive the game from the terminal. Three commands cover everything:

```bash
pnpm browser:open                              # launch Chromium (persists between calls)
pnpm browser:eval -- "<js expression>"         # eval JS on window, get JSON back
pnpm browser:screenshot                        # save PNG to state/
pnpm browser:close                             # kill browser
```

Setup: `pnpm install && npx playwright install chromium` (one-time Chromium download)

### How it works

`browser:eval` runs any JS in the page and returns `{ ok, value }` as JSON. All game interaction is just calling `window.__scumm*` globals through eval:

```bash
# Read state
pnpm browser:eval -- "__scummRead()"

# Do an action
pnpm browser:eval -- "__scummDoSentence({verb:8, objectA:429})"

# Skip dialog text
pnpm browser:eval -- "__scummSkipMessage()"

# Select dialog choice
pnpm browser:eval -- "__scummSelectDialog(0)"

# Get events since cursor
pnpm browser:eval -- "__scummEventsSince(0)"

# Navigate (upload UI)
pnpm browser:eval -- "location.href='/game'"

# Navigate to a pre-staged local game
pnpm browser:eval -- "location.href='/game?game=monkey1'"
```

### Agent play loop

1. `pnpm browser:open` — opens briefing page
2. `pnpm browser:eval -- "location.href='/game?game=monkey1'"` — navigate to game (or `/game` for the upload UI)
3. `pnpm browser:eval -- "__scummRead()"` — read state (room, objects, verbs, inventory, ego)
4. Decide next action from state
5. `pnpm browser:eval -- "__scummDoSentence({verb:V, objectA:A})"` — act
6. `pnpm browser:eval -- "__scummEventsSince(cursor)"` — observe result
7. Repeat from 3

### Window API summary

**Read:** `__scummRead()` returns full state, `__scummEventsSince(cursor)` returns `{events, cursor}`.

**Act:** `__scummDoSentence({verb, objectA, objectB?})` (preferred — atomic, auto-walks), `__scummSelectDialog(index)`, `__scummSkipMessage()`, `__scummWalkTo(x,y)`, `__scummClickAt(x,y)` (last resort).

**Check:** `__scummActionsReady()` — call before first action. Check `state.inputLocked` before each action.

The briefing page at `/briefing` has the full API reference as JSON in `#agent-brief`.

## Important Notes

- Canvas must have `id="canvas"` (SDL3 hardcodes this selector)
- Commercial game assets go in `web/data/games/<id>/` — never commit to Git
- Mock mode (`?mock=1`) emits snapshots with `"mock": true`
