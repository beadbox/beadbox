#!/usr/bin/env bash
# beadbox-pqn: table test of scripts/check-release-assets.sh, on planted asset
# lists and manifests. Rows are shaped on real releases: v0.35.0 (complete) and
# v0.35.1-rc.2 (build-linux cancelled; published macOS-only).
#
# Usage: bash scripts/test-release-assets.sh  (from the repo root)
set -euo pipefail

CHECK="${CHECK:-scripts/check-release-assets.sh}"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp:?}"' EXIT
fail=0

V=0.35.1
TAG=v0.35.1-rc.3
URL="https://github.com/beadbox/beadbox/releases/download/$TAG"
FULL="Beadbox-$V-macOS-arm64.dmg
beadbox_${V}_Linux_amd64.deb
Beadbox_aarch64.app.tar.gz
Beadbox_aarch64.app.tar.gz.sig
Beadbox_x86_64.deb
Beadbox_x86_64.deb.sig
latest.json"

manifest() { # manifest <version> <platforms json>
  jq -n --arg v "$1" --argjson p "$2" '{version: $v, notes: "n", pub_date: "2026-11-19T00:00:00Z", platforms: $p}'
}
DARWIN="{\"signature\":\"sigD\",\"url\":\"$URL/Beadbox_aarch64.app.tar.gz\"}"
LINUX="{\"signature\":\"sigL\",\"url\":\"$URL/Beadbox_x86_64.deb\"}"
BOTH="{\"darwin-aarch64\":$DARWIN,\"linux-x86_64\":$LINUX}"

n=0
row() { # row <name> <want ok|red> <assets text> <latest.json text|-> [expected stderr fragment...]
  local name="$1" want="$2" assets="$3" latest="$4" got
  shift 4
  n=$((n + 1))
  printf '%s\n' "$assets" > "$tmp/assets$n.txt"
  if [ "$latest" = "-" ]; then rm -f "$tmp/latest$n.json"; else printf '%s\n' "$latest" > "$tmp/latest$n.json"; fi
  if bash "$CHECK" release "$TAG" "$V" "$tmp/assets$n.txt" "$tmp/latest$n.json" > "$tmp/out" 2>&1; then got=ok; else got=red; fi
  local missing=""
  for frag in "$@"; do grep -qF -- "$frag" "$tmp/out" || missing="$missing [$frag]"; done
  if [ "$got" = "$want" ] && [ -z "$missing" ]; then
    echo "PASS  $name ($got)"
  else
    echo "FAIL  $name: want $want, got $got${missing:+; output lacks$missing}"
    sed 's/^/      /' "$tmp/out"
    fail=1
  fi
}

row "a complete release (v0.35.0's shape)" ok "$FULL" "$(manifest "${TAG#v}" "$BOTH")" "OK: 7 assets, 2 platforms"

RC2="Beadbox-$V-macOS-arm64.dmg
Beadbox_aarch64.app.tar.gz
Beadbox_aarch64.app.tar.gz.sig
latest.json"
row "rc.2's shape: build-linux cancelled, macOS only" red "$RC2" \
  "$(manifest "${TAG#v}" "{\"darwin-aarch64\":$DARWIN}")" \
  "beadbox_${V}_Linux_amd64.deb" "Beadbox_x86_64.deb.sig" "linux-x86_64"

row "the macOS DMG is missing" red "$(printf '%s\n' "$FULL" | grep -v '\.dmg$')" \
  "$(manifest "${TAG#v}" "$BOTH")" "Beadbox-$V-macOS-arm64.dmg"

row "no latest.json asset and no manifest" red "$(printf '%s\n' "$FULL" | grep -vx latest.json)" - "latest.json"

row "latest.json lists only darwin" red "$FULL" "$(manifest "${TAG#v}" "{\"darwin-aarch64\":$DARWIN}")" "linux-x86_64"

row "latest.json lists only linux" red "$FULL" "$(manifest "${TAG#v}" "{\"linux-x86_64\":$LINUX}")" "darwin-aarch64"

UNSIGNED=$(jq -n --argjson d "$DARWIN" --arg u "$URL/Beadbox_x86_64.deb" '{"darwin-aarch64": $d, "linux-x86_64": {signature: "", url: $u}}')
row "a platform with an empty signature" red "$FULL" "$(manifest "${TAG#v}" "$UNSIGNED")" "linux-x86_64"

OTHER_TAG=$(jq -n --argjson d "$DARWIN" '{"darwin-aarch64": $d, "linux-x86_64": {signature: "sigL", url: "https://github.com/beadbox/beadbox/releases/download/v0.35.0/Beadbox_x86_64.deb"}}')
row "a platform url pointing at another tag" red "$FULL" "$(manifest "${TAG#v}" "$OTHER_TAG")" "linux-x86_64"

row "latest.json for another version" red "$FULL" "$(manifest "0.35.0" "$BOTH")" "version"

row "an eighth, unexpected asset" red "$FULL
Beadbox_x86_64.nsis.zip" "$(manifest "${TAG#v}" "$BOTH")" "Beadbox_x86_64.nsis.zip"

row "latest.json that is not JSON" red "$FULL" "not json {" "latest.json"

# build mode: assemble-build's directory, the same names without latest.json.
brow() { # brow <name> <want ok|red> <files, one per line> [expected output fragment...]
  local name="$1" want="$2" files="$3" got d
  shift 3
  n=$((n + 1)); d="$tmp/build$n"; mkdir -p "$d"
  while IFS= read -r f; do [ -n "$f" ] && : > "$d/$f"; done <<< "$files"
  if bash "$CHECK" build "$V" "$d" > "$tmp/out" 2>&1; then got=ok; else got=red; fi
  local missing=""
  for frag in "$@"; do grep -qF -- "$frag" "$tmp/out" || missing="$missing [$frag]"; done
  if [ "$got" = "$want" ] && [ -z "$missing" ]; then
    echo "PASS  build: $name ($got)"
  else
    echo "FAIL  build: $name: want $want, got $got${missing:+; output lacks$missing}"
    sed 's/^/      /' "$tmp/out"
    fail=1
  fi
}
BUILD=$(printf '%s\n' "$FULL" | grep -vx latest.json)
brow "a complete build, with its build-manifest.json" ok "$BUILD
build-manifest.json" "OK: 6 build assets"
brow "build-linux's bundle missing" red "$(printf '%s\n' "$BUILD" | grep -v x86_64)" "Beadbox_x86_64.deb" "Beadbox_x86_64.deb.sig"
brow "a latest.json in a build is unexpected" red "$FULL" "unexpected asset latest.json"

# A checker that always passes must fail this table.
if [ -z "${STANDIN:-}" ]; then
  printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/standin.sh"
  if CHECK="$tmp/standin.sh" STANDIN=1 bash "$0" > "$tmp/standin.out" 2>&1; then
    echo "FAIL  a stand-in checker that always passes was not caught"; fail=1
  else
    echo "PASS  a stand-in checker that always passes fails the table"
  fi
fi

[ "$fail" -eq 0 ] || { echo "release assets table: FAILED"; exit 1; }
echo "release assets table: all rows pass"
