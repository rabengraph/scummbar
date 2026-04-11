# Runbook — local setup from zero

This runbook takes a fresh machine and walks it through everything
needed to get the agent-game-harness running a real SCUMM game in a
browser tab, with the v1 telemetry bridge streaming live state into
the harness UI. It's the path we actually followed, written up after
the fact — every step below has been exercised end-to-end.

If something here disagrees with reality, trust the code. This doc is
a map; the scripts are the territory.

## What you end up with

- `http://127.0.0.1:5173/routes/game.html?game=monkey1` running the
  real Emscripten ScummVM fork, rendering Monkey Island (or whatever
  SCUMM game you dropped in).
- The right-hand state panel updating live (room, ego position,
  verbs, roomObjects, hover, inventory).
- `window.__scummState` on the page populated with the fork's v1
  snapshot schema — ready for an agent to read and act on.
- A mock path (`?mock=1`) and a smoke test page
  (`/dev-tools/smoke.html`) for dev work without a full fork build.

## Layout

Two repos are in play. They're independent, and you can clone them in
either order, but the harness expects the fork to be vendored inside
it at `vendor/scummvm-agent/`.

```
agent-game-harness/            <- this repo, the browser harness
├── scripts/
│   ├── build-scummvm.sh       <- clones + builds the fork, copies artifacts
│   └── add-game.sh            <- drops a game into web/data/games/<id>/
├── web/
│   ├── routes/game.html       <- the live /game page (boots scummvm.js)
│   ├── shared/                <- bridge.js, overlay.js, state-panel.js, mock.js
│   ├── public/scummvm/        <- build output lands here (scummvm.js/.wasm)
│   └── data/                  <- served as /data/* — engine reads from here
│       ├── index.json         <- written by make dist-emscripten
│       ├── gui-icons/         <- GUI theme, shaders, translations, etc.
│       └── games/<id>/        <- your game files, per-ID
└── vendor/scummvm-agent/      <- the fork (gitignored, cloned by the script)
```

The second repo is the ScummVM fork:

```
https://github.com/rabengraph/scummvm.git
branch: claude/scummvm-agent-harness-DKVxd
```

The fork adds the telemetry bridge (see its
`engines/scumm/AGENT_HARNESS.md`) and tweaks a few backend files so
the Emscripten build can live-stream room state to JS.

## Prerequisites

Install these first. Versions are what the harness was developed
against — newer is usually fine.

### Node.js via `nvm`

The harness pins Node through `corepack` + `pnpm`. The easiest way to
get the exact pinned version is `nvm use` (falls back to installing
the version listed in `.nvmrc`).

```bash
# Install nvm if you don't have it
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# Reopen the shell, then:
cd agent-game-harness
nvm install        # reads .nvmrc
corepack enable    # makes pnpm available without a separate install
```

### emsdk (Emscripten)

The fork's web target compiles with Emscripten. You need `emcc` on
`PATH` before `build-scummvm.sh` will run.

```bash
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh    # must be re-sourced in every new shell
emcc --version           # sanity check
```

The fork was built against emsdk 4.x. If you have something older
and the build fails on SDL3-related symbols, upgrade emsdk first.

### Build dependencies for the SCUMM native pieces

The fork's `./configure` step needs the usual autotools-ish toolchain
plus a few codecs/libraries that the SCUMM engine links against
(FluidSynth for MIDI, Freetype, etc.). On macOS:

```bash
brew install autoconf automake libtool pkg-config \
             fluidsynth libpng libjpeg freetype mpg123
```

On Debian/Ubuntu the apt equivalents work; grab whatever your distro
calls `libfluidsynth-dev`, `libfreetype-dev`, `libpng-dev`, etc.

### Git over SSH (optional but recommended)

The fork's remote is SSH-friendly. If you hit a password prompt when
pushing to the fork, you're on the HTTPS URL. Switch to SSH:

```bash
cd vendor/scummvm-agent
git remote set-url origin git@github.com:rabengraph/scummvm.git
```

You can also tell `build-scummvm.sh` to clone via SSH from day one:

```bash
export SCUMMVM_AGENT_REMOTE=git@github.com:rabengraph/scummvm.git
```

## Step 1 — clone the harness and install JS deps

```bash
git clone git@github.com:rabengraph/agent-game-harness.git
cd agent-game-harness
nvm use
corepack enable
pnpm install
```

Quick sanity check: the mock path should work before you build the
fork. Run the dev server, open `/game?mock=1`, and confirm the state
panel ticks and the overlay draws boxes on the fake room.

```bash
pnpm dev
# -> http://127.0.0.1:5173/routes/game.html?mock=1
```

If the mock doesn't animate, fix that before touching the fork —
it's usually a missed `pnpm install` or a stale dev server on
another port.

## Step 2 — build the ScummVM fork

This step does three things:

1. Clones the fork into `vendor/scummvm-agent/` (or updates it if
   already present).
2. Runs `emconfigure ./configure` and `emmake make` against the
   SCUMM engine with `--enable-agent-telemetry`.
3. Runs `make dist-emscripten` to assemble the data tree (GUI theme,
   shaders, translations, per-folder `index.json`) and syncs it into
   `web/data/`.

```bash
source ~/emsdk/emsdk_env.sh   # emcc must be on PATH
./scripts/build-scummvm.sh
```

Expected tail of the output:

```
[build-scummvm] copying artifacts into .../web/public/scummvm
[build-scummvm] wrote 3 file(s) to .../web/public/scummvm
[build-scummvm] syncing data tree into .../web/data
[build-scummvm] data tree ready at .../web/data
[build-scummvm] done.
```

After this, `web/public/scummvm/` holds `scummvm.js` and
`scummvm.wasm`, and `web/data/` holds the engine's runtime assets.

### If the fork compile fails

- `FILE` macro conflict in `agent_bridge_emscripten.cpp`: this is
  the `common/forbidden.h` guard biting a file that has to include
  `<emscripten.h>`. The fix is already committed to the fork (commit
  `84cf5626`, `#define FORBIDDEN_SYMBOL_ALLOW_ALL` at the top of
  that file). If you're on an older branch, cherry-pick that commit
  or rebase onto the tip of `claude/scummvm-agent-harness-DKVxd`.
- `_emscripten_webgl_*` link errors: emsdk is too old. Upgrade to
  the 4.x series.
- No `dist-emscripten` target: fork is too old. Update the branch.

## Step 3 — drop in a game

The fork's Emscripten build uses an HTTP filesystem layer: at
runtime, every filesystem read under `/data/*` is turned into a
`fetch()` against the dev server. So adding a game means:

1. Put its files under `web/data/games/<id>/`.
2. Regenerate the per-folder `index.json` files the HTTP-FS layer
   uses to enumerate directories.

`scripts/add-game.sh` does both for you. It accepts either a zip or
a directory:

```bash
# from a directory (most common — pointed at an existing CD rip)
./scripts/add-game.sh ~/games/MonkeyIsland/MONKEY1 monkey1

# from a zip
./scripts/add-game.sh ~/Downloads/loom-demo.zip loom
```

Important: point the script at the **inner game directory**, not the
CD root. If you point it at a folder that also has `README.EXE`,
`AUTORUN.INF`, `DIRECTX/`, `MONKEY2/`, etc., the engine will waste
time sniffing every unrelated file, and in edge cases detection can
land on the wrong game. Detection still works with a messy root for
Monkey Island 1, but the clean subfolder approach is the default.

The game ID must be kebab-case (`monkey1`, `loom`, `indy3-talkie`).
That ID is what you pass as `?game=<id>` in the URL, and it's what
the engine sees as `--path=/data/games/<id>`.

On success you'll see:

```
[add-game] placed 58 file(s) under .../web/data/games/monkey1
[add-game] regenerating index.json tree under .../web/data
[add-game] done. Launch with:
[add-game]   http://127.0.0.1:5173/routes/game.html?game=monkey1
```

You can add as many games as you want — they coexist, and
`build-scummvm.sh` won't wipe them when you rebuild the fork.

### Where to get games

ScummVM publishes a handful of freeware demos on their website
(Beneath a Steel Sky, Flight of the Amazon Queen, several Sierra and
LucasArts demos). For full games you need to provide your own
legally-acquired copies — GOG is the easiest route. The harness and
the fork both refuse to ship any copyrighted data; `web/data/` is
gitignored for this reason.

## Step 4 — run it

Start the dev server if it's not already running:

```bash
pnpm dev
```

Then open:

```
http://127.0.0.1:5173/routes/game.html?game=monkey1
```

You should see:

- The game render in the main canvas.
- The right-hand state panel showing `schema 1 seq=<N>`,
  `game monkey v5`, current `room`, `ego`, verb list, hover, and
  roomObjects count.
- `window.__scummState` on the page populated with the v1 snapshot
  (check it from DevTools: `window.__scummState`).

Useful URL params:

- `?game=<id>` — launch the game directly (skips the fork's GUI
  launcher). Omit it to get the launcher and pick a game manually.
- `?overlay=1` — start with the debug overlay visible (bounding
  boxes and labels for every `roomObjects[]` entry).
- `?mock=1` — use the JS mock instead of the real fork. Handy when
  the fork isn't built yet or you're iterating on the bridge.

Keyboard shortcuts on `/game`:

- `O` — toggle the debug overlay on and off at any time.

## Step 5 — smoke test the bridge contract

`web/dev-tools/smoke.html` is a standalone page that subscribes to
`window.__scummPublish` and pretty-prints every snapshot it sees,
highlighting anything that doesn't match the v1 schema. Run it
against either mode:

- Mock: `http://127.0.0.1:5173/dev-tools/smoke.html?mock=1`
- Real: open `/game?game=monkey1` in one tab, open
  `/dev-tools/smoke.html` in another — they share `window` via the
  live reload, so you can sanity-check the real fork's output
  against the schema the harness expects.

Useful when you touch anything in the bridge, schema, or state
panel.

## Common problems and what caused them

### `WARNING: SDL_GL_CreateContext failed: Could not create webgl context!`

The fork's generated `scummvm.js` hardcodes a
`document.querySelector("#canvas")` inside its `findCanvasEventTarget`
helper, and that's what SDL3's Emscripten backend calls to find a
canvas for the WebGL context. If your canvas has any other id (the
pre-fix harness used `#scumm-canvas`), the selector returns `null`,
`SDL_GL_CreateContext` fails three times, and the engine exits with
`program exited (with status: 0)`.

Fix: the canvas in `game.html` must have `id="canvas"`. This is
already done in the committed code — if you've edited it, make sure
you haven't renamed it back. Setting `Module.canvas = …` is not
sufficient; SDL3 ignores `Module.canvas` in its context creation
path.

### `index.lock` / `HEAD.lock` on git operations

Stale git locks from an interrupted operation. Delete them and
retry:

```bash
rm -f .git/index.lock .git/HEAD.lock
```

### Engine fetches `README.EXE`, `AUTORUN.INF`, `MONKEYTG.DOC`, …

You pointed `add-game.sh` at a CD root instead of the inner game
directory. Detection tries to sniff every file in the folder. For
Monkey Island, point at the `MONKEY1/` subdirectory, not the CD
root. Re-run `add-game.sh` with the correct path — it nukes the
existing `web/data/games/<id>/` before placing the new files.

### `git push` prompts for username/password

Your fork remote is HTTPS. Switch to SSH (see Prerequisites).

### `EADDRINUSE: 127.0.0.1:5173`

A previous `pnpm dev` is still running. Find it and kill it:

```bash
kill $(lsof -nP -iTCP:5173 -sTCP:LISTEN -t)
```

Or just reuse the running server — it's the same dev server you'd
start anyway.

### Mock path works, real path shows "ScummVM runtime not built"

`web/public/scummvm/scummvm.js` is missing or failed to load. Re-run
`./scripts/build-scummvm.sh` and check its output for errors.
`scripts/build-scummvm.sh` logs which artifacts it copied at the
end — if the count is 0 it will exit non-zero and tell you.

### `WARNING: Engine plugin for SCI not present`

Benign. The fork's `--disable-all-engines --enable-engine=scumm`
build leaves SCI, Wintermute, and others out. The warnings are just
ScummVM's fallback-detection path noticing the plugin's gone. Ignore
them.

## Architecture in one paragraph

The harness is a static web app served by a tiny Node dev server out
of `web/`. It loads the fork's Emscripten build (`scummvm.js` +
`scummvm.wasm`) plus a small JS bridge (`web/shared/bridge.js`) that
exposes `window.__scummPublish(snapshot)` for the engine to call.
The fork's `--enable-agent-telemetry` adds a SCUMM agent bridge
(`engines/scumm/agent_bridge_emscripten.cpp`) that builds v1
snapshots from live engine state every frame and hands them to
`__scummPublish`. The harness then fans snapshots out to the state
panel, overlay, and `window.__scummState`. Games are served as files
over HTTP through the fork's `HTTPFilesystemNode`, which turns
`/data/*` reads into `fetch("/data/*")` calls — no preload, no
IndexedDB hydration for game files (the engine still uses IDBFS for
`scummvm.ini` so settings persist).

The full v1 schema lives in the fork at
`engines/scumm/AGENT_HARNESS.md`.

## Where to look when things break

- Fork telemetry: `vendor/scummvm-agent/engines/scumm/AGENT_HARNESS.md`
- Bridge JS: `web/shared/bridge.js`
- State panel: `web/shared/state-panel.js`
- Overlay (debug boxes): `web/shared/overlay.js`
- Mock telemetry: `web/shared/mock.js`
- Build script: `scripts/build-scummvm.sh`
- Add-game script: `scripts/add-game.sh`
- The page you're actually loading: `web/routes/game.html`

Happy agenting.
