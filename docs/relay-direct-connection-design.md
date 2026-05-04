# Relay Direct Connection Design

## 背景

当前 Echo 的移动端会话链路是：

```txt
手机/PWA -> relay -> desktop agent -> 本地 Codex
本地 Codex -> desktop agent -> relay -> 手机/PWA
```

这个设计的优点是简单可靠：

- desktop agent 只发起出站 HTTPS 请求，不暴露本机端口。
- relay 统一处理登录、配对、队列、SQLite 会话状态和 SSE 事件流。
- 手机断线、relay 重启、desktop agent 重启后，近期会话仍可恢复。

但如果 relay 部署在美国，而手机和 desktop agent 主要在中国大陆使用，实时体验会变差。所有会话消息、日志事件、审批、取消、截图、未来文件浏览和 Git diff 都需要跨境往返。对于长任务，模型本身可能仍是主要耗时；但对于远程控制手感，relay 位置会明显影响响应速度。

## 目标判断

将 relay 降级为“只牵线搭桥”是可行的，但不建议一步到位把现有 relay 改成纯 signaling 服务并移除所有队列和状态能力。

推荐目标是混合架构：

```txt
relay:
  - 控制面
  - 登录、配对、agent presence
  - desktop policy/capabilities 发布
  - WebRTC signaling
  - 短期连接票据
  - fallback 队列
  - 极简会话索引和完成摘要

desktop agent:
  - 数据面
  - 本地 Codex app-server stdio
  - 完整 session/event 本地持久化
  - Git summary
  - 文件树、文件预览、diff
  - 审批、取消、follow-up 的实际执行

mobile/PWA:
  - 默认尝试 direct data channel
  - 直连成功时走直连
  - 直连失败时自动降级到 relay 路径
```

也就是：**relay 做控制面，手机和 desktop agent 尽量走直连数据面；直连失败时保留 relay fallback。**

## 两种“牵线”的区别

需要区分两个方案。

### 只减少 relay 状态

如果 relay 不再存 SQLite、不管会话状态，但手机和 desktop agent 的所有字节仍然经过美国 relay 转发，那么速度收益有限。跨境路径仍在：

```txt
手机 -> 美国 relay -> desktop agent
desktop agent -> 美国 relay -> 手机
```

这只能减少 relay 存储和应用复杂度，不能根本改善实时延迟。

### relay 只做 signaling

真正能解决慢的问题，是让 relay 只负责登录、配对、连接协商和 fallback。协商完成后：

```txt
手机/PWA <-> desktop agent
```

会话消息、事件流、审批、取消、文件浏览、Git diff 等走直连数据通道。这个方案才是主要优化方向。

## 预期收益

### 延迟下降

审批、取消、follow-up、文件浏览和日志滚动可以从跨境 relay 往返变成局域网、国内网络或 P2P 路径。在手机和 desktop 处于同一 Wi-Fi 时，远程控制体验会接近本地控制台。

### 隐私改善

relay 不再需要长期保存完整 prompts、日志、审批 payload、附件、文件预览和 Git diff。relay 可以只看到账号、设备、连接状态和少量摘要元数据。

### relay 运维压力下降

SSE 长连接、事件日志、附件、文件树、文件预览和 diff 都会占用 relay 带宽和存储。数据面下沉到 desktop 后，relay 可以变轻，数据库也不再是核心状态源。

### 安全爆炸半径变小

relay 被攻破时，可获取的数据范围会减少。理想状态下，攻击者拿不到完整会话日志、文件内容和本地执行细节，只能看到有限的连接元数据和摘要。

## 主要风险

### 直连不一定成功

中国大陆家庭宽带、移动网络、公司网络经常有 NAT、CGNAT、对称 NAT、防火墙等问题。WebRTC P2P 有机会打洞成功，但不能保证。

如果 P2P 失败，需要 TURN 中继。如果 TURN 仍然部署在美国，速度问题会回来。因此需要：

- 保留现有 relay fallback。
- 或部署更近的 TURN/relay，例如香港、新加坡、日本。
- 或支持用户自建可达节点。

### PWA 浏览器限制

从 `https://relay.example.com` 加载的 PWA 如果直接访问 `http://192.168.x.x:port`，会遇到 mixed content、CORS、Private Network Access、iOS Safari 差异和证书信任问题。

因此不建议先做“手机直连桌面 HTTP/WebSocket 端口”。更合适的初始方案是 **WebRTC DataChannel**：

- 页面仍由 HTTPS relay 提供。
- 数据通道端到端加密。
- 不要求用户配置端口映射和本地 HTTPS 证书。
- signaling 仍可通过 relay 完成。

### 状态权威要迁移

当前 relay 不只是转发，它还承担：

- 登录和配对。
- session SQLite 存储。
- session commands 队列。
- SSE 事件流。
- approval/interaction 等待。
- 归档、历史恢复和状态查询。

如果 relay 只做 signaling，这些状态需要迁移到 desktop agent，或做双写，或明确放弃部分离线体验。relay 变简单不代表系统总复杂度一定下降，复杂度会转移到 desktop agent 和直连协议。

### 离线和异步能力会受影响

现有模式下，手机可以把任务提交到 relay，desktop agent 后上线再取。手机断线后，也可以回到 relay 读取会话状态。

纯直连模式下：

- desktop 离线时手机无法提交任务。
- 手机断线时无法收到事件。
- 任务执行中的事件必须由 desktop 本地保存，并在手机重连后同步。

因此 relay 应保留最小 fallback 队列和关键状态摘要。

### 安全边界更敏感

Echo 的产品边界是远程 Codex 控制面，不是远程 shell。直连后也不能让手机获得任意本地能力。

必须继续保证：

- 不暴露 Codex app-server 到公网。
- 不提供任意 shell API。
- 不接受任意文件路径。
- 文件浏览限制在 desktop-advertised workspaces 或会话 worktree 内。
- 风险策略来自 desktop-advertised policy，而不是手机任意字符串。
- Codex approval 仍然需要显式移动端决策。

## 推荐连接协议

推荐使用 WebRTC DataChannel，而不是桌面 HTTP/WebSocket 公网端口。

连接流程：

```txt
1. 手机向 relay 请求连接某个 desktop agent。
2. relay 校验用户登录、配对 token 和 agent 权限。
3. relay 通知 desktop agent 准备直连。
4. desktop agent 生成 WebRTC offer 和临时 capability。
5. 手机生成 answer。
6. 双方通过 relay 交换 ICE candidates。
7. DataChannel 打开后，relay 不再转发会话内容。
8. 直连失败或超时后，手机自动降级到 relay fallback。
```

建议直连握手设置短超时，例如 4-8 秒。用户体验上显示：

```txt
直连中
经 relay 中转
桌面离线
```

## DataChannel 内部协议

直连通道不应暴露低层命令，而应复用现有 API 语义，封装成 RPC/event envelope。

请求：

```json
{
  "id": "req_123",
  "type": "request",
  "method": "sessions.enqueueMessage",
  "params": {
    "sessionId": "...",
    "text": "..."
  }
}
```

响应：

```json
{
  "id": "req_123",
  "type": "response",
  "ok": true,
  "result": {}
}
```

事件：

```json
{
  "type": "event",
  "topic": "sessions/.../events",
  "payload": {
    "events": []
  }
}
```

这样 mobile UI 可以逐步把 transport 从 HTTP/SSE 抽象成：

- `relayTransport`
- `directTransport`

业务层尽量不关心底层走 relay 还是直连。

## 直连票据和权限

relay 签发短期 capability token，desktop agent 必须验证。

票据至少绑定：

- `userId`
- `agentId`
- `deviceId`
- `projectId` 或允许的 project scope
- `sessionId` 可选
- `scopes`，例如 `sessions:read`、`sessions:write`、`files:read`
- `expiresAt`
- `nonce`

要求：

- 短有效期，例如 1-5 分钟。
- 直连建立后可换取更短周期的会话 token。
- desktop 可以撤销设备。
- token 不允许扩大 desktop-advertised policy。
- relay fallback 也必须遵守同一 policy。

## 功能迁移顺序

### 阶段 1：直连探测和文件浏览

优先迁移只读、可降级、不会破坏任务的能力。

内容：

- WebRTC DataChannel signaling MVP。
- 手机显示直连状态。
- 文件树 `list` 走直连。
- 文本文件预览 `read` 走直连。
- 失败时提示“直连后可浏览文件”，或降级到 relay 短 TTL 请求。

理由：

- 文件浏览数据量较大。
- 文件内容敏感，不适合长期经过 relay。
- 失败不会影响核心 Codex 会话。

### 阶段 2：session event stream

将实时日志和事件流从 relay SSE 迁到 direct event stream。

保留：

- relay SSE fallback。
- desktop 本地事件持久化。
- 手机重连后按 event cursor 补齐。

收益：

- 日志滚动更实时。
- relay 长连接压力下降。

### 阶段 3：follow-up、approval、cancel

迁移会影响任务控制的写操作。

要求：

- 幂等 request id。
- 重放保护。
- command 状态同步。
- relay fallback 不重复执行。
- approval 决策必须可追溯。

### 阶段 4：relay 状态瘦身

在直连稳定后，再减少 relay 存储：

- 完整 events 下沉到 desktop。
- relay 只保留 session index、状态摘要和关键通知。
- 附件、artifact、文件预览、diff 默认不落 relay。
- 离线时只排最小任务或提示 desktop 离线。

## relay 仍应保留的职责

即使直连成熟，relay 也不应完全消失。建议保留：

- 用户认证。
- 设备配对。
- agent presence。
- desktop capabilities/policy 广告。
- WebRTC signaling。
- 短期 capability 签发。
- fallback 队列。
- 最近会话摘要。
- 关键通知，例如需要审批、任务完成、任务失败。

这些能力让 Echo 仍然是“手机远程控制本地 Codex”的产品，而不是一个需要用户自己配置网络穿透的工具。

## 可替代的短期方案

如果目标是先解决慢，而不是立即重构直连，可以先把 relay 部署到更近区域。

优先级：

```txt
香港/新加坡/日本 relay
国内可达自建 relay
美国 relay
```

优点：

- 架构不变。
- 风险最低。
- 可以快速改善延迟。

缺点：

- prompts、日志、附件和未来文件内容仍然经过 relay。
- relay 仍然承担主要带宽和存储压力。
- 隐私收益有限。

也可以支持多 relay，但会引入会话归属、数据同步、agent 绑定和故障切换复杂度，不应作为第一优先级。

## 结论

relay 只做牵线搭桥在技术上可行，但纯 signaling 模式会牺牲当前 relay 提供的队列、恢复和状态统一能力。

推荐路线是：

```txt
直连优先
relay 控制面
relay fallback
desktop 本地持久化完整状态
逐步把大内容和实时事件从 relay 挪到 desktop
```

第一步建议实现：

- WebRTC 直连探测。
- 文件浏览走直连。
- 失败时保留 relay fallback 或明确提示。

如果该路径在主要网络环境中稳定，再迁移 session event stream、approval、cancel 和 follow-up。这样可以获得主要性能和隐私收益，同时控制架构风险。
