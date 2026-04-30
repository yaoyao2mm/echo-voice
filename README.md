# Echo Codex

Echo Codex is a phone-first control surface for local Codex:

1. Deploy the public relay server.
2. Open the paired URL from an Android browser.
3. Capture a rough idea or Codex task on the phone, including through the phone's native voice input keyboard.
4. Choose an allowlisted local project.
5. The desktop agent pulls the request, talks to local `codex app-server` over stdio, and streams thread/turn progress back to the phone.

The first version is intentionally lightweight: a Node relay, a local desktop agent, and a mobile web/PWA UI. Echo does not own dictation; the phone captures text, the relay can clean or structure it, and the desktop agent runs Codex locally. The longer-term direction is isolated per-task worktrees, so Codex can explore an idea without touching your active checkout until you decide to keep it.

The product goal is to feel like the missing mobile companion to the local Codex client: start a task from the phone, watch status and output, follow up with context, and keep all filesystem execution anchored on the desktop.

## Quick Start

### Local/LAN Mode

```bash
pnpm install
cp .env.example .env
pnpm start
```

Open the printed URL on your Android phone. The URL includes a pairing token; API calls without that token are rejected.

Android browsers require a secure context before they allow camera-based QR pairing. The easiest development path is USB forwarding:

```bash
pnpm run android:usb
```

Then open the printed `http://localhost:3888/?token=...` URL on the phone. For LAN use without USB, run the server with a trusted HTTPS certificate:

```bash
HTTPS_CERT=/absolute/path/to/cert.pem HTTPS_KEY=/absolute/path/to/key.pem pnpm start
```

### Internet Relay Mode

Run the relay server on your VPS/domain:

```bash
cp .env.example .env
# Set at least:
# ECHO_MODE=relay
# ECHO_PUBLIC_URL=https://voice.example.com
# ECHO_TOKEN=a-long-random-secret
# ECHO_AUTH_ENABLED=true
# ECHO_AUTH_USERNAME=your-user
# ECHO_AUTH_PASSWORD=your-password
# LLM_API_KEY=...
pnpm install
pnpm run relay
```

Run the desktop agent on the computer where Codex should execute:

```bash
ECHO_RELAY_URL=https://voice.example.com ECHO_TOKEN=a-long-random-secret pnpm run desktop
```

On macOS, install and sign in to the official `Codex.app` first. Echo now uses the app-bundled `codex app-server` instead of a Homebrew `codex` binary. If your app lives outside `/Applications`, set `ECHO_CODEX_APP_PATH` to `Codex.app/Contents/Resources/codex`.

To enable local Codex control, expose only the project directories you trust:

```bash
ECHO_RELAY_URL=https://voice.example.com \
ECHO_TOKEN=a-long-random-secret \
ECHO_CODEX_WORKSPACES=echo=/Users/john/workspace/projects/echo,metio=/Users/john/workspace/projects/metio \
pnpm run desktop
```

On macOS, the preferred path is the native `Echo Codex.app`. It opens the settings window, adds a menu bar item, and can run the desktop agent itself without installing a LaunchAgent:

```bash
cat > .env <<'EOF'
ECHO_RELAY_URL=https://echo.554119401.xyz
ECHO_TOKEN=a-long-random-secret
ECHO_CODEX_WORKSPACES=echo=/Users/john/workspace/projects/echo,metio=/Users/john/workspace/projects/metio
ECHO_PROXY_URL=system
EOF

pnpm run desktop:mac:app
pnpm run desktop:mac -- app
pnpm run desktop:mac -- status
pnpm run desktop:mac -- doctor
pnpm run desktop:mac -- logs
```

If you have already built the app, open it again with:

```bash
pnpm run desktop:mac -- app
```

LaunchAgent is still available as a legacy/background option. Other commands: `app`, `start`, `stop`, `restart`, `settings`, `doctor`, `uninstall`, `print-env`.

To create a local DMG from that launcher:

```bash
pnpm run desktop:mac:dmg
```

`desktop:mac -- settings` uses `Echo Codex.app` when it exists, uses the development Electron shell when installed, and falls back to the local browser page otherwise. The UI can update relay, VPN/proxy, and Codex workspace settings without editing `.env` directly.

The native window also installs a menu bar item. Closing the settings window hides it instead of quitting, and the menu bar item can reopen settings, start/stop/restart the app-managed agent, switch off the legacy LaunchAgent, run the network doctor, and open logs.

The Overview tab checks the relay config, app-managed or launchd agent, Codex App, and allowlisted workspaces.

The Codex tab has an engineering directory manager. Use "发现工程" to scan common local project folders, or "浏览目录" to pick a folder manually. After saving and restarting the desktop agent, those project names appear in the phone UI as the selectable Codex working directories.

The Overview tab also shows a pairing QR code. Scan it from the phone to open the mobile UI with the pairing token already attached, so the phone page no longer needs a manually pasted token.

If web login is enabled, the phone page asks for the configured user before it accepts the paired token. Browser users send both a login session and the pairing token; desktop agents still authenticate with `ECHO_TOKEN` only.

In internet relay mode, prompt refinement remains server-side and env-driven. The desktop-side model fields that matter during relay mode are the Codex settings (`ECHO_CODEX_MODEL`, `ECHO_CODEX_PROFILE`, `ECHO_CODEX_APPROVAL_POLICY`, and workspace/sandbox options), because those control local Codex execution.

### VPN And Proxy

Internet relay mode is VPN-friendly by design: the phone and the Mac both make outbound HTTPS requests to the public relay, so they do not need to be on the same LAN.

For VPN clients that expose a local HTTP/mixed proxy, set:

```bash
ECHO_PROXY_URL=system
```

On macOS this makes the desktop agent follow the current System Settings HTTP/HTTPS proxy. If that system proxy points to a local port that is currently unreachable, Echo falls back to direct HTTPS by default; set `ECHO_PROXY_FALLBACK_DIRECT=false` to disable that behavior. You can also pin a proxy explicitly, for example `ECHO_PROXY_URL=http://127.0.0.1:7897`. SOCKS-only proxy URLs are not supported directly; expose an HTTP or mixed proxy port instead.

After changing network settings, restart and run the doctor:

```bash
pnpm run desktop:mac -- restart
pnpm run desktop:mac -- doctor
```

Open `https://voice.example.com/?token=a-long-random-secret` on the phone. See [docs/internet-deploy.md](docs/internet-deploy.md) for Nginx, systemd, and HTTPS notes.

### Deploy Updates

For the relay host, use the shared deploy script:

```bash
pnpm run deploy:relay -- root@YOUR_SERVER /opt/echo-voice
```

The GitHub Actions workflow `.github/workflows/deploy-relay.yml` can deploy automatically on pushes to `main` after these repository secrets are configured:

- `ECHO_DEPLOY_HOST`
- `ECHO_DEPLOY_SSH_KEY`
- `ECHO_DEPLOY_USER` optional, defaults to `root`
- `ECHO_DEPLOY_PATH` optional, defaults to `/opt/echo-voice`
- `ECHO_DEPLOY_SERVICE` optional, defaults to `echo-voice.service`
- `ECHO_DEPLOY_KNOWN_HOSTS` optional, otherwise the workflow uses `ssh-keyscan`

## Prompt Refinement Setup

For text refinement with an OpenAI-compatible chat endpoint:

```bash
POSTPROCESS_PROVIDER=openai
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4.1-mini
```

For Volcengine Ark Coding Plan refinement:

```bash
POSTPROCESS_PROVIDER=volcengine
METIO_VOLCENGINE_CODING_API_KEY=ark-...
METIO_VOLCENGINE_CODING_OPENAI_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
METIO_VOLCENGINE_CODING_CHAT_MODEL=ark-code-latest
```

For local refinement through Ollama:

```bash
POSTPROCESS_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
```

If no post-processing provider is configured, Echo falls back to a conservative rule-based cleanup.

## Mobile Codex Remote

The primary Codex remote mode is now interactive:

- The phone can submit prompts, but cannot choose arbitrary filesystem paths or shell commands.
- The phone creates an app-server backed Codex session, shows current status, latest output, full logs, and final result.
- Conversations are managed in a Codex/Gemini-style session workbench: search recent sessions, continue a selected session, and archive/restore old sessions.
- If Codex asks for a command or file-change approval, Echo pauses the local app-server request and shows Approve/Deny controls on the phone.
- Pressing "继续" sends another user message into the selected Codex session instead of starting from scratch.
- Pressing "新会话" clears the selection so the next prompt starts a fresh Codex thread.
- The desktop agent only starts sessions inside `ECHO_CODEX_WORKSPACES`.
- The default sandbox is `workspace-write`; on a trusted personal machine you can set `ECHO_CODEX_SANDBOX=danger-full-access` to mirror the current full-access Codex workflow.
- The default interactive approval policy is `on-request`. Approval requests wait up to `ECHO_CODEX_APPROVAL_TIMEOUT_MS` before Echo returns a timeout/cancel response to Codex.
- The relay persists interactive sessions, approvals, agent heartbeats, leases, logs, archive state, and final messages in SQLite under `~/.echo-voice/echo.sqlite`.
- Future worktree mode will let each queued task run in a separate local Git worktree before you apply or discard the result.

See [docs/mobile-codex-roadmap.md](docs/mobile-codex-roadmap.md) for the implementation roadmap.

The desktop agent now polls only interactive Codex app-server session commands. The old one-shot queue is no longer exposed through the mobile or agent API.

## Product Shape

Echo makes the phone the idea inbox for local engineering work. The phone is good at capture, review, and lightweight monitoring; the desktop agent is the only process allowed to touch local repositories and run Codex.
