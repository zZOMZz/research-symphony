# Symphony (TypeScript)

Symphony 是一个长期运行的自动化调度服务，持续从 issue tracker 拉取工作，为每个 issue 创建隔离工作区，并在其中运行 coding agent 完成开发任务。

## 快速开始

### 前置条件

- Node.js >= 20
- 一个 [Linear](https://linear.app) 项目和 API key（或其他支持的 tracker）
- 一个已安装的 coding agent（[Codex](https://github.com/openai/codex) 或 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)）

### 安装

```bash
cd typescript
npm install
npm run build
```

### 配置

在你的项目仓库根目录创建 `WORKFLOW.md`：

```markdown
---
tracker:
  kind: linear
  project_slug: your-project-slug
  api_key: $LINEAR_API_KEY

agent:
  backend: codex          # 或 "claude-code"
  max_concurrent_agents: 5
  max_turns: 20

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

hooks:
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
  before_run: |
    git fetch origin && git checkout main && git pull

codex:
  command: codex app-server

# 如果使用 claude-code backend：
# claude_code:
#   command: claude
#   model: claude-sonnet-4-20250514
#   allowed_tools: ["Bash", "Read", "Write", "Edit"]
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}

## Description

{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

## Instructions

- Work in the current directory (already checked out to the correct branch)
- Write tests for any new functionality
- Create a PR when done

{% if attempt %}
This is retry attempt {{ attempt }}. Check what was already done and continue from there.
{% endif %}
```

### 运行

```bash
# 设置环境变量
export LINEAR_API_KEY="lin_api_xxxxx"

# 使用默认 ./WORKFLOW.md
node dist/cli.js

# 指定 workflow 文件路径
node dist/cli.js /path/to/WORKFLOW.md

# 启用 HTTP Dashboard
node dist/cli.js --port 4000

# 开发模式（无需 build）
npx tsx src/cli.ts /path/to/WORKFLOW.md --port 4000
```

### 验证启动

启动成功后你会看到结构化日志输出：

```json
{"level":"info","msg":"symphony_started","ts":"...","tracker":"linear","project":"your-slug","poll_interval_ms":30000,"max_concurrent":5}
```

如果启用了 HTTP server，访问 `http://127.0.0.1:4000` 查看 Dashboard。

---

## 配置参考

所有配置通过 `WORKFLOW.md` 的 YAML front matter 设置。

### tracker

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `kind` | string | `"linear"` | tracker 类型（目前支持 `linear`） |
| `endpoint` | string | `https://api.linear.app/graphql` | API 端点 |
| `api_key` | string | — | API key，支持 `$ENV_VAR` 语法 |
| `project_slug` | string | — | Linear 项目的 slugId |
| `active_states` | string[] | `["Todo", "In Progress"]` | 可调度的 issue 状态 |
| `terminal_states` | string[] | `["Closed", "Cancelled", ...]` | 终态（触发工作区清理） |

### agent

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `backend` | string | `"codex"` | agent 后端：`codex` 或 `claude-code` |
| `max_concurrent_agents` | int | `10` | 全局最大并发数 |
| `max_turns` | int | `20` | 单次 worker 运行内最大 turn 数 |
| `max_retry_backoff_ms` | int | `300000` | 重试退避上限（5 分钟） |
| `max_concurrent_agents_by_state` | map | `{}` | 按状态的并发上限，如 `{"todo": 3}` |

### codex（当 `agent.backend: codex` 时）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `command` | string | `"codex app-server"` | 启动命令 |
| `approval_policy` | string\|object | auto-reject | 审批策略 |
| `thread_sandbox` | string | `"workspace-write"` | 线程沙箱模式 |
| `turn_timeout_ms` | int | `3600000` | 单 turn 超时（1 小时） |
| `stall_timeout_ms` | int | `300000` | 无活动超时（5 分钟） |

### claude_code（当 `agent.backend: claude-code` 时）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `command` | string | `"claude"` | Claude Code CLI 命令 |
| `model` | string | null | 使用的模型 |
| `max_turns` | int | null | Claude Code 的 --max-turns 参数 |
| `allowed_tools` | string[] | `[]` | 允许的工具列表 |

### polling

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `interval_ms` | int | `30000` | poll 间隔（毫秒） |

### workspace

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `root` | path | `<tmpdir>/symphony_workspaces` | 工作区根目录，支持 `~` 和 `$VAR` |

### hooks

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `after_create` | string | null | 新工作区创建后执行 |
| `before_run` | string | null | 每次 agent 运行前执行 |
| `after_run` | string | null | 每次 agent 运行后执行 |
| `before_remove` | string | null | 工作区删除前执行 |
| `timeout_ms` | int | `60000` | hook 超时时间 |

### server

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `port` | int | null | HTTP 端口（设置后启用 HTTP 服务） |
| `host` | string | `"127.0.0.1"` | 绑定地址 |

---

## HTTP API

启用 `--port` 或配置 `server.port` 后可用。

### `GET /`

HTML Dashboard，展示当前运行中的 session、重试队列、token 用量。

### `GET /api/v1/state`

返回全局状态快照：

```json
{
  "generated_at": "2026-06-05T12:00:00Z",
  "counts": { "running": 2, "retrying": 1 },
  "running": [
    {
      "issue_id": "abc123",
      "issue_identifier": "PROJ-42",
      "state": "In Progress",
      "session_id": "thread-1-turn-1",
      "turn_count": 3,
      "last_event": "notification",
      "started_at": "2026-06-05T11:50:00Z",
      "tokens": { "input_tokens": 5000, "output_tokens": 2000, "total_tokens": 7000 }
    }
  ],
  "retrying": [...],
  "codex_totals": { "input_tokens": 50000, "output_tokens": 20000, "total_tokens": 70000, "seconds_running": 3600 },
  "rate_limits": null
}
```

### `GET /api/v1/:identifier`

返回指定 issue 的运行详情（如 `GET /api/v1/PROJ-42`）。未找到返回 404。

### `POST /api/v1/refresh`

触发立即 poll + reconciliation。返回 202：

```json
{ "queued": true, "requested_at": "2026-06-05T12:00:00Z", "operations": ["poll", "reconcile"] }
```

---

## 运维操作

### 调整配置（不停机）

直接编辑 `WORKFLOW.md` 并保存，Symphony 会自动检测并应用新配置：

```bash
# 例如降低并发
sed -i 's/max_concurrent_agents: 5/max_concurrent_agents: 2/' WORKFLOW.md
```

下一个 poll tick 将使用新配置。

### 停止某个 issue 的执行

在 Linear 中将 issue 状态改为终态（如 "Cancelled"）。下一次 reconciliation 会自动停止 worker 并清理工作区。

### 暂停所有执行

将 `max_concurrent_agents` 改为 0 或将 `active_states` 设为空列表。

### 查看日志

日志以 JSON 格式输出到 stderr：

```bash
# 实时查看
node dist/cli.js 2>&1 | jq .

# 过滤特定 issue
node dist/cli.js 2>&1 | jq 'select(.issue_identifier == "PROJ-42")'

# 只看错误
node dist/cli.js 2>&1 | jq 'select(.level == "error")'
```

### 优雅关闭

发送 `SIGINT`（Ctrl+C）或 `SIGTERM`。Symphony 会：
1. 停止调度新任务
2. 向所有运行中的 worker 发送 abort 信号
3. 退出进程

---

## 项目结构

```
src/
├── tracker/                ← Issue Tracker 适配层
│   ├── interface.ts           TrackerClient 接口定义
│   ├── factory.ts             按 tracker.kind 创建实例
│   └── linear_client.ts       Linear GraphQL 实现
├── agent/                  ← Coding Agent 适配层
│   ├── interface.ts           AgentBackend / AgentSession 接口
│   ├── factory.ts             按 agent.backend 创建实例
│   ├── codex_app_server.ts    Codex JSON-RPC 协议
│   ├── codex_backend.ts       Codex backend 封装
│   └── claude_code_backend.ts Claude Code backend
├── agent_runner.ts         ← 单 issue 执行编排
├── orchestrator.ts         ← 调度核心
├── config.ts               ← 配置解析
├── workflow.ts             ← WORKFLOW.md 加载与热更新
├── workspace.ts            ← 工作区管理与安全
├── prompt.ts               ← Liquid 模板渲染
├── http_server.ts          ← HTTP Dashboard & API
├── logger.ts               ← 结构化日志
├── types.ts                ← 领域模型类型
├── cli.ts                  ← CLI 入口
└── index.ts                ← 库导出
```

---

## 扩展

### 添加新的 Tracker

1. 在 `src/tracker/` 下创建实现 `TrackerClient` 接口的文件
2. 在 `src/tracker/factory.ts` 的 switch 中注册
3. 在 WORKFLOW.md 中设置 `tracker.kind: your-tracker`

### 添加新的 Agent Backend

1. 在 `src/agent/` 下创建实现 `AgentBackend` 接口的文件
2. 在 `src/agent/factory.ts` 的 switch 中注册
3. 在 WORKFLOW.md 中设置 `agent.backend: your-agent`

---

## 进一步阅读

- [`docs/architecture.md`](docs/architecture.md) — 项目理解与架构设计
- [`docs/module-design.md`](docs/module-design.md) — 各模块设计思考
- [`docs/core-value.md`](docs/core-value.md) — 核心实现与价值分析
- [`../SPEC.md`](../SPEC.md) — 语言无关的规范定义
