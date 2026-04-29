#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/dist/Echo Codex.app"
DMG_PATH="$ROOT_DIR/dist/Echo Codex.dmg"
STAGING_DIR="$ROOT_DIR/dist/dmg"

if [[ ! -d "$APP_DIR" ]]; then
  "$ROOT_DIR/scripts/macos-create-app.sh"
fi

rm -rf "$STAGING_DIR" "$DMG_PATH"
mkdir -p "$STAGING_DIR"
cp -R "$APP_DIR" "$STAGING_DIR/"

hdiutil create \
  -volname "Echo Codex" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

rm -rf "$STAGING_DIR"

echo "Created: $DMG_PATH"
