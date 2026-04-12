#!/usr/bin/env bash
# build-scummvm.sh — clone/update the ScummVM fork, build the web
# target, and copy artifacts into the harness.
#
# This script is opinionated about paths but not about emsdk setup. You
# must have `emcc` on PATH (or source emsdk_env.sh) before running.
#
# Flags:
#   --local                Skip git fetch/checkout/pull — build from the
#                          current working tree as-is. Useful when you have
#                          local edits in vendor/scummvm-agent/.
#
# Env vars:
#   SCUMMVM_AGENT_REMOTE   git remote to clone
#                          (default: https://github.com/rabengraph/scummvm.git)
#   SCUMMVM_AGENT_BRANCH   branch to build
#                          (default: develop — carries the agent-
#                          telemetry commits on top of upstream master)
#
# See the fork's engines/scumm/AGENT_HARNESS.md for the full contract.

set -euo pipefail

LOCAL=false
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL=true ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$ROOT/vendor"
SCUMMVM_DIR="$VENDOR_DIR/scummvm-agent"
OUTPUT_DIR="$ROOT/web/public/scummvm"
# The fork hardcodes DATA_PATH="/data" at compile time, so the engine
# fetches its GUI theme, engine-data, gui-icons, and game files from
# absolute /data/* URLs at runtime. Our dev server roots at web/, so
# the data tree has to live at web/data/.
DATA_OUTPUT_DIR="$ROOT/web/data"

REMOTE="${SCUMMVM_AGENT_REMOTE:-https://github.com/rabengraph/scummvm.git}"
BRANCH="${SCUMMVM_AGENT_BRANCH:-develop}"

log()  { printf "\033[1;36m[build-scummvm]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[build-scummvm]\033[0m %s\n" "$*" >&2; }
err()  { printf "\033[1;31m[build-scummvm]\033[0m %s\n" "$*" >&2; }

if ! command -v emcc >/dev/null 2>&1; then
  err "emcc not found on PATH. Activate emsdk first, e.g.:"
  err "  source /path/to/emsdk/emsdk_env.sh"
  exit 1
fi

mkdir -p "$VENDOR_DIR" "$OUTPUT_DIR"

if [ "$LOCAL" = true ]; then
  if [ ! -d "$SCUMMVM_DIR" ]; then
    err "--local specified but $SCUMMVM_DIR does not exist. Run without --local first."
    exit 1
  fi
  log "building from local working tree (skipping git fetch/pull)"
  cd "$SCUMMVM_DIR"
else
  if [ ! -d "$SCUMMVM_DIR/.git" ]; then
    log "cloning $REMOTE into $SCUMMVM_DIR"
    git clone "$REMOTE" "$SCUMMVM_DIR"
  fi

  cd "$SCUMMVM_DIR"

  log "fetching origin…"
  git fetch origin

  log "checking out $BRANCH"
  git checkout "$BRANCH"
  git pull --ff-only || warn "could not fast-forward; continuing with local state"
fi

# The fork is responsible for knowing how to build its own web target.
# We prefer a repo-local helper if one exists. Otherwise we fall back
# to a plain emconfigure/emmake flow suitable for a minimal SCUMM-only
# build. Adjust here once the fork stabilizes.

if [ -x "./scripts/build-web.sh" ]; then
  log "using fork's scripts/build-web.sh"
  ./scripts/build-web.sh
elif [ -x "./build-web.sh" ]; then
  log "using fork's ./build-web.sh"
  ./build-web.sh
else
  log "no fork-provided build script found; trying a minimal emconfigure flow"
  emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --enable-debug \
    --disable-all-engines \
    --enable-engine=scumm \
    --enable-agent-telemetry
  emmake make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
  # dist-emscripten assembles everything the engine fetches at runtime
  # (themes, engine-data, gui-icons, per-folder index.json) under
  # build-emscripten/data/. Without this, the engine can't even render
  # its launcher because the GUI theme is missing.
  log "running dist-emscripten to assemble the /data tree"
  emmake make dist-emscripten
fi

log "copying artifacts into $OUTPUT_DIR"
# Expected fork outputs. Adjust to match the real filenames once known.
CANDIDATES=(
  "scummvm.js"
  "scummvm.wasm"
  "scummvm.data"
  "scummvm.html"
  "dist/web/scummvm.js"
  "dist/web/scummvm.wasm"
  "dist/web/scummvm.data"
)

copied=0
for rel in "${CANDIDATES[@]}"; do
  if [ -f "$SCUMMVM_DIR/$rel" ]; then
    cp -v "$SCUMMVM_DIR/$rel" "$OUTPUT_DIR/"
    copied=$((copied + 1))
  fi
done

if [ "$copied" -eq 0 ]; then
  err "no build artifacts found to copy. Check the fork's build output."
  err "Expected one of: ${CANDIDATES[*]}"
  exit 2
fi

log "wrote $copied file(s) to $OUTPUT_DIR"

# Mirror the /data tree into the harness so the dev server can serve
# it at /data/*. We preserve anything already under web/data/games/
# (user-added game drops) by merging rather than nuking the dir.
if [ -d "$SCUMMVM_DIR/build-emscripten/data" ]; then
  log "syncing data tree into $DATA_OUTPUT_DIR"
  mkdir -p "$DATA_OUTPUT_DIR"
  # Copy everything except the games/ subdir outright. We'll handle
  # games/ specially so user-placed game folders aren't wiped.
  ( cd "$SCUMMVM_DIR/build-emscripten/data" && \
    find . -mindepth 1 -maxdepth 1 ! -name games -print0 | \
    xargs -0 -I{} cp -R {} "$DATA_OUTPUT_DIR/" )
  mkdir -p "$DATA_OUTPUT_DIR/games"
  # Only copy the fresh games/index.json if we don't already have a
  # richer one generated by add-game (see scripts/add-game.sh).
  if [ ! -f "$DATA_OUTPUT_DIR/games/index.json" ] && \
     [ -f "$SCUMMVM_DIR/build-emscripten/data/games/index.json" ]; then
    cp "$SCUMMVM_DIR/build-emscripten/data/games/index.json" \
       "$DATA_OUTPUT_DIR/games/index.json"
  fi
  log "data tree ready at $DATA_OUTPUT_DIR"
else
  warn "no build-emscripten/data/ found; the engine will fail to fetch its GUI theme"
  warn "re-run ./scripts/build-scummvm.sh after a successful dist-emscripten build"
fi

log "done."
