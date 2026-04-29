#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: scripts/deploy-relay.sh <user@host> [remote_path]

Environment:
  ECHO_DEPLOY_TARGET        SSH target, used when <user@host> is omitted.
  ECHO_DEPLOY_PATH          Remote project path. Defaults to /opt/echo-voice.
  ECHO_DEPLOY_SERVICE       systemd service name. Defaults to echo-voice.service.
  ECHO_DEPLOY_BRANCH        Git branch to deploy. Defaults to main.
  ECHO_DEPLOY_REMOTE        Git remote to fetch. Defaults to origin.
  ECHO_DEPLOY_SSH_KEY_PATH  Optional SSH private key path.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

target="${1:-${ECHO_DEPLOY_TARGET:-}}"
remote_path="${2:-${ECHO_DEPLOY_PATH:-/opt/echo-voice}}"
service="${ECHO_DEPLOY_SERVICE:-echo-voice.service}"
branch="${ECHO_DEPLOY_BRANCH:-main}"
remote="${ECHO_DEPLOY_REMOTE:-origin}"

if [[ -z "$target" ]]; then
  usage >&2
  exit 2
fi

quote() {
  printf "%q" "$1"
}

ssh_args=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
)

if [[ -n "${ECHO_DEPLOY_SSH_KEY_PATH:-}" ]]; then
  ssh_args+=(-i "$ECHO_DEPLOY_SSH_KEY_PATH")
fi

echo "Deploying $remote/$branch to $target:$remote_path"

ssh "${ssh_args[@]}" "$target" \
  "ECHO_DEPLOY_PATH=$(quote "$remote_path") ECHO_DEPLOY_SERVICE=$(quote "$service") ECHO_DEPLOY_BRANCH=$(quote "$branch") ECHO_DEPLOY_REMOTE=$(quote "$remote") bash -s" <<'REMOTE'
set -euo pipefail

cd "$ECHO_DEPLOY_PATH"

echo "== before =="
git rev-parse --short HEAD

echo "== pull =="
git fetch "$ECHO_DEPLOY_REMOTE" "$ECHO_DEPLOY_BRANCH"
git merge --ff-only "$ECHO_DEPLOY_REMOTE/$ECHO_DEPLOY_BRANCH"

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare pnpm@10.30.3 --activate
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is not installed on the remote host." >&2
  exit 1
fi

echo "== install =="
pnpm install --prod --frozen-lockfile

pnpm_bin="$(command -v pnpm)"
unit_path="$(systemctl show -p FragmentPath --value "$ECHO_DEPLOY_SERVICE" 2>/dev/null || true)"
if [[ -z "$unit_path" || ! -f "$unit_path" ]]; then
  echo "systemd service not found: $ECHO_DEPLOY_SERVICE" >&2
  exit 1
fi

if grep -qE '^Description=Echo Voice Relay$' "$unit_path"; then
  sed -i 's#^Description=.*#Description=Echo Codex Relay#' "$unit_path"
fi

if ! grep -qF "ExecStart=$pnpm_bin run relay" "$unit_path"; then
  sed -i "s#^ExecStart=.*#ExecStart=$pnpm_bin run relay#" "$unit_path"
  systemctl daemon-reload
fi

echo "== restart =="
systemctl restart "$ECHO_DEPLOY_SERVICE"
sleep 2
systemctl --no-pager --full status "$ECHO_DEPLOY_SERVICE" | sed -n "1,16p"

echo "== after =="
git rev-parse --short HEAD
REMOTE
