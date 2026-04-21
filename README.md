# ScummBench

Harness for ScummVM games. Agent-first browser harness for running ScummVM
games with symbolic state exposed to AI agents (e.g. Claude).

This repo is the **app shell and deployment target** for an AI-agent proof
of concept. It pairs with a ScummVM fork (`rabengraph/scummvm`, branch
`develop`) that adds telemetry hooks into the SCUMM engine.

The central question this POC tries to answer:

> Does exposing symbolic SCUMM state in-browser materially improve an
> agent's ability to play the game compared to pure vision?

[▶️ Demo, Monkey Island played with Claude Code](https://github.com/user-attachments/assets/93ca4e5c-ebd4-4981-bdaf-a3b48d802b82)

## Repo split

- **`rabengraph/scummvm`** (fork, branch `develop`) — SCUMM engine
  telemetry hooks, C++ to JavaScript bridge, Emscripten target
  tweaks. The fork's `master` stays as a pristine mirror of upstream
  ScummVM; all POC work lives on `develop`. Canonical schema doc:
  `engines/scumm/AGENT_HARNESS.md`.
- **`scummbench`** (this repo) — briefing page, `/game` route,
  overlays, state panel, mock mode, startup scripts, hosting config,
  and the Claude runbook.

## Quick start

```bash
./scripts/bootstrap.sh        # install Node (via nvm), pnpm, and deps
./scripts/build-scummvm.sh    # clone + build the fork, copy artifacts into web/public/scummvm
./scripts/start-dev.sh        # start a static dev server and print routes
./scripts/open-chrome.sh      # open the homepage in a fresh Chrome profile
```

Or:

```bash
pnpm start
```

> **Note:** If you use [nvm](https://github.com/nvm-sh/nvm), bootstrap will
> automatically install and use the Node version from `.nvmrc`.

### Without the fork build

Use mock telemetry:

```
http://127.0.0.1:5173/game?mock=1
```

`?mock=1` activates `web/shared/mock.js`, which drives a small fake
adventure (3 rooms, verbs, inventory, clickable objects) that emits
the same v1 schema as the real fork. Useful for harness-only
development. Mock snapshots and events carry `"mock": true` so agents
can distinguish them.

## Routes

- `/briefing` — agent briefing page. Tells the agent what this site is,
  where the game lives, and how to inspect symbolic state. Also contains
  a machine-readable `#agent-brief` JSON blob. (`/` redirects here.)
- `/game` — the actual playable game. Default state is the upload UI;
  pre-staged local games skip it via `/game?game=<id>`. Mounts the
  ScummVM wasm runtime and exposes telemetry via `window.__scummState`,
  `#scumm-state`, console tags, overlay boxes, and a debug state panel.
- `/status` — optional debug view of the latest snapshot and event
  history. Useful during development.

The Vercel config also redirects the legacy `/routes/*` paths to the new
URLs (see `vercel.json`).

## Game files

Commercial game assets **must not** be committed to Git. Put your
legally owned game files in:

```text
game-data/monkey1/
```

They stay local only. `game-data/*` is gitignored by default.

## Documentation

- `ARCHITECTURE.md` — two-repo model, route design, telemetry flow,
  hosting model.
- `TASKS.md` — implementation checklist.
- `claude/runbook.md` — instructions for the agent / operator.

## Status

This is a narrow proof of concept. See `TASKS.md` for the current
milestone. Auth, multi-game support, persistent saves, and polished UX
are explicitly out of scope.
