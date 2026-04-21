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

# ── Cache diagnostic helper ──────────────────────────────────────────
# Print the state of each build cache directory. Emitted before and
# after the build so Vercel logs make cache behaviour easy to verify.
# (Follow-up bump: triggering a second build on the same branch to
# confirm emsdk + scummvm-build caches are restored and we skip the
# 7-min compile.)
cache_status() {
  local label="$1"
  log "cache status ($label):"
  for path in \
      "$VERCEL_CACHE/emsdk" \
      "$VERCEL_CACHE/scummvm-agent" \
      "$VERCEL_CACHE/scummvm-build" \
      "$ROOT/.cache/prebaked-games"; do
    if [ -e "$path" ]; then
      local size
      size="$(du -sh "$path" 2>/dev/null | awk '{print $1}')"
      local entries=""
      if [ -d "$path" ]; then
        entries=" ($(find "$path" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l) entries)"
      fi
      log "  present: $path — $size$entries"
    else
      log "  missing: $path"
    fi
  done
}

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

cache_status "before build"

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
# Pre-clone the fork shallow. A full clone of rabengraph/scummvm
# takes ~3 min because the tree carries years of ScummVM upstream
# history we don't need to build. --depth 1 --branch develop drops
# that to ~30 s. build-scummvm.sh's own clone step is skipped when
# .git already exists; its git fetch/checkout/pull --ff-only steps
# all work on a shallow repo.
SCUMMVM_DIR="$ROOT/vendor/scummvm-agent"
SCUMMVM_REMOTE="${SCUMMVM_AGENT_REMOTE:-https://github.com/rabengraph/scummvm.git}"
SCUMMVM_BRANCH="${SCUMMVM_AGENT_BRANCH:-develop}"
if [ ! -d "$SCUMMVM_DIR/.git" ]; then
  log "shallow-cloning $SCUMMVM_REMOTE (branch: $SCUMMVM_BRANCH)…"
  git clone --depth 1 --branch "$SCUMMVM_BRANCH" --single-branch \
    "$SCUMMVM_REMOTE" "$SCUMMVM_DIR"
fi

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

cache_status "after build, pre-prune"

# ── 4. Prune caches to fit Vercel's 1.5 GB limit ─────────────────────
# Without this, the cache snapshot exceeds the cap and Vercel
# invalidates it, so every build starts cold.
#
#   scummvm-agent: the fork checkout + .git is ~2.7 GB even after
#                  `git clean -fdX`, so caching it isn't viable on the
#                  1.5 GB plan. We drop the whole dir and re-clone on
#                  the next build (~3 min); the scummvm-build artifact
#                  cache still skips the 7-min compile, which is the
#                  bigger win.
#   emsdk/downloads: installer tarballs already unpacked into
#                  upstream/ and node/. Safe to drop; emsdk won't
#                  re-download on subsequent `emsdk install` calls as
#                  long as the activated tools remain.
log "pruning caches before Vercel snapshots them…"
rm -rf "$VERCEL_CACHE/scummvm-agent"
rm -rf "$EMSDK_DIR/downloads"

cache_status "after build, post-prune"

log "vercel build complete."
