#!/usr/bin/env bash
# vercel-build.sh — Install Emscripten and build the ScummVM fork
# during Vercel's build step. The resulting WASM artifacts land in
# web/public/scummvm/ so the static deployment serves them.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMSDK_DIR="$ROOT/vendor/emsdk"
EMSDK_VERSION="${EMSDK_VERSION:-latest}"

log()  { printf "\033[1;36m[vercel-build]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[vercel-build]\033[0m %s\n" "$*" >&2; }

# ── 1. Install Emscripten SDK ────────────────────────────────────────
if [ -f "$EMSDK_DIR/emsdk" ]; then
  log "emsdk already present (build cache), updating…"
  cd "$EMSDK_DIR"
  git pull || warn "git pull failed, continuing with cached version"
else
  # Remove any leftover broken directory from a previous failed build
  rm -rf "$EMSDK_DIR"
  log "cloning emsdk…"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
  cd "$EMSDK_DIR"
fi
log "installing emsdk ($EMSDK_VERSION)…"
./emsdk install "$EMSDK_VERSION"
./emsdk activate "$EMSDK_VERSION"
source ./emsdk_env.sh
log "emcc version: $(emcc --version | head -1)"

# ── 2. Build ScummVM ─────────────────────────────────────────────────
cd "$ROOT"
log "running build-scummvm.sh…"
./scripts/build-scummvm.sh

# ── 3. Pre-baked games ───────────────────────────────────────────────
# Download the games declared in scripts/prebaked-games.json into
# web/data/games/<id>/ so /game?game=<id> works in the deployment.
# Must run after build-scummvm.sh (needs the fork's index generator and
# the /data tree). Cached by .cache/prebaked-games/ stamp files.
log "running fetch-prebaked-games.sh…"
./scripts/fetch-prebaked-games.sh

log "vercel build complete."
