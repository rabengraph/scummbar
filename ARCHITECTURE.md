# Architecture

## Two-repo model

### Repo 1 — `scummvm` fork (`rabengraph/scummvm`)
A fork of ScummVM. Owns:

- SCUMM engine telemetry collection (`engines/scumm/agent_state.{h,cpp}`)
- C++ to JavaScript bridge for the Emscripten target
  (`engines/scumm/agent_bridge_emscripten.cpp`)
- `--enable-agent-telemetry` configure flag
- Browser build configuration
- The authoritative schema document at `engines/scumm/AGENT_HARNESS.md`

It does **not** own the app shell, homepage, overlays, scripts, or
deployment. Keep this repo narrow and mechanical.

Working branch: **`develop`**. The fork's `master` stays as a
pristine mirror of upstream ScummVM; all POC work lives on
`develop`, which carries the agent-telemetry commits on top of
upstream. The harness's `scripts/build-scummvm.sh` points at
`develop` by default via `SCUMMVM_AGENT_REMOTE` /
`SCUMMVM_AGENT_BRANCH`.

### Repo 2 — `scummbench` (this repo, "ScummBench")
Owns everything the agent sees and everything needed to run the site:

- `/briefing` page with the agent brief (HTML and JSON). `/` redirects here.
- `/game` route hosting the ScummVM wasm runtime + upload UI
- Optional `/status` debug route
- Shared browser modules: `bridge.js`, `overlay.js`, `state-panel.js`,
  `agent-brief.js`, `mock.js`, `upload.js`, `styles.css`
- `mock.js` — fake telemetry gated on `/game?mock=1`, used to
  validate the harness end-to-end without the fork build
- Startup scripts: `bootstrap.sh`, `build-scummvm.sh`, `start-dev.sh`,
  `open-chrome.sh`
- Vercel deployment config (clean URLs + redirects from legacy
  `/routes/*` paths)
- Claude runbook

## Route design

```text
Agent
  -> /briefing
    -> reads mission + operating rules (HTML + #agent-brief JSON)
    -> navigates to /game
      -> upload UI (or auto-launch with ?game=<id> locally)
      -> ScummVM wasm runtime
        -> SCUMM engine telemetry
          -> window.__scummState
          -> #scumm-state JSON node
          -> console events (SCUMM_STATE, SCUMM_EVENT)
          -> optional overlay + state panel
```

`/briefing` is treated as an **agent control page**, not a marketing
homepage. `/game` is the only actual play surface. `/` exists only as a
redirect to `/briefing`.

## Telemetry flow

1. The SCUMM engine in the fork collects a compact snapshot (room,
   ego position, active verb, hover, sentence line, inventory,
   dialog choices, a relevant subset of room objects).
2. The fork serializes this to JSON and publishes it via a C++-to-JS
   bridge (Emscripten).
3. `web/shared/bridge.js` receives the snapshot and updates:
   - `window.__scummState` (latest authoritative state)
   - `#scumm-state` JSON DOM node (inspectable via `document.querySelector`)
   - `console.debug("[SCUMM_STATE]", ...)` and
     `console.debug("[SCUMM_EVENT]", ...)`
   - optional short in-memory history ring for `/status`
4. `overlay.js` draws bounding boxes + labels for objects in the
   current room.
5. `state-panel.js` renders a human-readable summary for debugging.

### State schema (v1)

The canonical definition lives in the fork's
`engines/scumm/AGENT_HARNESS.md` §4. The harness expects this shape:

```jsonc
{
  "schema": 1,                 // bump on breaking changes
  "seq": 1234,                 // monotonic counter across snapshots + events
  "t": 71234567,               // engine millis

  "gameId": 12,                // Scumm::GameID enum
  "gameVersion": 5,            // detection version
  "gameName": "monkey",        // detection id

  "room": 10,
  "roomResource": 10,
  "roomWidth": 320,            // virtual-screen coords
  "roomHeight": 200,

  "ego": {
    "id": 1,
    "room": 10,
    "pos": { "x": 160, "y": 120 },
    "facing": 270,
    "walking": false,
    "costume": 93
  },

  "hover": {
    "objectId": 42,            // 0 if nothing under the cursor
    "objectName": "door",
    "verbId": 3,
    "mouse": { "x": 160, "y": 120 }
  },

  "sentence": {
    "verb": 3,
    "preposition": 2,
    "objectA": 42,
    "objectB": 0,
    "active": true
  },

  "roomObjects": [
    {
      "id": 42, "name": "door",
      "box": { "x": 120, "y": 80, "w": 40, "h": 80 },
      "state": 0, "owner": 0,
      "inInventory": false,
      "untouchable": false
    }
  ],

  "inventory": [
    {
      "id": 7, "name": "rubber chicken with a pulley in the middle",
      "box": { "x": 0, "y": 0, "w": 0, "h": 0 },
      "state": 0, "owner": 1,
      "inInventory": true,
      "untouchable": false
    }
  ],

  "verbs": [
    {
      "slot": 1, "id": 100, "name": "Open",
      "box": { "x": 0, "y": 144, "w": 40, "h": 8 },
      "visible": true
    }
  ]
}
```

Field rules:

- `roomObjects` contains only objects owned by the current room
  (`OF_OWNER_ROOM`). Picked-up items move to `inventory`.
- `inventory` is filtered to items owned by ego (`VAR_EGO`).
- `verbs` lists occupied verb slots only (slot 0 is a sentinel).
  `name` may be empty until the `rtVerb` resource loads; fall back
  to the numeric `id`.
- **Coordinates are virtual-screen pixels** (`roomWidth × roomHeight`),
  not canvas pixels. The overlay scales them to the canvas client
  box.
- Object `box` is best-effort. Good enough for a rough overlay, not
  reliable for pixel-perfect hit testing.
- `walking` is true when any `MF_*` movement flag (except `MF_FROZEN`)
  is set on the ego actor.
- `hover.objectId == 0` means the mouse is not over any object. Same
  for `hover.verbId`.
- The snapshot may grow new top-level keys without bumping `schema`;
  the harness tolerates unknown keys. Field removals or renames will
  bump `schema`, at which point `bridge.js` logs a loud warning.

### Event schema (v1)

Events are small diffs emitted on meaningful state changes, **in
addition to** full snapshots. Envelope:

```jsonc
{
  "kind": 1,                   // see table below
  "seq": 1234,                 // shares the counter with snapshots
  "t": 71234567,
  "payload": { /* kind-specific */ }
}
```

| `kind` | Name               | Payload |
|:---:|---------------------|---|
| 1 | `roomChanged`       | `{ "from": 9, "to": 10, "resource": 10 }` |
| 2 | `hoverChanged`      | `{ "objectId": 42, "objectName": "door", "verbId": 3 }` |
| 3 | `inventoryChanged`  | `{ "count": 5 }` |
| 4 | `sentenceChanged`   | `{ "verb": 3, "objectA": 42, "objectB": 0, "active": true }` |
| 5 | `egoMoved`          | `{ "room": 10, "x": 160, "y": 120, "walking": false }` |
| 6 | `objectStateChanged`| *(reserved)* |
| 7 | `gameReset`         | *(reserved)* |

Kinds 6 and 7 are defined but not currently emitted. `egoMoved` is
only emitted on room change or walk-stop — per-pixel motion is
carried by the rate-capped snapshot stream.

### Cadence

Hybrid model:

- **Snapshots** — rate-limited to ≥100 ms between emissions (~10 Hz).
  Driven by the SCUMM main loop in the fork (`scummLoop()` tail).
- **Events** — emitted immediately when a diff is detected, bounded
  only by the engine's frame rate.
- Snapshots and events share a single `seq` counter so the harness
  can order them reliably.

## Hosting model

- **Local** — primary dev environment. Static server serving `web/`.
- **Hosted** — deployed to Vercel (or any static host). Mostly static:
  HTML, JS, CSS, wasm, runtime assets. No long-running backend is
  assumed.

Privacy for now: no auth, no access control. A hard-to-guess URL
shared with trusted friends. Treat the hosted deployment as
semi-public.

## Asset boundary

- Commercial game assets must not be committed to Git.
- Local development can use local files under `game-data/`.
- Hosted use with commercial assets may create distribution issues.
- Architecture must allow swapping in safer content later.

## Out of scope (for now)

Auth, polished UX, public distribution at scale, CI/CD complexity,
Docker, a generic multi-game framework, database-backed sessions,
permanent telemetry storage, polished saves UI, upstream cleanup,
generalized agent APIs.
