#!/usr/bin/env bash
# beadbox-pqn: the one definition of what a release carries. Checks a
# release's asset names and its latest.json, or a build directory's files,
# read from disk (no network), so the same list gates release.yml's promote
# (on the draft, before it is published), assemble-build (on a build
# artifact) and the final guard (on the validated rc, read from its own tree).
#
# Usage:
#   check-release-assets.sh release <tag> <version> <assets.txt> <latest.json>
#   check-release-assets.sh build <version> <dir>
#     tag         the release tag, e.g. v0.35.1-rc.2
#     version     the version in the asset names (the rc suffix stripped)
#     assets.txt  the release's asset names, one per line
#     latest.json the release's latest.json (a missing file is reported)
#     dir         a build directory: the release's assets without latest.json
#
# release: exactly the 7 assets below, and latest.json naming this tag's
# version with a signed darwin-aarch64 and linux-x86_64 entry whose url is
# this tag's bundle. build: exactly the same names minus latest.json, as files
# (build-manifest.json, written after this check, is not counted).
# An extra asset fails too: the pipeline changed, and this list must change
# with it. Reports every problem, then exits 1; prints "OK: ..." on success.
set -euo pipefail

usage() {
  echo "usage: $0 release <tag> <version> <assets.txt> <latest.json> | build <version> <dir>" >&2
  exit 2
}
MODE="${1:-}"
case "$MODE" in
  release) [ "$#" -eq 5 ] || usage; TAG="$2"; V="$3"; ASSETS="$4"; LATEST="$5" ;;
  build) [ "$#" -eq 3 ] || usage; TAG="build"; V="$2"; DIR="$3" ;;
  *) usage ;;
esac
URL="https://github.com/beadbox/beadbox/releases/download/$TAG"

EXPECTED=(
  "Beadbox-$V-macOS-arm64.dmg"
  "beadbox_${V}_Linux_amd64.deb"
  "Beadbox_aarch64.app.tar.gz"
  "Beadbox_aarch64.app.tar.gz.sig"
  "Beadbox_x86_64.deb"
  "Beadbox_x86_64.deb.sig"
)
[ "$MODE" = release ] && EXPECTED+=("latest.json")
# platform key -> the bundle its url must name
PLATFORMS=("darwin-aarch64 Beadbox_aarch64.app.tar.gz" "linux-x86_64 Beadbox_x86_64.deb")

bad=0
err() { echo "::error::$TAG: $*"; bad=1; }

if [ "$MODE" = build ]; then
  [ -d "$DIR" ] || { err "no build directory at $DIR"; exit 1; }
  ASSETS=$(mktemp)
  trap 'rm -f "${ASSETS:?}"' EXIT
  find "$DIR" -mindepth 1 -maxdepth 1 -type f ! -name build-manifest.json -exec basename {} \; > "$ASSETS"
fi
[ -f "$ASSETS" ] || { err "no asset list at $ASSETS"; exit 1; }
for name in "${EXPECTED[@]}"; do
  grep -qxF -- "$name" "$ASSETS" || err "missing asset $name"
done
while IFS= read -r name; do
  [ -n "$name" ] || continue
  printf '%s\n' "${EXPECTED[@]}" | grep -qxF -- "$name" || err "unexpected asset $name (update the expected list in $0 if the pipeline now ships it)"
done < "$ASSETS"
count=$(grep -c . "$ASSETS" || true)
[ "$count" -eq "${#EXPECTED[@]}" ] || err "has $count assets, expected ${#EXPECTED[@]}"

if [ "$MODE" = build ]; then
  :
elif [ ! -f "$LATEST" ]; then
  err "no latest.json to read"
elif ! jq -e . "$LATEST" > /dev/null 2>&1; then
  err "latest.json is not valid JSON"
else
  got=$(jq -r '.version // ""' "$LATEST")
  [ "$got" = "${TAG#v}" ] || err "latest.json version is '$got', expected ${TAG#v}"
  for entry in "${PLATFORMS[@]}"; do
    plat="${entry%% *}"; bundle="${entry#* }"
    if ! jq -e --arg p "$plat" '.platforms[$p] | type == "object"' "$LATEST" > /dev/null; then
      err "latest.json has no $plat platform"
      continue
    fi
    jq -e --arg p "$plat" '.platforms[$p].signature | type == "string" and length > 0' "$LATEST" > /dev/null \
      || err "latest.json $plat has no signature"
    url=$(jq -r --arg p "$plat" '.platforms[$p].url // ""' "$LATEST")
    [ "$url" = "$URL/$bundle" ] || err "latest.json $plat url is '$url', expected $URL/$bundle"
  done
fi

[ "$bad" -eq 0 ] || exit 1
if [ "$MODE" = build ]; then
  echo "OK: ${#EXPECTED[@]} build assets"
else
  echo "OK: ${#EXPECTED[@]} assets, ${#PLATFORMS[@]} platforms on $TAG"
fi
