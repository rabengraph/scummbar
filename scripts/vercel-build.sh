#!/usr/bin/env bash
# vercel-build.sh — Install Emscripten and build the ScummVM fork
# during Vercel's build step. The resulting WASM artifacts land in
# web/public/scummvm/ so the static deployment serves them.
#
# Cache strategy: Vercel's build cache for non-framework projects only
# persists node_modules/ between builds (not .cache/ or vendor/). So we
# store the three expensive build caches — emsdk, the fork checkout, and
# the ScummVM build artifacts — under node_modules/.cache/. Paths that
# other scripts hardcode (vendor/scummvm-agent, .cache/scummvm-build)
# are symlinked in so local dev keeps working unchanged.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERCEL_CACHE="$ROOT/node_modules/.cache"
EMSDK_DIR="$VERCEL_CACHE/emsdk"
EMSDK_VERSION="${EMSDK_VERSION:-latest}"

log()  { printf "\033[1;36m[vercel-build]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[vercel-build]\033[0m %s\n" "$*" >&2; }

# ── 0. Relocate caches under node_modules/.cache ─────────────────────
mkdir -p "$VERCEL_CACHE" "$ROOT/vendor" "$ROOT/.cache"
link_into_cache() {
  local link_path="$1"
  local cache_path="$2"
  mkdir -p "$cache_path"
  if [ -e "$link_path" ] && [ ! -L "$link_path" ]; then
    rm -rf "$link_path"
  fi
  ln -sfn "$cache_path" "$link_path"
}
link_into_cache "$ROOT/vendor/scummvm-agent" "$VERCEL_CACHE/scummvm-agent"
link_into_cache "$ROOT/.cache/scummvm-build" "$VERCEL_CACHE/scummvm-build"

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
