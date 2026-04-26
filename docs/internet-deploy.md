# Internet Deployment

Echo Voice internet mode has two processes:

- Relay server on your VPS/domain: hosts the phone PWA, runs STT/refinement, and queues insert jobs.
- Desktop agent on your computer: polls the relay over HTTPS and pastes queued text into the active cursor.

The server does not need inbound access to your computer.

## 1. Server `.env`

On the VPS:

```bash
ECHO_MODE=relay
ECHO_HOST=127.0.0.1
ECHO_PORT=3888
ECHO_PUBLIC_URL=https://voice.example.com
ECHO_TOKEN=replace-with-a-long-random-secret

STT_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe

POSTPROCESS_PROVIDER=openai
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4.1-mini
```

Start it:

```bash
npm install
npm run relay
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
Description=Echo Voice Relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/echo-voice
EnvironmentFile=/opt/echo-voice/.env
ExecStart=/usr/bin/npm run relay
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

## 4. Desktop Agent

On the computer that should receive text:

```bash
ECHO_RELAY_URL=https://voice.example.com ECHO_TOKEN=replace-with-a-long-random-secret npm run desktop
```

macOS requires Accessibility permission for the terminal or packaged app so it can send `Cmd+V`.

## 5. Phone URL

Open:

```text
https://voice.example.com/?token=replace-with-a-long-random-secret
```

HTTPS is required for Android microphone access. The token is your pairing secret, so keep it long and private.

## Security Notes

- Use HTTPS only in internet mode.
- Use a long random `ECHO_TOKEN`; anyone with it can submit text to your desktop queue.
- The relay server receives audio, transcripts, and refined text. Put the relay on infrastructure you trust.
- For multi-user support later, replace the single token with per-device accounts and encrypted queue storage.
