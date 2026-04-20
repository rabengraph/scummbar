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
# Build cache — a full ScummVM emscripten build takes ~7 min but the
# fork mostly doesn't change between runs. We cache final artifacts
# keyed on fork SHA + emcc version + this script's hash. The cache
# dir is gitignored (.cache/ is Vercel-build-cache friendly).
BUILD_CACHE_DIR="$ROOT/.cache/scummvm-build"
BUILD_CACHE_KEEP="${BUILD_CACHE_KEEP:-2}"

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

# ── Cache key ────────────────────────────────────────────────────────
# Compute a content-addressable key for the final build artifacts.
# Inputs: fork HEAD SHA (+ dirty-tree hash if applicable), emcc version,
# and the hash of this script (which controls how the build is invoked).
SCUMMVM_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
DIRTY_SUFFIX=""
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
  # Hash the tree delta: tracked diff + untracked file contents. This
  # keeps --local rebuilds cache-coherent when iterating on fork edits.
  dirty_hash="$(
    {
      git diff HEAD 2>/dev/null || true
      git ls-files --others --exclude-standard -z 2>/dev/null \
        | xargs -0 cat 2>/dev/null || true
    } | sha256sum | awk '{print $1}' | cut -c1-12
  )"
  DIRTY_SUFFIX="-dirty-${dirty_hash}"
  log "working tree dirty; cache key includes tree hash ${dirty_hash}"
fi
EMCC_HASH="$(emcc --version | head -1 | sha256sum | awk '{print $1}' | cut -c1-12)"
SCRIPT_HASH="$(sha256sum "$ROOT/scripts/build-scummvm.sh" | awk '{print $1}' | cut -c1-12)"
CACHE_KEY="${SCUMMVM_SHA}${DIRTY_SUFFIX}-emcc-${EMCC_HASH}-script-${SCRIPT_HASH}"
CACHE_ENTRY="$BUILD_CACHE_DIR/$CACHE_KEY"

log "cache key: $CACHE_KEY"

# ── Cache restore ────────────────────────────────────────────────────
# If a prior build already produced artifacts for this exact key, copy
# them into the harness and skip the 7-minute compile.
if [ -f "$CACHE_ENTRY/.stamp" ] && [ -d "$CACHE_ENTRY/public" ]; then
  log "cache hit — restoring artifacts from $CACHE_ENTRY"
  mkdir -p "$OUTPUT_DIR"
  cp -R "$CACHE_ENTRY/public/." "$OUTPUT_DIR/"
  if [ -d "$CACHE_ENTRY/data" ]; then
    mkdir -p "$DATA_OUTPUT_DIR/games"
    # Restore the /data tree minus games/ (user-added game folders live
    # there; leave them alone).
    ( cd "$CACHE_ENTRY/data" && \
      find . -mindepth 1 -maxdepth 1 ! -name games -print0 | \
      xargs -0 -I{} cp -R {} "$DATA_OUTPUT_DIR/" )
    if [ ! -f "$DATA_OUTPUT_DIR/games/index.json" ] && \
       [ -f "$CACHE_ENTRY/data/games/index.json" ]; then
      cp "$CACHE_ENTRY/data/games/index.json" \
         "$DATA_OUTPUT_DIR/games/index.json"
    fi
  fi
  # Bump mtime so recent-first pruning treats this as freshly used.
  touch "$CACHE_ENTRY/.stamp"
  log "restored from cache; skipped build."
  exit 0
fi

log "cache miss — running full build"

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

# ── Cache populate ───────────────────────────────────────────────────
# Snapshot the artifacts we just produced so the next run with the same
# inputs can skip the build entirely.
log "populating build cache at $CACHE_ENTRY"
rm -rf "$CACHE_ENTRY"
mkdir -p "$CACHE_ENTRY/public"
cp -R "$OUTPUT_DIR/." "$CACHE_ENTRY/public/"
if [ -d "$SCUMMVM_DIR/build-emscripten/data" ]; then
  mkdir -p "$CACHE_ENTRY/data"
  # Cache everything except games/ (user content, large, regenerated
  # by fetch-prebaked-games.sh / add-game.sh).
  ( cd "$SCUMMVM_DIR/build-emscripten/data" && \
    find . -mindepth 1 -maxdepth 1 ! -name games -print0 | \
    xargs -0 -I{} cp -R {} "$CACHE_ENTRY/data/" )
  # Keep the fork's stock games/index.json (used as a fallback).
  if [ -f "$SCUMMVM_DIR/build-emscripten/data/games/index.json" ]; then
    mkdir -p "$CACHE_ENTRY/data/games"
    cp "$SCUMMVM_DIR/build-emscripten/data/games/index.json" \
       "$CACHE_ENTRY/data/games/index.json"
  fi
fi
touch "$CACHE_ENTRY/.stamp"

# Prune old cache entries; keep the N most recently touched. Small N
# keeps Vercel's 1 GB build cache honest — each entry is ~100 MB.
if [ -d "$BUILD_CACHE_DIR" ]; then
  mapfile -t entries < <(ls -1t "$BUILD_CACHE_DIR" 2>/dev/null || true)
  if [ "${#entries[@]}" -gt "$BUILD_CACHE_KEEP" ]; then
    for old in "${entries[@]:$BUILD_CACHE_KEEP}"; do
      log "pruning old cache entry: $old"
      rm -rf "${BUILD_CACHE_DIR:?}/$old"
    done
  fi
fi

log "done."
