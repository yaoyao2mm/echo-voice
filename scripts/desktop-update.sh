#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${ECHO_DESKTOP_UPDATE_REMOTE:-origin}"
BRANCH="${ECHO_DESKTOP_UPDATE_BRANCH:-main}"
REBUILD_APP="${ECHO_DESKTOP_UPDATE_REBUILD_APP:-true}"
APP_DIR="$ROOT_DIR/dist/Echo Codex.app"

cd "$ROOT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Echo Codex desktop update requires a Git checkout." >&2
  exit 1
fi

dirty_tracked="$(git status --porcelain --untracked-files=no)"
if [[ -n "$dirty_tracked" ]]; then
  echo "Refusing to update because tracked local files have uncommitted changes:" >&2
  echo "$dirty_tracked" >&2
  exit 1
fi

before="$(git rev-parse --short HEAD)"

echo "== fetch =="
git fetch "$REMOTE" "$BRANCH"

echo "== merge =="
git merge --ff-only "$REMOTE/$BRANCH"

after="$(git rev-parse --short HEAD)"

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare pnpm@10.30.3 --activate
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is not installed on this Mac." >&2
  exit 1
fi

echo "== install =="
pnpm install --frozen-lockfile

if [[ "$(uname -s)" == "Darwin" && "$REBUILD_APP" != "false" && -d "$APP_DIR" ]]; then
  echo "== rebuild app =="
  "$ROOT_DIR/scripts/macos-create-app.sh"
fi

echo "== updated =="
echo "before=$before"
echo "after=$after"
