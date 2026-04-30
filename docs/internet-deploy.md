# Internet Deployment

Echo Codex internet mode has two processes:

- Relay server on your VPS/domain: hosts the phone PWA, runs prompt refinement, and queues Codex jobs.
- Desktop agent on your computer: polls the relay over HTTPS and runs queued Codex jobs inside allowlisted local workspaces.

The server does not need inbound access to your computer.

## 1. Server `.env`

On the VPS:

```bash
ECHO_MODE=relay
ECHO_HOST=127.0.0.1
ECHO_PORT=3888
ECHO_PUBLIC_URL=https://voice.example.com
ECHO_TOKEN=replace-with-a-long-random-secret

POSTPROCESS_PROVIDER=openai
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4.1-mini
```

Start it:

```bash
pnpm install
pnpm run relay
```

## 2. Nginx HTTPS Proxy

Point your domain DNS to the VPS, install a certificate with Certbot, then proxy to the Node server:

```nginx
server {
    listen 443 ssl http2;
    server_name voice.example.com;

    ssl_certificate /etc/letsencrypt/live/voice.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/voice.example.com/privkey.pem;

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:3888;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 3. systemd Service

Example service at `/etc/systemd/system/echo-voice.service`:

```ini
[Unit]
Description=Echo Codex Relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/echo-voice
EnvironmentFile=/opt/echo-voice/.env
ExecStart=/usr/bin/env pnpm run relay
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now echo-voice
sudo systemctl status echo-voice
```

## 4. Deploy Updates

From your workstation:

```bash
pnpm run deploy:relay -- root@YOUR_SERVER /opt/echo-voice
```

The script performs a fast-forward pull, runs `pnpm install --prod --frozen-lockfile`, updates the service to `pnpm run relay` if needed, and restarts `echo-voice.service`.

For GitHub Actions deployment, configure these repository secrets:

```text
ECHO_DEPLOY_HOST=YOUR_SERVER
ECHO_DEPLOY_USER=root
ECHO_DEPLOY_PATH=/opt/echo-voice
ECHO_DEPLOY_SERVICE=echo-voice.service
ECHO_DEPLOY_SSH_KEY=<private key with server access>
```

`ECHO_DEPLOY_KNOWN_HOSTS` is optional. If omitted, the workflow uses `ssh-keyscan`.

## 5. Desktop Agent

On the computer that should run local Codex:

```bash
ECHO_RELAY_URL=https://voice.example.com ECHO_TOKEN=replace-with-a-long-random-secret pnpm run desktop
```

To allow mobile control of local Codex, add an explicit workspace allowlist:

```bash
ECHO_RELAY_URL=https://voice.example.com \
ECHO_TOKEN=replace-with-a-long-random-secret \
ECHO_CODEX_WORKSPACES=echo=/Users/john/workspace/projects/echo,metio=/Users/john/workspace/projects/metio \
pnpm run desktop
```

The phone can only choose these workspace ids; it cannot send arbitrary paths or shell commands.

To keep remote Codex work out of your active checkout, enable desktop-controlled worktrees:

```bash
ECHO_CODEX_WORKTREE_MODE=always \
ECHO_CODEX_WORKTREE_ROOT=~/.echo-voice/worktrees \
pnpm run desktop
```

In this mode, each new session requires the selected allowlisted workspace to be a clean Git repository.
The desktop agent creates an `echo/job-...` branch and runs Codex inside the worktree. Follow-up
messages continue in that same worktree.

Codex remote jobs are persisted on the relay in `~/.echo-voice/echo.sqlite`. The desktop agent
registers a stable local agent id and leases each job before running it. Event and completion
updates renew that lease. While a long Codex task is running, the desktop agent also sends quiet
lease heartbeats. If the relay stops seeing updates for `ECHO_CODEX_LEASE_MS`, the job is returned
to the queue for recovery.

If you usually work with a VPN enabled, prefer relay mode and let the desktop agent follow the system proxy:

```bash
ECHO_PROXY_URL=system pnpm run desktop
```

For macOS launchd installs, put `ECHO_PROXY_URL=system` in `.env`, then run:

```bash
pnpm run desktop:mac -- settings
pnpm run desktop:mac -- restart
pnpm run desktop:mac -- doctor
```

`system` follows the macOS HTTP/HTTPS proxy. If your VPN client only exposes SOCKS, enable its HTTP/mixed proxy port and set `ECHO_PROXY_URL=http://127.0.0.1:PORT` instead.

## 6. Phone URL

Open:

```text
https://voice.example.com/?token=replace-with-a-long-random-secret
```

HTTPS is required for browser camera-based QR pairing. The token is your pairing secret, so keep it long and private.

## Security Notes

- Use HTTPS only in internet mode.
- Use a long random `ECHO_TOKEN`; anyone with it can submit Codex jobs to your desktop queue.
- The relay server receives prompts, refined text, Codex logs, and final results. Put the relay on infrastructure you trust.
- Codex remote jobs run locally on the desktop agent inside `ECHO_CODEX_WORKSPACES`; keep that allowlist narrow.
- Back up or intentionally prune `~/.echo-voice/echo.sqlite` if you rely on relay-side job history.
- For multi-user support later, replace the single token with per-device accounts and encrypted queue storage.
