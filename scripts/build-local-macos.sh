#!/usr/bin/env bash
# Build a locally signed "Beadbox Local.app" that runs side by side with an
# installed Beadbox without sharing its state. Nothing is installed: the app
# stays in the build tree, and its Info.plist points the registry, the legacy
# registry and the sidecar log at a scratch profile next to it.
# Usage: bash scripts/build-local-macos.sh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script requires macOS." >&2
  exit 1
fi

for tool in bun codesign mktemp; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Missing required tool: $tool" >&2
    exit 1
  }
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/src-tauri/target/release/bundle/macos/Beadbox Local.app"
PROFILE="$ROOT/src-tauri/target/local-profile"
LOCAL_ID="app.beadbox.local"
TMP="$(mktemp -d)"

bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"
}

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

# Merged over src-tauri/tauri.conf.json. The empty updater endpoint list keeps
# the local app off the production update channel: an update would replace
# this bundle in place with a production build.
cat > "$TMP/tauri-local.json" <<'EOF'
{
  "productName": "Beadbox Local",
  "identifier": "app.beadbox.local",
  "plugins": {
    "updater": {
      "endpoints": []
    }
  },
  "bundle": {
    "createUpdaterArtifacts": false,
    "targets": ["app"],
    "macOS": {
      "bundleName": "Beadbox Local",
      "signingIdentity": null
    }
  }
}
EOF

cd "$ROOT"
bun install --frozen-lockfile
# Empty analytics settings win over any .env file, so a local build never
# reports into production analytics.
VITE_POSTHOG_KEY="" VITE_POSTHOG_HOST="" \
  bun run tauri build --config "$TMP/tauri-local.json" --bundles app --no-sign --ci

[[ -d "$APP" && "$(bundle_id "$APP")" == "$LOCAL_ID" ]] || {
  echo "Build did not produce the expected local app: $APP" >&2
  exit 1
}
# LSEnvironment applies however the app is opened (Finder, Spotlight, open),
# and the sidecar inherits it. It must be written before signing: the
# signature covers Info.plist.
mkdir -p "$PROFILE"
PLIST="$APP/Contents/Info.plist"
plutil -replace LSEnvironment -json '{}' "$PLIST"
plutil -replace LSEnvironment.BEADBOX_REGISTRY_PATH -string "$PROFILE/registry.json" "$PLIST"
plutil -replace LSEnvironment.BEADS_REGISTRY_PATH -string "$PROFILE/legacy-registry.json" "$PLIST"
plutil -replace LSEnvironment.BEADBOX_LOG_PATH -string "$PROFILE/sidecar.log" "$PLIST"

codesign --force --deep --sign - --options runtime \
  --entitlements "$ROOT/src-tauri/Entitlements.plist" "$APP"
codesign --verify --deep --strict "$APP"

echo "Built $APP (bundle ID: $LOCAL_ID)"
echo "Scratch profile: $PROFILE"
echo "Launch it with: open -n $(printf '%q' "$APP")"
