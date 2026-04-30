# Echo Codex

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.x-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**中文** | [English](#english)

Echo Codex is a mobile control surface for local Codex work. It lets you capture a task on your phone, send it through a relay, run Codex on your desktop, and watch progress without exposing your local machine to inbound internet traffic.

## 中文

### 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [架构](#架构)
- [快速开始](#快速开始)
- [配置](#配置)
- [安全与隐私](#安全与隐私)
- [开发](#开发)
- [文档](#文档)
- [许可证](#许可证)

### 项目简介

Echo Codex 把手机变成 Codex 的轻量移动端入口：

- 在手机上用键盘或系统语音输入快速记录想法。
- 选择桌面端预先授权的项目目录。
- 通过公网 relay 或本地/LAN 服务提交任务。
- 由桌面 agent 在本机启动 Codex app-server 并执行任务。
- 在手机上查看会话、日志、最终回复，并处理命令或文件修改审批。

项目边界很明确：手机负责捕获、查看和确认；relay 负责认证、排队和状态存储；桌面 agent 才能接触本地仓库和运行 Codex。

### 功能特性

- **手机优先的 PWA**：适合移动端的会话列表、任务输入、项目选择、日志查看和审批操作。
- **交互式 Codex 会话**：通过本地 `codex app-server` 支持新会话、继续会话、归档/恢复会话和最终结果查看。
- **受控项目访问**：手机只能选择 `ECHO_CODEX_WORKSPACES` 中的目录，不能提交任意本机路径或远程 shell 命令。
- **审批流转发**：Codex 请求执行命令或应用补丁时，relay 会把审批请求展示到手机端，由用户显式批准或拒绝。
- **持久化队列**：relay 使用 SQLite 保存会话、事件、审批、agent 心跳、租约和最终消息。
- **本地/LAN 与公网 relay 两种模式**：本地调试简单，公网 relay 适合手机和电脑不在同一网络时使用。
- **提示词整理**：支持 OpenAI-compatible 接口、Volcengine Ark、Ollama，也可以退回到规则清理。
- **macOS 桌面体验**：可生成 `Echo Codex.app`，提供设置窗口、菜单栏入口、项目目录管理、配对二维码、网络诊断和更新入口。
- **VPN/代理友好**：桌面 agent 只发起出站 HTTPS 请求，并可跟随 macOS 系统 HTTP/HTTPS 代理。

### 架构

```text
Phone PWA
  |  HTTPS / token / optional login
  v
Relay server (Node.js + Express)
  |  SQLite session queue, approvals, events, agent leases
  v
Desktop agent
  |  stdio
  v
Local Codex app-server
  |
  v
Allowlisted local workspaces
```

核心模块：

- `public/`：手机端 PWA、会话工作台、登录、配对和 Codex 控制界面。
- `src/server.js`：Express relay/local server，提供认证、prompt refinement、Codex 会话和 agent API。
- `src/desktop-agent.js`：桌面 agent，轮询 relay、公布授权项目、运行本地 Codex 会话并回传事件。
- `src/lib/codex*.js`：Codex app-server 客户端、交互式运行时、队列和 SQLite 存储。
- `desktop-settings/` 和 `desktop-app/`：macOS 设置窗口和原生桌面壳。
- `scripts/`：Android USB 转发、macOS app/DMG 构建、网络诊断和 relay 部署脚本。
- `docs/`：公网部署、移动端 Codex remote 设计和路线图。

### 快速开始

#### 环境要求

- Node.js 20+
- pnpm 10+
- 已安装并登录官方 Codex App，或提供可用的 `codex` 命令
- 使用公网 relay 时，需要一个可信的 HTTPS 域名

#### 本地/LAN 模式

```bash
pnpm install
cp .env.example .env
pnpm start
```

启动后打开终端打印的手机 URL。URL 中包含配对 token，没有 token 的 API 请求会被拒绝。

Android 浏览器通常需要安全上下文才能使用摄像头扫码。开发时可以使用 USB 转发：

```bash
pnpm run android:usb
```

如果要在 LAN 中使用 HTTPS，请在 `.env` 中配置证书：

```bash
HTTPS_CERT=/absolute/path/to/cert.pem
HTTPS_KEY=/absolute/path/to/key.pem
```

#### 公网 relay 模式

在服务器上配置 `.env`：

```bash
ECHO_MODE=relay
ECHO_PUBLIC_URL=https://your-domain.example
ECHO_TOKEN=replace-with-a-long-random-secret

ECHO_AUTH_ENABLED=true
ECHO_AUTH_USERNAME=owner
ECHO_AUTH_PASSWORD=replace-with-a-strong-password

POSTPROCESS_PROVIDER=openai
LLM_API_KEY=replace-with-your-api-key
LLM_MODEL=gpt-4.1-mini
```

启动 relay：

```bash
pnpm install
pnpm run relay
```

在运行 Codex 的电脑上启动桌面 agent：

```bash
ECHO_RELAY_URL=https://your-domain.example \
ECHO_TOKEN=replace-with-a-long-random-secret \
ECHO_CODEX_WORKSPACES=app=/absolute/path/to/project \
pnpm run desktop
```

打开手机 URL：

```text
https://your-domain.example/?token=replace-with-a-long-random-secret
```

#### macOS 桌面应用

生成并打开本地 app：

```bash
pnpm run desktop:mac:app
pnpm run desktop:mac -- app
```

常用命令：

```bash
pnpm run desktop:mac -- status
pnpm run desktop:mac -- settings
pnpm run desktop:mac -- doctor
pnpm run desktop:mac -- logs
pnpm run desktop:mac -- restart
```

创建本地 DMG：

```bash
pnpm run desktop:mac:dmg
```

### 配置

常用环境变量：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `ECHO_MODE` | `local` 或 `relay` | `local` |
| `ECHO_HOST` | 服务监听地址 | `0.0.0.0` |
| `ECHO_PORT` | 服务端口 | `3888` |
| `ECHO_PUBLIC_URL` | relay 对外 HTTPS 地址 | 空 |
| `ECHO_RELAY_URL` | 桌面 agent 连接的 relay 地址 | 空 |
| `ECHO_TOKEN` | 手机和 agent 使用的配对密钥 | 启动时随机生成 |
| `ECHO_AUTH_ENABLED` | 是否开启网页登录 | 根据用户配置自动判断 |
| `ECHO_CODEX_WORKSPACES` | Codex 可访问的项目 allowlist | 当前目录 |
| `ECHO_CODEX_SANDBOX` | Codex sandbox 模式 | `workspace-write` |
| `ECHO_CODEX_APPROVAL_POLICY` | Codex 审批策略 | `on-request` |
| `ECHO_PROXY_URL` | 出站代理，macOS 可用 `system` | 空 |
| `POSTPROCESS_PROVIDER` | `auto`、`openai`、`volcengine`、`ollama`、`rules`、`none` | `auto` |

`ECHO_CODEX_WORKSPACES` 支持逗号分隔的 `label=/absolute/path`：

```bash
ECHO_CODEX_WORKSPACES=frontend=/absolute/path/to/frontend,api=/absolute/path/to/api
```

OpenAI-compatible prompt refinement：

```bash
POSTPROCESS_PROVIDER=openai
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=replace-with-your-api-key
LLM_MODEL=gpt-4.1-mini
```

Volcengine Ark：

```bash
POSTPROCESS_PROVIDER=volcengine
VOLCENGINE_CODING_API_KEY=replace-with-your-api-key
VOLCENGINE_CODING_OPENAI_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
VOLCENGINE_CODING_CHAT_MODEL=ark-code-latest
```

Ollama：

```bash
POSTPROCESS_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
```

### 安全与隐私

- 使用公网 relay 时必须启用 HTTPS。
- `ECHO_TOKEN` 是配对密钥，建议使用长随机字符串并避免提交到仓库。
- 手机不能指定任意本机路径；可选项目来自桌面 agent 的 `ECHO_CODEX_WORKSPACES`。
- 桌面 agent 只主动连接 relay，不需要把本机端口暴露到公网。
- relay 会保存 prompt、会话事件、审批记录、Codex 日志和最终回复；请部署在你信任的基础设施上。
- 默认 sandbox 是 `workspace-write`。只有在完全信任当前电脑和项目时，才考虑 `danger-full-access`。
- SQLite 数据默认位于 `~/.echo-voice/echo.sqlite`，如包含敏感会话内容，请按需备份、清理或加密宿主机磁盘。

### 开发

```bash
pnpm install
pnpm run dev
```

检查和测试：

```bash
pnpm run check
pnpm run test
pnpm run test:e2e:mobile
```

网络诊断：

```bash
pnpm run doctor:network
```

部署 relay：

```bash
pnpm run deploy:relay -- user@your-server /opt/echo-codex
```

### 文档

- [Internet deployment](docs/internet-deploy.md)
- [Mobile Codex remote plan](docs/mobile-codex-remote-plan.md)
- [Mobile Codex roadmap](docs/mobile-codex-roadmap.md)

### 许可证

[MIT](LICENSE)

## English

### Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Security and Privacy](#security-and-privacy)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

### Overview

Echo Codex turns your phone into a lightweight mobile entry point for Codex:

- Capture ideas with the mobile keyboard or native dictation.
- Choose a project directory that was explicitly allowed by the desktop agent.
- Submit work through a public relay or a local/LAN server.
- Run Codex on the desktop through the local Codex app-server.
- Review sessions, logs, final answers, and command/file-change approvals from the phone.

The boundary is intentional: the phone captures and reviews, the relay authenticates and stores queue state, and the desktop agent is the only process that can touch local repositories or run Codex.

### Features

- **Phone-first PWA**: mobile session list, composer, project picker, logs, and approval controls.
- **Interactive Codex sessions**: start, continue, archive, restore, and inspect Codex app-server backed conversations.
- **Controlled workspace access**: the phone can only select entries from `ECHO_CODEX_WORKSPACES`; it cannot send arbitrary local paths or shell commands.
- **Approval forwarding**: command execution and patch approval requests are surfaced on the phone for explicit approve/deny decisions.
- **Persistent queue**: SQLite-backed sessions, events, approvals, agent heartbeats, leases, and final messages.
- **Local/LAN and internet relay modes**: simple local testing plus a public relay mode for phone and desktop devices on different networks.
- **Prompt refinement**: OpenAI-compatible endpoints, Volcengine Ark, Ollama, and rule-based cleanup fallback.
- **macOS desktop experience**: local `Echo Codex.app`, settings window, menu bar item, workspace manager, pairing QR code, network doctor, and updater.
- **VPN/proxy friendly**: the desktop agent only makes outbound HTTPS requests and can follow the macOS system HTTP/HTTPS proxy.

### Architecture

```text
Phone PWA
  |  HTTPS / token / optional login
  v
Relay server (Node.js + Express)
  |  SQLite session queue, approvals, events, agent leases
  v
Desktop agent
  |  stdio
  v
Local Codex app-server
  |
  v
Allowlisted local workspaces
```

Core modules:

- `public/`: mobile PWA, session workbench, login, pairing, and Codex controls.
- `src/server.js`: Express relay/local server for auth, prompt refinement, Codex sessions, and agent APIs.
- `src/desktop-agent.js`: desktop agent that polls the relay, publishes allowlisted projects, runs local Codex sessions, and reports events.
- `src/lib/codex*.js`: Codex app-server client, interactive runtime, queue, and SQLite storage.
- `desktop-settings/` and `desktop-app/`: macOS settings UI and native desktop wrapper.
- `scripts/`: Android USB forwarding, macOS app/DMG builds, network diagnostics, and relay deployment.
- `docs/`: internet deployment notes, mobile Codex remote design, and roadmap.

### Quick Start

#### Requirements

- Node.js 20+
- pnpm 10+
- Official Codex App installed and signed in, or an available `codex` command
- A trusted HTTPS domain for internet relay mode

#### Local/LAN Mode

```bash
pnpm install
cp .env.example .env
pnpm start
```

Open the printed phone URL. The URL includes a pairing token; API requests without that token are rejected.

Android browsers usually require a secure context for camera-based QR pairing. For development, use USB forwarding:

```bash
pnpm run android:usb
```

For HTTPS on LAN, configure a trusted certificate in `.env`:

```bash
HTTPS_CERT=/absolute/path/to/cert.pem
HTTPS_KEY=/absolute/path/to/key.pem
```

#### Internet Relay Mode

Create `.env` on the relay host:

```bash
ECHO_MODE=relay
ECHO_PUBLIC_URL=https://your-domain.example
ECHO_TOKEN=replace-with-a-long-random-secret

ECHO_AUTH_ENABLED=true
ECHO_AUTH_USERNAME=owner
ECHO_AUTH_PASSWORD=replace-with-a-strong-password

POSTPROCESS_PROVIDER=openai
LLM_API_KEY=replace-with-your-api-key
LLM_MODEL=gpt-4.1-mini
```

Start the relay:

```bash
pnpm install
pnpm run relay
```

Start the desktop agent on the machine that should run Codex:

```bash
ECHO_RELAY_URL=https://your-domain.example \
ECHO_TOKEN=replace-with-a-long-random-secret \
ECHO_CODEX_WORKSPACES=app=/absolute/path/to/project \
pnpm run desktop
```

Open the phone URL:

```text
https://your-domain.example/?token=replace-with-a-long-random-secret
```

#### macOS Desktop App

Build and open the local app:

```bash
pnpm run desktop:mac:app
pnpm run desktop:mac -- app
```

Useful commands:

```bash
pnpm run desktop:mac -- status
pnpm run desktop:mac -- settings
pnpm run desktop:mac -- doctor
pnpm run desktop:mac -- logs
pnpm run desktop:mac -- restart
```

Create a local DMG:

```bash
pnpm run desktop:mac:dmg
```

### Configuration

Common environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `ECHO_MODE` | `local` or `relay` | `local` |
| `ECHO_HOST` | Server bind host | `0.0.0.0` |
| `ECHO_PORT` | Server port | `3888` |
| `ECHO_PUBLIC_URL` | Public HTTPS URL for the relay | empty |
| `ECHO_RELAY_URL` | Relay URL used by the desktop agent | empty |
| `ECHO_TOKEN` | Pairing secret for phone and agent requests | random on startup |
| `ECHO_AUTH_ENABLED` | Enable browser login | inferred from user config |
| `ECHO_CODEX_WORKSPACES` | Allowlisted Codex project directories | current directory |
| `ECHO_CODEX_SANDBOX` | Codex sandbox mode | `workspace-write` |
| `ECHO_CODEX_APPROVAL_POLICY` | Codex approval policy | `on-request` |
| `ECHO_PROXY_URL` | Outbound proxy; `system` follows macOS system proxy | empty |
| `POSTPROCESS_PROVIDER` | `auto`, `openai`, `volcengine`, `ollama`, `rules`, or `none` | `auto` |

`ECHO_CODEX_WORKSPACES` accepts comma-separated `label=/absolute/path` entries:

```bash
ECHO_CODEX_WORKSPACES=frontend=/absolute/path/to/frontend,api=/absolute/path/to/api
```

OpenAI-compatible prompt refinement:

```bash
POSTPROCESS_PROVIDER=openai
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=replace-with-your-api-key
LLM_MODEL=gpt-4.1-mini
```

Volcengine Ark:

```bash
POSTPROCESS_PROVIDER=volcengine
VOLCENGINE_CODING_API_KEY=replace-with-your-api-key
VOLCENGINE_CODING_OPENAI_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
VOLCENGINE_CODING_CHAT_MODEL=ark-code-latest
```

Ollama:

```bash
POSTPROCESS_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
```

### Security and Privacy

- Use HTTPS for internet relay mode.
- Treat `ECHO_TOKEN` as a pairing secret. Use a long random value and never commit it.
- The phone cannot choose arbitrary local paths; projects come from the desktop agent's `ECHO_CODEX_WORKSPACES`.
- The desktop agent only opens outbound connections to the relay; it does not require inbound access to the desktop.
- The relay stores prompts, session events, approval records, Codex logs, and final answers. Run it on infrastructure you trust.
- The default sandbox is `workspace-write`. Use `danger-full-access` only on a fully trusted personal machine and project.
- SQLite data is stored at `~/.echo-voice/echo.sqlite` by default. Back it up, prune it, or encrypt the host disk if session history is sensitive.

### Development

```bash
pnpm install
pnpm run dev
```

Checks and tests:

```bash
pnpm run check
pnpm run test
pnpm run test:e2e:mobile
```

Network diagnostics:

```bash
pnpm run doctor:network
```

Deploy the relay:

```bash
pnpm run deploy:relay -- user@your-server /opt/echo-codex
```

### Documentation

- [Internet deployment](docs/internet-deploy.md)
- [Mobile Codex remote plan](docs/mobile-codex-remote-plan.md)
- [Mobile Codex roadmap](docs/mobile-codex-roadmap.md)

### License

[MIT](LICENSE)
