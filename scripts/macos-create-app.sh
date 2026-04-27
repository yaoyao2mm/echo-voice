#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/dist/Echo Voice.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
EXECUTABLE="$MACOS_DIR/Echo Voice"

mkdir -p "$MACOS_DIR"

cat > "$CONTENTS_DIR/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Echo Voice</string>
  <key>CFBundleDisplayName</key>
  <string>Echo Voice</string>
  <key>CFBundleIdentifier</key>
  <string>xyz.554119401.echo.desktop</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleExecutable</key>
  <string>Echo Voice</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

cat > "$EXECUTABLE" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$ROOT_DIR"
if [[ ! -x "$ROOT_DIR/desktop-app/node_modules/.bin/electron" ]]; then
  npm run desktop:app:install
fi
exec npm run desktop:app
EOF

chmod +x "$EXECUTABLE"

echo "Created: $APP_DIR"
echo "Open it with:"
echo "  open \"$APP_DIR\""
