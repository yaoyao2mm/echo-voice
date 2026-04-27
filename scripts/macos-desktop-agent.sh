#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Echo Voice Desktop Agent"
LABEL="xyz.554119401.echo.desktop-agent"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/EchoVoice"
OUT_LOG="$LOG_DIR/desktop-agent.out.log"
ERR_LOG="$LOG_DIR/desktop-agent.err.log"
ENV_FILE="$ROOT_DIR/.env"

usage() {
  cat <<EOF
Usage: scripts/macos-desktop-agent.sh <command>

Commands:
  install     Create/update the macOS launchd service
  start       Start the desktop agent
  stop        Stop the desktop agent
  restart     Restart the desktop agent
  status      Show launchd status and recent logs
  logs        Follow desktop agent logs
  settings    Open the local desktop settings page
  doctor      Check relay reachability through the same network/proxy settings
  uninstall   Stop and remove the launchd service
  print-env   Print loaded desktop-agent environment

The service reads configuration from:
  $ENV_FILE

Required values:
  ECHO_RELAY_URL=https://echo.554119401.xyz
  ECHO_TOKEN=...

Useful values:
  ECHO_CODEX_WORKSPACES=echo=/Users/john/workspace/projects/echo
  ECHO_PROXY_URL=system
  INSERT_MODE=paste
EOF
}

ensure_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "This helper is for macOS launchd only." >&2
    exit 1
  fi
}

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    local parsed_env
    parsed_env="$(node - "$ENV_FILE" <<'NODE'
const fs = require("node:fs");
const dotenv = require("dotenv");

const wanted = [
  "ECHO_RELAY_URL",
  "ECHO_TOKEN",
  "ECHO_CODEX_WORKSPACES",
  "ECHO_CODEX_ENABLED",
  "ECHO_CODEX_COMMAND",
  "ECHO_CODEX_SANDBOX",
  "INSERT_MODE",
  "ECHO_PROXY_URL",
  "ECHO_NO_PROXY",
  "ECHO_HTTP_TIMEOUT_MS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ECHO_SETTINGS_HOST",
  "ECHO_SETTINGS_PORT"
];

const file = process.argv[2];
const parsed = dotenv.parse(fs.readFileSync(file));
for (const key of wanted) {
  if (Object.prototype.hasOwnProperty.call(parsed, key)) {
    console.log(`export ${key}=${JSON.stringify(parsed[key])}`);
  }
}
NODE
)"
    eval "$parsed_env"
  fi

  : "${ECHO_RELAY_URL:=}"
  : "${ECHO_TOKEN:=}"
  : "${ECHO_CODEX_WORKSPACES:=$ROOT_DIR}"
  : "${ECHO_CODEX_ENABLED:=true}"
  : "${ECHO_CODEX_COMMAND:=codex}"
  : "${ECHO_CODEX_SANDBOX:=workspace-write}"
  : "${INSERT_MODE:=paste}"
  : "${ECHO_PROXY_URL:=}"
  : "${ECHO_NO_PROXY:=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local}"
  : "${ECHO_HTTP_TIMEOUT_MS:=60000}"
  : "${HTTP_PROXY:=}"
  : "${HTTPS_PROXY:=}"
  : "${NO_PROXY:=}"
  : "${ECHO_SETTINGS_HOST:=127.0.0.1}"
  : "${ECHO_SETTINGS_PORT:=3891}"
}

require_config() {
  load_env
  local missing=0

  if [[ -z "$ECHO_RELAY_URL" ]]; then
    echo "Missing ECHO_RELAY_URL in $ENV_FILE" >&2
    missing=1
  fi

  if [[ -z "$ECHO_TOKEN" ]]; then
    echo "Missing ECHO_TOKEN in $ENV_FILE" >&2
    missing=1
  fi

  if [[ "$missing" -ne 0 ]]; then
    cat >&2 <<EOF

Create $ENV_FILE with at least:

ECHO_RELAY_URL=https://echo.554119401.xyz
ECHO_TOKEN=your-pairing-token
ECHO_CODEX_WORKSPACES=echo=/Users/john/workspace/projects/echo
EOF
    exit 1
  fi
}

node_path() {
  command -v node
}

agent_args_json() {
  local node_bin
  node_bin="$(node_path)"
  printf '    <string>%s</string>\n' "$node_bin"
  printf '    <string>%s</string>\n' "$ROOT_DIR/src/desktop-agent.js"
}

env_entry() {
  local key="$1"
  local value="$2"
  printf '    <key>%s</key>\n' "$key"
  printf '    <string>%s</string>\n' "$(xml_escape "$value")"
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

write_plist() {
  require_config
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
$(agent_args_json)
  </array>

  <key>WorkingDirectory</key>
  <string>$(xml_escape "$ROOT_DIR")</string>

  <key>EnvironmentVariables</key>
  <dict>
$(env_entry "PATH" "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
$(env_entry "ECHO_RELAY_URL" "$ECHO_RELAY_URL")
$(env_entry "ECHO_TOKEN" "$ECHO_TOKEN")
$(env_entry "ECHO_CODEX_WORKSPACES" "$ECHO_CODEX_WORKSPACES")
$(env_entry "ECHO_CODEX_ENABLED" "$ECHO_CODEX_ENABLED")
$(env_entry "ECHO_CODEX_COMMAND" "$ECHO_CODEX_COMMAND")
$(env_entry "ECHO_CODEX_SANDBOX" "$ECHO_CODEX_SANDBOX")
$(env_entry "INSERT_MODE" "$INSERT_MODE")
$(env_entry "ECHO_PROXY_URL" "$ECHO_PROXY_URL")
$(env_entry "ECHO_NO_PROXY" "$ECHO_NO_PROXY")
$(env_entry "ECHO_HTTP_TIMEOUT_MS" "$ECHO_HTTP_TIMEOUT_MS")
$(env_entry "HTTP_PROXY" "$HTTP_PROXY")
$(env_entry "HTTPS_PROXY" "$HTTPS_PROXY")
$(env_entry "NO_PROXY" "$NO_PROXY")
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$OUT_LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$ERR_LOG")</string>
</dict>
</plist>
EOF

  plutil -lint "$PLIST" >/dev/null
}

bootout() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
}

bootstrap() {
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
}

kickstart() {
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
}

install_service() {
  ensure_macos
  write_plist
  bootout
  bootstrap
  echo "$APP_NAME installed and started."
  echo "Logs: $OUT_LOG"
}

start_service() {
  ensure_macos
  if [[ ! -f "$PLIST" ]]; then
    write_plist
    bootstrap
  else
    kickstart
  fi
  echo "$APP_NAME started."
}

stop_service() {
  ensure_macos
  bootout
  echo "$APP_NAME stopped."
}

restart_service() {
  ensure_macos
  write_plist
  bootout
  bootstrap
  echo "$APP_NAME restarted."
}

status_service() {
  ensure_macos
  echo "Service: $LABEL"
  echo "Plist:   $PLIST"
  echo
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | redact_sensitive | sed -n '1,80p' || echo "Not loaded."
  echo
  echo "Recent stdout:"
  tail -n 20 "$OUT_LOG" 2>/dev/null || true
  echo
  echo "Recent stderr:"
  tail -n 20 "$ERR_LOG" 2>/dev/null || true
}

follow_logs() {
  ensure_macos
  mkdir -p "$LOG_DIR"
  touch "$OUT_LOG" "$ERR_LOG"
  tail -f "$OUT_LOG" "$ERR_LOG"
}

doctor_network() {
  load_env
  node "$ROOT_DIR/scripts/network-doctor.js"
}

open_settings() {
  load_env
  node "$ROOT_DIR/scripts/desktop-settings.js" --open
}

uninstall_service() {
  ensure_macos
  bootout
  rm -f "$PLIST"
  echo "$APP_NAME uninstalled. Logs are still in $LOG_DIR."
}

print_env() {
  load_env
  cat <<EOF
ECHO_RELAY_URL=$ECHO_RELAY_URL
ECHO_TOKEN=${ECHO_TOKEN:+<set>}
ECHO_CODEX_WORKSPACES=$ECHO_CODEX_WORKSPACES
ECHO_CODEX_ENABLED=$ECHO_CODEX_ENABLED
ECHO_CODEX_COMMAND=$ECHO_CODEX_COMMAND
ECHO_CODEX_SANDBOX=$ECHO_CODEX_SANDBOX
INSERT_MODE=$INSERT_MODE
ECHO_PROXY_URL=${ECHO_PROXY_URL:+$(mask_proxy "$ECHO_PROXY_URL")}
ECHO_NO_PROXY=$ECHO_NO_PROXY
ECHO_HTTP_TIMEOUT_MS=$ECHO_HTTP_TIMEOUT_MS
ECHO_SETTINGS_HOST=$ECHO_SETTINGS_HOST
ECHO_SETTINGS_PORT=$ECHO_SETTINGS_PORT
ROOT_DIR=$ROOT_DIR
EOF
}

mask_proxy() {
  node -e '
const value = process.argv[1] || "";
try {
  const url = new URL(value);
  if (url.username) url.username = "<user>";
  if (url.password) url.password = "<password>";
  console.log(url.toString());
} catch {
  console.log(value);
}
' "$1"
}

redact_sensitive() {
  sed -E \
    -e 's/(ECHO_TOKEN => ).+/\1<set>/' \
    -e 's/((OPENAI|LLM|METIO|VOLCENGINE)[A-Z0-9_]*API_KEY => ).+/\1<set>/' \
    -e 's#((HTTP|HTTPS)_PROXY => https?://)[^/@]+@#\1<credentials>@#'
}

main() {
  case "${1:-}" in
    install) install_service ;;
    start) start_service ;;
    stop) stop_service ;;
    restart) restart_service ;;
    status) status_service ;;
    logs) follow_logs ;;
    settings) open_settings ;;
    doctor) doctor_network ;;
    uninstall) uninstall_service ;;
    print-env) print_env ;;
    -h|--help|help|"") usage ;;
    *)
      echo "Unknown command: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
