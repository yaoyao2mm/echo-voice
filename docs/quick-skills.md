# Echo 快速指令

快速指令把移动端右上角原来的单一“提交推送部署”按钮扩展成一个可管理的指令入口。它的定位是让手机端快速复用常见 Codex 任务，而不是暴露远程 shell 或任意路径执行能力。

## 功能概览

- 右上角按钮现在打开“快速指令”面板，图标使用左轮弹巢隐喻。
- 指令分为两个范围：
  - 全局：所有 Echo 项目都可见。
  - 项目：只在当前项目 ID 下可见。
- Echo 会在 relay SQLite 中保存指令，因此同一 relay/配对环境可以持续复用。
- 默认内置一个全局“提交推送部署”指令，保留旧按钮的核心能力。
- 手机端可以新增、编辑、删除指令。
- 指令可以选择执行模式：
  - 执行：直接让 Codex 执行任务。
  - 计划：以计划模式发送给 Codex。
- 指令可以标记“需要当前会话”。这类指令必须在一个可继续且没有待处理工作的会话上运行，适合“部署当前结果”“总结当前线程”等依赖上下文的任务。

## 使用方式

1. 打开手机端 Echo，完成登录和桌面配对。
2. 点击右上角快速指令按钮。
3. 在“全局”或“项目”分组里点击一个指令，Echo 会把保存的 prompt 发送给 Codex。
4. 点击面板右上角 `+` 可以新增指令。
5. 点击某个指令右侧的“编辑”可以修改名称、范围、模式、说明、正文和是否需要当前会话。

运行指令时仍会经过 Echo 原来的会话发送路径：

- 当前输入框有未发送内容或截图时，Echo 会要求先发送或清空，避免把草稿和快捷指令混在一起。
- 图片还在处理时不会发送。
- 桌面 agent 不在线或当前项目不可执行时不会发送。
- 标记为“需要当前会话”的指令不会在空会话、归档会话、正在运行的会话或有待审批/待选择的会话上运行。

## 数据模型

快速指令存储在 relay 的 SQLite 数据库中，数据库位置沿用 Echo 现有配置：

```text
~/.echo-voice/echo.sqlite
```

新增表：

```sql
codex_quick_skills (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('execute', 'plan')) DEFAULT 'execute',
  requires_session INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
)
```

删除采用软删除，写入 `archived_at`，这样可以避免误删后迁移冲突，并保留以后做恢复/审计的空间。

## API

所有接口仍在 `/api` 认证和配对 token 保护下，仅 relay 模式可用。

```http
GET /api/codex/quick-skills?projectId=echo
```

返回全局指令和指定项目的项目指令。

```http
POST /api/codex/quick-skills
```

创建指令。请求体字段：

```json
{
  "scope": "project",
  "projectId": "echo",
  "title": "发布检查",
  "description": "运行 Echo 发布前检查",
  "prompt": "请按 Echo 发布前检查清单执行。",
  "mode": "execute",
  "requiresSession": true
}
```

```http
POST /api/codex/quick-skills/:id
```

更新指令，字段同创建接口。

```http
POST /api/codex/quick-skills/:id/delete
```

软删除指令。

## 安全边界

快速指令只是保存和复用 prompt，不会新增任意路径、任意 shell 或绕过桌面 agent 的 API。

- 手机端仍只能在桌面 agent 广告出来的项目内发起 Codex 会话。
- Codex 执行仍由桌面 agent 完成。
- 权限、模型、推理强度和 worktree 模式仍走现有 runtime 草稿与桌面策略。
- 标记为“需要当前会话”的指令只复用当前 Echo 会话上下文，不会读取仓库中的额外文件。
- 默认部署指令明确要求不 force push、不绕过分支保护、不提交无关文件。

## 后续可扩展点

- 增加指令排序和拖拽。
- 支持从已发送消息一键保存为快速指令。
- 支持项目模板，由桌面端显式广告默认项目指令，但仍由 Echo relay 保存用户编辑结果。
- 支持只读的团队预设和用户私有指令分层。
