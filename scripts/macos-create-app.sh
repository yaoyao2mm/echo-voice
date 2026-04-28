#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/dist/Echo Voice.app"
ELECTRON_APP="$ROOT_DIR/desktop-app/node_modules/electron/dist/Electron.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
APP_RESOURCES_DIR="$RESOURCES_DIR/app"
EXECUTABLE="$MACOS_DIR/Echo Voice"

if [[ ! -d "$ELECTRON_APP" ]]; then
  npm run desktop:app:install
fi

rm -rf "$APP_DIR"
mkdir -p "$ROOT_DIR/dist"
cp -R "$ELECTRON_APP" "$APP_DIR"

if [[ -f "$MACOS_DIR/Electron" ]]; then
  mv "$MACOS_DIR/Electron" "$EXECUTABLE"
fi

rm -f "$RESOURCES_DIR/default_app.asar"
plutil -remove ElectronAsarIntegrity "$CONTENTS_DIR/Info.plist" >/dev/null 2>&1 || true

rm -rf "$APP_RESOURCES_DIR"
mkdir -p "$APP_RESOURCES_DIR"
cp "$ROOT_DIR/desktop-app/main.cjs" "$APP_RESOURCES_DIR/main.cjs"
cp "$ROOT_DIR/desktop-app/package.json" "$APP_RESOURCES_DIR/package.json"
printf '%s\n' "$ROOT_DIR" > "$RESOURCES_DIR/echo-root"

plutil -replace CFBundleName -string "Echo Voice" "$CONTENTS_DIR/Info.plist"
plutil -replace CFBundleDisplayName -string "Echo Voice" "$CONTENTS_DIR/Info.plist"
plutil -replace CFBundleIdentifier -string "xyz.554119401.echo.desktop" "$CONTENTS_DIR/Info.plist"
plutil -replace CFBundleExecutable -string "Echo Voice" "$CONTENTS_DIR/Info.plist"
plutil -replace CFBundleShortVersionString -string "0.1.0" "$CONTENTS_DIR/Info.plist"
plutil -replace CFBundleVersion -string "0.1.0" "$CONTENTS_DIR/Info.plist"
plutil -replace NSHighResolutionCapable -bool true "$CONTENTS_DIR/Info.plist"

codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || true
xattr -dr com.apple.quarantine "$APP_DIR" >/dev/null 2>&1 || true

echo "Created: $APP_DIR"
echo "Bundle id: xyz.554119401.echo.desktop"
echo "Open it with:"
echo "  env -u ELECTRON_RUN_AS_NODE open \"$APP_DIR\""
