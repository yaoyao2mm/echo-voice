# Echo Voice

Echo Voice is a phone-first voice input bridge:

1. Start the local desktop agent or deploy the public relay server.
2. Open the paired URL from an Android browser.
3. Record speech on the phone.
4. Review the raw transcript and AI-refined text on the phone.
5. Send the final text to the current cursor on the computer.

It can also act as a mobile remote for local Codex: the phone submits a structured task to the relay, the desktop agent pulls it, runs `codex exec` inside an allowlisted local project, and streams the result back to the phone.

The first version is intentionally lightweight: a cross-platform Node desktop agent plus a mobile web/PWA UI. It can use OpenAI-compatible cloud transcription, a self-hosted Whisper service, Ollama/local LLM post-processing, or a rule-based fallback.

## Quick Start

### Local/LAN Mode

```bash
npm install
cp .env.example .env
npm start
```

Open the printed URL on your Android phone. The URL includes a pairing token; API calls without that token are rejected.

Android browsers require a secure context before they allow microphone access. The easiest development path is USB forwarding:

```bash
npm run android:usb
```

Then open the printed `http://localhost:3888/?token=...` URL on the phone. For LAN use without USB, run the server with a trusted HTTPS certificate:

```bash
HTTPS_CERT=/absolute/path/to/cert.pem HTTPS_KEY=/absolute/path/to/key.pem npm start
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
# OPENAI_API_KEY=...
npm install
npm run relay
```

Run the desktop receiver on the computer where text should be pasted:

```bash
ECHO_RELAY_URL=https://voice.example.com ECHO_TOKEN=a-long-random-secret npm run desktop
```

To enable local Codex control, expose only the project directories you trust:

```bash
ECHO_RELAY_URL=https://voice.example.com \
ECHO_TOKEN=a-long-random-secret \
ECHO_CODEX_WORKSPACES=echo=/Users/john/workspace/projects/echo,metio=/Users/john/workspace/projects/metio \
npm run desktop
```

On macOS, you can manage the desktop agent with launchd:

```bash
cat > .env <<'EOF'
ECHO_RELAY_URL=https://echo.554119401.xyz
ECHO_TOKEN=a-long-random-secret
ECHO_CODEX_WORKSPACES=echo=/Users/john/workspace/projects/echo,metio=/Users/john/workspace/projects/metio
ECHO_PROXY_URL=system
EOF

npm run desktop:mac -- install
npm run desktop:mac -- settings
npm run desktop:mac -- status
npm run desktop:mac -- doctor
npm run desktop:mac -- logs
```

Other commands: `start`, `stop`, `restart`, `settings`, `doctor`, `uninstall`, `print-env`.

For a native desktop settings window, install the lightweight Electron shell once:

```bash
npm run desktop:app:install
npm run desktop:app
```

To create a double-clickable macOS launcher:

```bash
npm run desktop:mac:app
open "dist/Echo Voice.app"
```

To create a local DMG from that launcher:

```bash
npm run desktop:mac:dmg
```

`desktop:mac -- settings` uses the native window when it is installed, and falls back to the local browser page otherwise. The UI can update relay, VPN/proxy, local model, STT, and Codex workspace settings without editing `.env` directly.

The native window also installs a menu bar item. Closing the settings window hides it instead of quitting, and the menu bar item can reopen settings, start/stop/restart the desktop agent, run the network doctor, and open agent logs.

The Overview tab checks the relay config, launchd agent, Accessibility permission, clipboard command, Codex CLI, and allowlisted workspaces. On macOS, grant Accessibility permission if auto-paste reports `needs permission`.

You can check the paste helper directly:

```bash
npm run desktop:mac -- paste-helper
```

The helper app lives at `~/Applications/Echo Paste Helper.app` with the stable bundle id `xyz.554119401.echo.paste-helper`. Echo reuses the existing signed helper at runtime; it does not rebuild it just because the source file changed, since rebuilding an ad-hoc signed helper can make macOS treat it as a different Accessibility client.

The Overview tab also shows a pairing QR code. Scan it from the phone to open the mobile UI with the pairing token already attached, so the phone page no longer needs a manually pasted token.

If web login is enabled, the phone page asks for the configured user before it accepts the paired token. Browser users send both a login session and the pairing token; desktop agents still authenticate with `ECHO_TOKEN` only.

In internet relay mode, phone-side refinement runs on the relay server. The desktop settings page can test that live relay refinement path, but changing local model fields only affects local mode and local diagnostics. The desktop-side model fields that matter during relay mode are the Codex settings (`ECHO_CODEX_MODEL`, `ECHO_CODEX_PROFILE`, and workspace/sandbox options), because those control the local `codex exec` process.

### VPN And Proxy

Internet relay mode is VPN-friendly by design: the phone and the Mac both make outbound HTTPS requests to the public relay, so they do not need to be on the same LAN.

For VPN clients that expose a local HTTP/mixed proxy, set:

```bash
ECHO_PROXY_URL=system
```

On macOS this makes the desktop agent follow the current System Settings HTTP/HTTPS proxy. You can also pin a proxy explicitly, for example `ECHO_PROXY_URL=http://127.0.0.1:7897`. SOCKS-only proxy URLs are not supported directly; expose an HTTP or mixed proxy port instead.

After changing network settings, restart and run the doctor:

```bash
npm run desktop:mac -- restart
npm run desktop:mac -- doctor
```

Open `https://voice.example.com/?token=a-long-random-secret` on the phone. See [docs/internet-deploy.md](docs/internet-deploy.md) for Nginx, systemd, and HTTPS notes.

## Model Setup

For OpenAI speech-to-text, set:

```bash
OPENAI_API_KEY=sk-...
STT_PROVIDER=openai
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
```

For a local Whisper ASR Webservice, set:

```bash
STT_PROVIDER=local
LOCAL_STT_URL=http://YOUR_SERVER:9000/asr
LOCAL_STT_FILE_FIELD=audio_file
```

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

If no post-processing provider is configured, Echo Voice falls back to a conservative rule-based cleanup.

If server-side STT is not configured, Android Chrome can fall back to the browser Web Speech API when available. In that mode the browser produces the raw transcript, then the server still performs the structured refinement step.

## Desktop Insertion

The agent copies the final text to the system clipboard and then simulates paste:

- macOS: `pbcopy` plus a small Swift paste helper, with AppleScript as a fallback. Requires Accessibility permission for `~/Applications/Echo Paste Helper.app`.
- Windows: PowerShell clipboard plus `Ctrl+V` SendKeys.
- Linux: `wl-copy` or `xclip`/`xsel`, then `xdotool` or `wtype` when available.

Set `INSERT_MODE=copy` to only copy text to the clipboard.

In relay mode, the public server never pastes into your computer directly. It only queues text; the desktop agent makes outbound HTTPS requests, pulls jobs, and performs the paste locally.

## Mobile Codex Remote

The first Codex remote mode is intentionally conservative:

- The phone can submit prompts, but cannot choose arbitrary filesystem paths or shell commands.
- The desktop agent only runs `codex exec` inside `ECHO_CODEX_WORKSPACES`.
- The default sandbox is `workspace-write`.
- The relay receives job logs and final messages so the phone can monitor progress.

Interactive TUI mirroring is a later layer on top of Codex `app-server`; this MVP uses `codex exec --json` because it is stable enough for one-shot engineering tasks from mobile.

## Product Shape

This MVP is designed around the main idea: speaking is fast, but sending raw spoken text into an AI chat is often mentally leaky. Echo Voice makes the phone the composition surface, so the user can pause, inspect, edit, and send a more deliberate version to the desktop cursor.
