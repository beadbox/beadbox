#!/usr/bin/env bash
# Build and install a local macOS app alongside the production Beadbox.app.
# Usage: bash scripts/build-install-local-macos.sh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script requires macOS." >&2
  exit 1
fi

for tool in bun codesign ditto mktemp; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Missing required tool: $tool" >&2
    exit 1
  }
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/src-tauri/target/release/bundle/macos/Beadbox Local.app"
DEST="/Applications/Beadbox Local.app"
LOCAL_ID="com.arikon.beadbox.local"
TMP="$(mktemp -d)"
STAGE=""
BACKUP=""

bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"
}

cleanup() {
  local status=$?
  if [[ $status -ne 0 && -n "$BACKUP" && -d "$BACKUP/Beadbox Local.app" ]]; then
    if [[ -e "$DEST" ]]; then
      mv "$DEST" "$STAGE/failed.app" || true
    fi
    if ! mv "$BACKUP/Beadbox Local.app" "$DEST"; then
      echo "Restore the previous local app from $BACKUP/Beadbox Local.app" >&2
    fi
  fi
  [[ -z "$STAGE" ]] || rm -rf "$STAGE"
  if [[ -n "$BACKUP" && ! -e "$BACKUP/Beadbox Local.app" ]]; then
    rmdir "$BACKUP" || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

cat > "$TMP/tauri-local.json" <<'EOF'
{
  "productName": "Beadbox Local",
  "identifier": "com.arikon.beadbox.local",
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
bun run tauri build --config "$TMP/tauri-local.json" --bundles app --no-sign --ci

[[ -d "$APP" && "$(bundle_id "$APP")" == "$LOCAL_ID" ]] || {
  echo "Build did not produce the expected local app: $APP" >&2
  exit 1
}
codesign --force --deep --sign - --options runtime \
  --entitlements "$ROOT/src-tauri/Entitlements.plist" "$APP"
codesign --verify --deep --strict "$APP"

if [[ -e "$DEST" || -L "$DEST" ]]; then
  [[ -d "$DEST" && ! -L "$DEST" && "$(bundle_id "$DEST")" == "$LOCAL_ID" ]] || {
    echo "Refusing to replace an app other than Beadbox Local at $DEST" >&2
    exit 1
  }
fi

STAGE="$(mktemp -d /Applications/.beadbox-local-stage.XXXXXX)"
ditto "$APP" "$STAGE/Beadbox Local.app"
codesign --verify --deep --strict "$STAGE/Beadbox Local.app"
[[ "$(bundle_id "$STAGE/Beadbox Local.app")" == "$LOCAL_ID" ]]

if [[ -e "$DEST" ]]; then
  BACKUP="$(mktemp -d /Applications/.beadbox-local-backup.XXXXXX)"
  mv "$DEST" "$BACKUP/Beadbox Local.app"
fi
mv "$STAGE/Beadbox Local.app" "$DEST"
codesign --verify --deep --strict "$DEST"

if [[ -n "$BACKUP" ]]; then
  rm -rf "$BACKUP"
  BACKUP=""
fi
echo "Installed $DEST (bundle ID: $LOCAL_ID)"
echo "Production /Applications/Beadbox.app was not changed."
