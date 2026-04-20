#!/usr/bin/env bash
# fetch-prebaked-games.sh — download games declared in
# scripts/prebaked-games.json and drop them under web/data/games/<id>/
# so the runtime can launch them via /game?game=<id>.
#
# Safe to re-run: a per-game stamp file under .cache/prebaked-games/
# captures the source URL (and sha256 if given). When the stamp matches
# on the next run we skip the download, which makes this friendly to
# Vercel's build cache.
#
# Required layout when this script runs:
#   - web/data/                     exists (populated by build-scummvm.sh)
#   - vendor/scummvm-agent/         cloned (we call its index-generator)
#
# Env vars:
#   PREBAKED_GAMES_MANIFEST         override path to manifest JSON
#
# Exits 0 with a warning if the manifest is missing, so the step is a
# no-op on branches that haven't configured any pre-baked games.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="${PREBAKED_GAMES_MANIFEST:-$ROOT/scripts/prebaked-games.json}"
DATA_DIR="$ROOT/web/data"
GAMES_DIR="$DATA_DIR/games"
INDEX_SCRIPT="$ROOT/vendor/scummvm-agent/dists/emscripten/build-make_http_index.py"
CACHE_DIR="$ROOT/.cache/prebaked-games"

log()  { printf "\033[1;36m[fetch-games]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[fetch-games]\033[0m %s\n" "$*" >&2; }
err()  { printf "\033[1;31m[fetch-games]\033[0m %s\n" "$*" >&2; }

if [ ! -f "$MANIFEST" ]; then
  warn "no manifest at $MANIFEST — nothing to do"
  exit 0
fi

if [ ! -d "$DATA_DIR" ]; then
  err "$DATA_DIR missing — run build-scummvm.sh first so the /data tree exists"
  exit 1
fi

if [ ! -f "$INDEX_SCRIPT" ]; then
  err "fork not checked out: $INDEX_SCRIPT not found"
  err "  run build-scummvm.sh first so vendor/scummvm-agent/ is cloned"
  exit 1
fi

mkdir -p "$GAMES_DIR" "$CACHE_DIR"

# Read manifest rows into a while-loop via process substitution so the
# loop body runs in the main shell (error handling / set -e stay intact).
fetched_any=0
while IFS=$'\t' read -r id url sha; do
  [ -z "$id" ] && continue
  dest="$GAMES_DIR/$id"
  stamp="$CACHE_DIR/$id.stamp"
  # Stamp value mixes url + sha256 so either changing invalidates cache.
  stamp_value="$url"
  [ -n "$sha" ] && stamp_value="$url|$sha"

  if [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ] && \
     [ -f "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$stamp_value" ]; then
    log "$id: cached, skipping"
    continue
  fi

  log "$id: (re)fetching"
  rm -rf "$dest"
  mkdir -p "$dest"
  tmp="$(mktemp -d)"
  zip="$tmp/game.zip"

  log "$id: downloading $url"
  if ! curl -fsSL -o "$zip" "$url"; then
    err "$id: download failed from $url"
    rm -rf "$tmp" "$dest"
    exit 1
  fi

  if [ -n "$sha" ]; then
    log "$id: verifying sha256"
    actual="$(sha256sum "$zip" | awk '{print $1}')"
    if [ "$actual" != "$sha" ]; then
      err "$id: sha256 mismatch"
      err "  expected: $sha"
      err "  actual:   $actual"
      rm -rf "$tmp" "$dest"
      exit 1
    fi
  fi

  log "$id: unzipping into $dest"
  unzip -q -o "$zip" -d "$dest"

  # Some zips wrap everything in a single top-level dir — flatten that
  # so game files sit directly under $dest (same logic as add-game.sh).
  shopt -s nullglob dotglob
  entries=("$dest"/*)
  shopt -u nullglob dotglob
  if [ "${#entries[@]}" -eq 1 ] && [ -d "${entries[0]}" ]; then
    inner="${entries[0]}"
    log "$id: flattening $(basename "$inner")"
    ( cd "$inner" && find . -mindepth 1 -maxdepth 1 -print0 | \
      xargs -0 -I{} mv {} "$dest/" )
    rmdir "$inner"
  fi

  printf '%s' "$stamp_value" > "$stamp"
  rm -rf "$tmp"
  fetched_any=1
  log "$id: done ($(find "$dest" -type f | wc -l | tr -d ' ') files)"
done < <(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for g in data.get("games", []):
    print("\t".join([g["id"], g["url"], g.get("sha256") or ""]))
' "$MANIFEST")

log "regenerating index.json tree under $DATA_DIR"
python3 "$INDEX_SCRIPT" "$DATA_DIR"

log "prebaked games ready."
