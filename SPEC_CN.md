# Symphony 服务规范

状态：Draft v1（语言无关）

目的：定义一个编排 coding agent 以完成项目工作的服务。

## 规范性语言

本文档中的关键词 `MUST`、`MUST NOT`、`REQUIRED`、`SHOULD`、`SHOULD NOT`、`RECOMMENDED`、`MAY` 和 `OPTIONAL` 按照 RFC 2119 的描述进行解释。

`Implementation-defined`（实现定义）表示该行为属于实现契约的一部分，但本规范不规定一个通用策略。实现 MUST 文档化所选择的行为。

## 1. 问题陈述

Symphony 是一个长期运行的自动化服务，它持续从 issue tracker（本规范版本中为 Linear）读取工作，为每个 issue 创建隔离的工作区，并在工作区中为该 issue 运行 coding agent 会话。

该服务解决四个运维问题：

- 将 issue 执行变为可重复的 daemon 工作流，而非手动脚本。
- 在每个 issue 专属的工作区中隔离 agent 执行，agent 命令仅在对应工作区目录内运行。
- 将工作流策略保存在仓库中（`WORKFLOW.md`），团队可以将 agent prompt 和运行时设置与代码一起进行版本控制。
- 提供足够的可观测性，以运维和调试多个并发 agent 运行。

实现应明确文档化其信任和安全态势。本规范不要求单一的审批、沙箱或运维确认策略；某些实现针对受信环境使用高信任配置，而其他实现则需要更严格的审批或沙箱。

重要边界：

- Symphony 是调度器/运行器和 tracker 读取器。
- Ticket 写操作（状态转换、评论、PR 链接）通常由 coding agent 使用工作流/运行时环境中可用的工具执行。
- 一次成功运行可以在工作流定义的交接状态（例如 `Human Review`）结束，不一定是 `Done`。

## 2. 目标与非目标

### 2.1 目标

- 以固定节奏轮询 issue tracker 并在有界并发下调度工作。
- 维护单一权威的编排器状态，用于调度、重试和对账。
- 为每个 issue 创建确定性工作区并跨运行保留。
- 当 issue 状态变更使其不再符合条件时，停止活动运行。
- 通过指数退避从瞬态故障中恢复。
- 从仓库内的 `WORKFLOW.md` 契约加载运行时行为。
- 暴露运维可见的可观测性（至少包括结构化日志）。
- 支持基于 tracker/文件系统的重启恢复，无需持久化数据库；不恢复精确的内存调度器状态。

### 2.2 非目标

- 丰富的 Web UI 或多租户控制面板。
- 规定特定的仪表盘或终端 UI 实现。
- 通用工作流引擎或分布式任务调度器。
- 内置的 ticket、PR 或评论编辑业务逻辑。（该逻辑存在于工作流 prompt 和 agent 工具中。）
- 在 coding agent 和宿主操作系统提供的之外，强制要求强沙箱控制。
- 对所有实现强制要求单一默认审批、沙箱或运维确认态势。

## 3. 系统概览

### 3.1 主要组件

1. `Workflow Loader`（工作流加载器）
   - 读取 `WORKFLOW.md`。
   - 解析 YAML front matter 和 prompt 正文。
   - 返回 `{config, prompt_template}`。

2. `Config Layer`（配置层）
   - 暴露工作流配置值的类型化 getter。
   - 应用默认值和环境变量间接引用。
   - 执行编排器在调度前使用的验证。

3. `Issue Tracker Client`（Issue Tracker 客户端）
   - 获取处于活动状态的候选 issue。
   - 获取特定 issue ID 的当前状态（对账）。
   - 在启动清理期间获取终态 issue。
   - 将 tracker 负载规范化为稳定的 issue 模型。

4. `Orchestrator`（编排器）
   - 拥有轮询 tick。
   - 拥有内存运行时状态。
   - 决定哪些 issue 需要调度、重试、停止或释放。
   - 跟踪会话指标和重试队列状态。

5. `Workspace Manager`（工作区管理器）
   - 将 issue 标识符映射到工作区路径。
   - 确保每个 issue 的工作区目录存在。
   - 运行工作区生命周期 hook。
   - 为终态 issue 清理工作区。

6. `Agent Runner`（Agent 运行器）
   - 创建工作区。
   - 从 issue + 工作流模板构建 prompt。
   - 启动 coding agent app-server 客户端。
   - 将 agent 更新流式传回编排器。

7. `Status Surface`（状态展示层，OPTIONAL）
   - 展示人类可读的运行时状态（例如终端输出、仪表盘或其他面向运维的视图）。

8. `Logging`（日志）
   - 向一个或多个配置的 sink 发出结构化运行时日志。

### 3.2 抽象层次

Symphony 按以下层次划分最容易移植：

1. `Policy Layer`（策略层，仓库定义）
   - `WORKFLOW.md` prompt 正文。
   - 团队特定的 ticket 处理、验证和交接规则。

2. `Configuration Layer`（配置层，类型化 getter）
   - 将 front matter 解析为类型化运行时设置。
   - 处理默认值、环境 token 和路径规范化。

3. `Coordination Layer`（协调层，编排器）
   - 轮询循环、issue 资格判定、并发控制、重试、对账。

4. `Execution Layer`（执行层，工作区 + agent 子进程）
   - 文件系统生命周期、工作区准备、coding-agent 协议。

5. `Integration Layer`（集成层，Linear 适配器）
   - API 调用和 tracker 数据的规范化。

6. `Observability Layer`（可观测层，日志 + OPTIONAL 状态展示层）
   - 为运维提供编排器和 agent 行为的可见性。

### 3.3 外部依赖

- Issue tracker API（本规范版本中 `tracker.kind: linear` 对应 Linear）。
- 本地文件系统，用于工作区和日志。
- OPTIONAL 的工作区填充工具（例如 Git CLI，如使用的话）。
- 支持目标 Codex app-server 模式的 coding-agent 可执行文件。
- 宿主环境对 issue tracker 和 coding agent 的认证。

## 4. 核心领域模型

### 4.1 实体

#### 4.1.1 Issue

编排、prompt 渲染和可观测性输出所使用的规范化 issue 记录。

字段：

- `id`（string）— 稳定的 tracker 内部 ID。
- `identifier`（string）— 人类可读的 ticket key（例如：`ABC-123`）。
- `title`（string）
- `description`（string 或 null）
- `priority`（integer 或 null）— 数值越小优先级越高，用于调度排序。
- `state`（string）— 当前 tracker 状态名称。
- `branch_name`（string 或 null）— tracker 提供的分支元数据（如有）。
- `url`（string 或 null）
- `labels`（string 列表）— 规范化为小写。
- `blocked_by`（blocker ref 列表）
  - 每个 blocker ref 包含：`id`、`identifier`、`state`（均可为 null）。
- `created_at`（timestamp 或 null）
- `updated_at`（timestamp 或 null）

#### 4.1.2 Workflow Definition（工作流定义）

解析后的 `WORKFLOW.md` 负载：

- `config`（map）— YAML front matter 根对象。
- `prompt_template`（string）— front matter 之后的 Markdown 正文，已 trim。

#### 4.1.3 Service Config（服务配置，类型化视图）

从 `WorkflowDefinition.config` 加上环境解析派生的类型化运行时值。

示例：轮询间隔、工作区根目录、活动和终态 issue 状态、并发限制、coding-agent 可执行文件/参数/超时、工作区 hook。

#### 4.1.4 Workspace（工作区）

分配给一个 issue identifier 的文件系统工作区。

逻辑字段：

- `path`（绝对工作区路径）
- `workspace_key`（清理后的 issue identifier）
- `created_now`（布尔值，用于控制 `after_create` hook 的触发）

#### 4.1.5 Run Attempt（运行尝试）

一个 issue 的一次执行尝试。

逻辑字段：

- `issue_id`
- `issue_identifier`
- `attempt`（integer 或 null，首次运行为 `null`，重试/续行 `>=1`）
- `workspace_path`
- `started_at`
- `status`
- `error`（OPTIONAL）

#### 4.1.6 Live Session（活动会话，Agent 会话元数据）

coding-agent 子进程运行期间跟踪的状态。

字段：

- `session_id`（string，`<thread_id>-<turn_id>`）
- `thread_id`（string）
- `turn_id`（string）
- `codex_app_server_pid`（string 或 null）
- `last_codex_event`（string/enum 或 null）
- `last_codex_timestamp`（timestamp 或 null）
- `last_codex_message`（摘要负载）
- `codex_input_tokens`（integer）
- `codex_output_tokens`（integer）
- `codex_total_tokens`（integer）
- `last_reported_input_tokens`（integer）
- `last_reported_output_tokens`（integer）
- `last_reported_total_tokens`（integer）
- `turn_count`（integer）— 在当前 worker 生命周期内启动的 coding-agent turn 数量。

#### 4.1.7 Retry Entry（重试条目）

一个 issue 的计划重试状态。

字段：

- `issue_id`
- `identifier`（尽力提供的人类可读 ID，用于状态展示/日志）
- `attempt`（integer，重试队列中从 1 开始）
- `due_at_ms`（单调时钟时间戳）
- `timer_handle`（运行时特定的定时器引用）
- `error`（string 或 null）

#### 4.1.8 Orchestrator Runtime State（编排器运行时状态）

编排器拥有的单一权威内存状态。

字段：

- `poll_interval_ms`（当前有效轮询间隔）
- `max_concurrent_agents`（当前有效全局并发限制）
- `running`（map `issue_id -> running entry`）
- `claimed`（已预留/运行中/重试中的 issue ID 集合）
- `retry_attempts`（map `issue_id -> RetryEntry`）
- `completed`（issue ID 集合；仅用于记账，不控制调度）
- `codex_totals`（聚合 token + 运行时秒数）
- `codex_rate_limits`（来自 agent 事件的最新速率限制快照）

### 4.2 稳定标识符与规范化规则

- `Issue ID` — 用于 tracker 查询和内部 map key。
- `Issue Identifier` — 用于人类可读的日志和工作区命名。
- `Workspace Key` — 从 `issue.identifier` 派生，将不在 `[A-Za-z0-9._-]` 中的字符替换为 `_`，用清理后的值作为工作区目录名。
- `Normalized Issue State` — 比较时使用 `lowercase`。
- `Session ID` — 由 coding-agent 的 `thread_id` 和 `turn_id` 组合为 `<thread_id>-<turn_id>`。

## 5. 工作流规范（仓库契约）

### 5.1 文件发现与路径解析

工作流文件路径优先级：

1. 显式应用/运行时设置（通过 CLI 启动路径设置）。
2. 默认：当前进程工作目录下的 `WORKFLOW.md`。

加载器行为：

- 如果文件无法读取，返回 `missing_workflow_file` 错误。
- 工作流文件应由仓库拥有并进行版本控制。

### 5.2 文件格式

`WORKFLOW.md` 是一个带有 OPTIONAL YAML front matter 的 Markdown 文件。

设计说明：

- `WORKFLOW.md` SHOULD 足够自包含，以描述和运行不同的工作流（prompt、运行时设置、hook 和 tracker 选择/配置），而无需带外的服务特定配置。

解析规则：

- 如果文件以 `---` 开头，解析直到下一个 `---` 的行作为 YAML front matter。
- 剩余行成为 prompt 正文。
- 如果 front matter 缺失，将整个文件视为 prompt 正文，使用空 config map。
- YAML front matter MUST 解码为 map/object；非 map YAML 是错误。
- Prompt 正文在使用前 trim。

返回的工作流对象：

- `config`：front matter 根对象（不嵌套在 `config` key 下）。
- `prompt_template`：trim 后的 Markdown 正文。

### 5.3 Front Matter Schema

顶层 key：

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `codex`

未知 key SHOULD 被忽略以保证前向兼容性。

注意：

- 工作流 front matter 是可扩展的。扩展 MAY 定义额外的顶层 key 而不改变上述核心 schema。
- 扩展 SHOULD 文档化其字段 schema、默认值、验证规则以及更改是动态生效还是需要重启。

#### 5.3.1 `tracker`（对象）

字段：

- `kind`（string）— 调度 REQUIRED。当前支持值：`linear`
- `endpoint`（string）— `tracker.kind == "linear"` 的默认值：`https://api.linear.app/graphql`
- `api_key`（string）— MAY 为字面 token 或 `$VAR_NAME`。`tracker.kind == "linear"` 的规范环境变量：`LINEAR_API_KEY`。如果 `$VAR_NAME` 解析为空字符串，视为缺失。
- `project_slug`（string）— `tracker.kind == "linear"` 时调度 REQUIRED。
- `active_states`（string 列表）— 默认：`Todo`, `In Progress`
- `terminal_states`（string 列表）— 默认：`Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done`

#### 5.3.2 `polling`（对象）

字段：

- `interval_ms`（integer）— 默认：`30000`。更改 SHOULD 在运行时重新生效，影响后续 tick 调度而无需重启。

#### 5.3.3 `workspace`（对象）

字段：

- `root`（路径字符串或 `$VAR`）— 默认：`<system-temp>/symphony_workspaces`。支持 `~` 展开。相对路径相对于包含 `WORKFLOW.md` 的目录解析。有效工作区根目录在使用前规范化为绝对路径。

#### 5.3.4 `hooks`（对象）

字段：

- `after_create`（多行 shell 脚本字符串，OPTIONAL）— 仅在新建工作区目录时运行。失败中止工作区创建。
- `before_run`（多行 shell 脚本字符串，OPTIONAL）— 在每次 agent 尝试中，工作区准备完成后、启动 coding agent 前运行。失败中止当前尝试。
- `after_run`（多行 shell 脚本字符串，OPTIONAL）— 在每次 agent 尝试后（成功、失败、超时或取消）工作区存在时运行。失败仅记录日志并忽略。
- `before_remove`（多行 shell 脚本字符串，OPTIONAL）— 在工作区删除前（如目录存在）运行。失败仅记录日志并忽略；清理仍继续。
- `timeout_ms`（integer，OPTIONAL）— 默认：`60000`。适用于所有工作区 hook。无效值导致配置验证失败。更改 SHOULD 在运行时对未来 hook 执行重新生效。

#### 5.3.5 `agent`（对象）

字段：

- `max_concurrent_agents`（integer）— 默认：`10`。更改 SHOULD 在运行时重新生效并影响后续调度决策。
- `max_turns`（正整数）— 默认：`20`。限制一个 worker 会话内的 coding-agent turn 数量。无效值导致配置验证失败。
- `max_retry_backoff_ms`（integer）— 默认：`300000`（5 分钟）。更改 SHOULD 在运行时重新生效并影响未来重试调度。
- `max_concurrent_agents_by_state`（map `state_name -> 正整数`）— 默认：空 map。状态 key 查找时规范化（`lowercase`）。无效条目（非正数或非数字）被忽略。

#### 5.3.6 `codex`（对象）

对于 Codex 拥有的配置值（如 `approval_policy`、`thread_sandbox` 和 `turn_sandbox_policy`），支持的值由目标 Codex app-server 版本定义。实现者 SHOULD 将它们视为 Codex 配置值的透传，而不是依赖本规范中手动维护的枚举。

字段：

- `command`（string shell 命令）— 默认：`codex app-server`。运行时通过 `bash -lc` 在工作区目录中启动此命令。
- `approval_policy`（Codex `AskForApproval` 值）— 默认：implementation-defined。
- `thread_sandbox`（Codex `SandboxMode` 值）— 默认：implementation-defined。
- `turn_sandbox_policy`（Codex `SandboxPolicy` 值）— 默认：implementation-defined。
- `turn_timeout_ms`（integer）— 默认：`3600000`（1 小时）
- `read_timeout_ms`（integer）— 默认：`5000`
- `stall_timeout_ms`（integer）— 默认：`300000`（5 分钟）。若 `<= 0`，禁用停滞检测。

### 5.4 Prompt Template 契约

`WORKFLOW.md` 的 Markdown 正文是每个 issue 的 prompt 模板。

渲染要求：

- 使用严格的模板引擎（Liquid 兼容语义即可）。
- 未知变量 MUST 使渲染失败。
- 未知 filter MUST 使渲染失败。

模板输入变量：

- `issue`（对象）— 包含所有规范化 issue 字段（含 labels 和 blockers）。
- `attempt`（integer 或 null）— 首次尝试时为 `null`/缺失，重试或续行运行时为 integer。

回退 prompt 行为：

- 如果工作流 prompt 正文为空，运行时 MAY 使用最小默认 prompt（`You are working on an issue from Linear.`）。
- 工作流文件读取/解析失败是配置/验证错误，SHOULD NOT 静默回退到 prompt。

### 5.5 工作流验证与错误表面

错误类别：

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error`（prompt 渲染时）
- `template_render_error`（未知变量/filter，无效插值）

调度控制行为：

- 工作流文件读取/YAML 错误阻止新调度直到修复。
- 模板错误仅使受影响的运行尝试失败。

## 6. 配置规范

### 6.1 配置解析流水线

配置按以下顺序解析：

1. 选择工作流文件路径（显式运行时设置，否则使用 cwd 默认值）。
2. 将 YAML front matter 解析为原始 config map。
3. 对缺失的 OPTIONAL 字段应用内置默认值。
4. 仅对显式包含 `$VAR_NAME` 的配置值解析 `$VAR_NAME` 间接引用。
5. 强制转换和验证类型化值。

环境变量不会全局覆盖 YAML 值。仅在配置值显式引用时使用。

值强制转换语义：

- 路径/命令字段支持：`~` home 展开、`$VAR` 展开（用于环境支持的路径值）。仅对意图为本地文件系统路径的值应用展开；不重写 URI 或任意 shell 命令字符串。
- 相对 `workspace.root` 值相对于包含所选 `WORKFLOW.md` 的目录解析。

### 6.2 动态重新加载语义

动态重新加载是 REQUIRED：

- 软件 MUST 检测 `WORKFLOW.md` 的更改。
- 更改时，MUST 重新读取并重新应用工作流配置和 prompt 模板，无需重启。
- 软件 MUST 尝试将实时行为调整为新配置（例如轮询节奏、并发限制、活动/终态状态、codex 设置、工作区路径/hook 和未来运行的 prompt 内容）。
- 重新加载的配置适用于未来的调度、重试调度、对账决策、hook 执行和 agent 启动。
- 实现不 REQUIRED 在配置更改时自动重启正在进行的 agent 会话。
- 无效重新加载 MUST NOT 导致服务崩溃；使用最后已知的良好有效配置继续运行，并发出运维可见的错误。

### 6.3 调度预检验证

此验证是在尝试调度新工作前运行的调度器预检。它验证轮询和启动 worker 所需的工作流/配置，而非所有可能工作流行为的完整审计。

启动验证：

- 在启动调度循环前验证配置。
- 如果启动验证失败，启动失败并发出运维可见的错误。

每 tick 调度验证：

- 在每个调度周期前重新验证。
- 如果验证失败，跳过该 tick 的调度，保持对账活动，并发出运维可见的错误。

验证检查：

- 工作流文件可以加载和解析。
- `tracker.kind` 存在且受支持。
- `tracker.api_key` 在 `$` 解析后存在。
- `tracker.project_slug` 在所选 tracker kind 要求时存在。
- `codex.command` 存在且非空。

### 6.4 核心配置字段速查表

本节有意冗余，以便 coding agent 可以快速实现配置层。

- `tracker.kind`：string，REQUIRED，当前为 `linear`
- `tracker.endpoint`：string，`tracker.kind=linear` 时默认 `https://api.linear.app/graphql`
- `tracker.api_key`：string 或 `$VAR`，`tracker.kind=linear` 时规范环境变量为 `LINEAR_API_KEY`
- `tracker.project_slug`：string，`tracker.kind=linear` 时 REQUIRED
- `tracker.active_states`：string 列表，默认 `["Todo", "In Progress"]`
- `tracker.terminal_states`：string 列表，默认 `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`
- `polling.interval_ms`：integer，默认 `30000`
- `workspace.root`：解析为绝对路径，默认 `<system-temp>/symphony_workspaces`
- `hooks.after_create`：shell 脚本或 null
- `hooks.before_run`：shell 脚本或 null
- `hooks.after_run`：shell 脚本或 null
- `hooks.before_remove`：shell 脚本或 null
- `hooks.timeout_ms`：integer，默认 `60000`
- `agent.max_concurrent_agents`：integer，默认 `10`
- `agent.max_turns`：integer，默认 `20`
- `agent.max_retry_backoff_ms`：integer，默认 `300000`（5分钟）
- `agent.max_concurrent_agents_by_state`：正整数 map，默认 `{}`
- `codex.command`：shell 命令字符串，默认 `codex app-server`
- `codex.approval_policy`：Codex `AskForApproval` 值，默认 implementation-defined
- `codex.thread_sandbox`：Codex `SandboxMode` 值，默认 implementation-defined
- `codex.turn_sandbox_policy`：Codex `SandboxPolicy` 值，默认 implementation-defined
- `codex.turn_timeout_ms`：integer，默认 `3600000`
- `codex.read_timeout_ms`：integer，默认 `5000`
- `codex.stall_timeout_ms`：integer，默认 `300000`

## 7. 编排状态机

编排器是唯一变更调度状态的组件。所有 worker 结果都报告回编排器，并转换为显式状态转换。

### 7.1 Issue 编排状态

这不同于 tracker 状态（`Todo`、`In Progress` 等）。这是服务的内部 claim 状态。

1. `Unclaimed`（未认领）— Issue 未运行且无重试计划。
2. `Claimed`（已认领）— 编排器已预留该 issue 以防止重复调度。实际上，已认领的 issue 要么在 `Running`，要么在 `RetryQueued`。
3. `Running`（运行中）— Worker 任务存在，issue 在 `running` map 中被跟踪。
4. `RetryQueued`（重试队列中）— Worker 未运行，但 `retry_attempts` 中存在重试定时器。
5. `Released`（已释放）— 因 issue 处于终态、非活动、缺失或重试路径完成但未重新调度而移除 claim。

重要细节：

- Worker 成功退出不意味着 issue 永远完成。
- Worker MAY 在退出前继续执行多个背靠背的 coding-agent turn。
- 每次正常 turn 完成后，worker 重新检查 tracker issue 状态。
- 如果 issue 仍处于活动状态，worker SHOULD 在同一工作区的同一活动 coding-agent thread 上启动另一个 turn，最多 `agent.max_turns` 次。
- 第一个 turn SHOULD 使用完整渲染的任务 prompt。
- 续行 turn SHOULD 仅向现有 thread 发送续行指导，而不重新发送已在 thread 历史中的原始任务 prompt。
- Worker 正常退出后，编排器仍会安排一个短暂的续行重试（约 1 秒），以便重新检查 issue 是否仍处于活动状态并需要另一个 worker 会话。

### 7.2 Run Attempt 生命周期

一次运行尝试经过以下阶段：

1. `PreparingWorkspace`（准备工作区）
2. `BuildingPrompt`（构建 Prompt）
3. `LaunchingAgentProcess`（启动 Agent 进程）
4. `InitializingSession`（初始化会话）
5. `StreamingTurn`（流式 Turn）
6. `Finishing`（完成中）
7. `Succeeded`（成功）
8. `Failed`（失败）
9. `TimedOut`（超时）
10. `Stalled`（停滞）
11. `CanceledByReconciliation`（被对账取消）

不同的终态原因很重要，因为重试逻辑和日志各不相同。

### 7.3 转换触发器

- `Poll Tick`（轮询 Tick）— 对账活动运行、验证配置、获取候选 issue、调度直到 slot 用尽。
- `Worker Exit (normal)`（Worker 正常退出）— 移除运行条目、更新聚合运行时总计、安排续行重试（attempt `1`）。
- `Worker Exit (abnormal)`（Worker 异常退出）— 移除运行条目、更新聚合运行时总计、安排指数退避重试。
- `Codex Update Event`（Codex 更新事件）— 更新活动会话字段、token 计数器和速率限制。
- `Retry Timer Fired`（重试定时器触发）— 重新获取活动候选并尝试重新调度，如不再符合条件则释放 claim。
- `Reconciliation State Refresh`（对账状态刷新）— 停止 issue 状态为终态或不再活动的运行。
- `Stall Timeout`（停滞超时）— 终止 worker 并安排重试。

### 7.4 幂等性与恢复规则

- 编排器通过单一权威串行化状态变更以避免重复调度。
- 在启动任何 worker 前 REQUIRED 检查 `claimed` 和 `running`。
- 对账在每个 tick 的调度前运行。
- 重启恢复由 tracker 和文件系统驱动（无持久编排器数据库）。
- 启动时的终态清理为已处于终态的 issue 移除陈旧工作区。

## 8. 轮询、调度和对账

### 8.1 轮询循环

启动时，服务验证配置、执行启动清理、安排一个即时 tick，然后每 `polling.interval_ms` 重复。

有效轮询间隔 SHOULD 在工作流配置更改重新应用时更新。

Tick 序列：

1. 对账运行中的 issue。
2. 运行调度预检验证。
3. 使用活动状态从 tracker 获取候选 issue。
4. 按调度优先级排序 issue。
5. 在有 slot 时调度符合条件的 issue。
6. 通知可观测性/状态消费者状态变更。

如果每 tick 验证失败，该 tick 跳过调度，但对账仍先运行。

### 8.2 候选选择规则

Issue 仅在以下所有条件为真时才有调度资格：

- 具有 `id`、`identifier`、`title` 和 `state`。
- 状态在 `active_states` 中且不在 `terminal_states` 中。
- 不在 `running` 中。
- 不在 `claimed` 中。
- 有可用的全局并发 slot。
- 有可用的 per-state 并发 slot。
- `Todo` 状态的阻塞规则通过：如果 issue 状态为 `Todo`，当存在任何非终态 blocker 时不调度。

排序顺序（稳定意图）：

1. `priority` 升序（1..4 优先；null/未知排最后）
2. `created_at` 最早优先
3. `identifier` 字典序作为 tie-breaker

### 8.3 并发控制

全局限制：

- `available_slots = max(max_concurrent_agents - running_count, 0)`

Per-state 限制：

- 如果存在 `max_concurrent_agents_by_state[state]`（state key 已规范化）则使用之
- 否则回退到全局限制

运行时按 `running` map 中当前跟踪的状态对 issue 计数。

### 8.4 重试与退避

重试条目创建：

- 取消同一 issue 的现有重试定时器。
- 存储 `attempt`、`identifier`、`error`、`due_at_ms` 和新定时器句柄。

退避公式：

- 干净 worker 退出后的正常续行重试使用短固定延迟 `1000` ms。
- 故障驱动的重试使用 `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`。
- 幂次受配置的最大重试退避上限（默认 `300000` / 5 分钟）约束。

重试处理行为：

1. 获取活动候选 issue（非所有 issue）。
2. 按 `issue_id` 查找特定 issue。
3. 如未找到，释放 claim。
4. 如找到且仍符合候选资格：有 slot 时调度，否则以 `no available orchestrator slots` 错误重新排队。
5. 如找到但不再活动，释放 claim。

### 8.5 活动运行对账

对账在每个 tick 运行，包含两部分。

**Part A：停滞检测**

- 对每个运行中的 issue，计算自以下时间起的 `elapsed_ms`：
  - `last_codex_timestamp`（如有事件），否则 `started_at`
- 如果 `elapsed_ms > codex.stall_timeout_ms`，终止 worker 并排入重试队列。
- 如果 `stall_timeout_ms <= 0`，完全跳过停滞检测。

**Part B：Tracker 状态刷新**

- 为所有运行中的 issue ID 获取当前 issue 状态。
- 对每个运行中的 issue：
  - 如果 tracker 状态为终态：终止 worker 并清理工作区。
  - 如果 tracker 状态仍为活动：更新内存中的 issue 快照。
  - 如果 tracker 状态既非活动也非终态：终止 worker 但不清理工作区。
- 如果状态刷新失败，保持 worker 运行并在下一个 tick 重试。

### 8.6 启动时终态工作区清理

服务启动时：

1. 查询 tracker 获取终态 issue。
2. 对每个返回的 issue identifier，移除对应的工作区目录。
3. 如果终态 issue 获取失败，记录警告并继续启动。

这防止重启后陈旧的终态工作区累积。

## 9. 工作区管理与安全

### 9.1 工作区布局

工作区根目录：`workspace.root`（规范化绝对路径）

每个 issue 的工作区路径：`<workspace.root>/<sanitized_issue_identifier>`

工作区持久性：工作区在同一 issue 的多次运行中复用。成功运行不会自动删除工作区。

### 9.2 工作区创建与复用

输入：`issue.identifier`

算法摘要：

1. 将 identifier 清理为 `workspace_key`。
2. 在工作区根目录下计算工作区路径。
3. 确保工作区路径作为目录存在。
4. 仅当目录在本次调用中创建时标记 `created_now=true`；否则为 `created_now=false`。
5. 如果 `created_now=true`，运行配置的 `after_create` hook。

### 9.3 OPTIONAL 工作区填充（Implementation-Defined）

规范不要求任何内置的 VCS 或仓库引导行为。实现 MAY 使用 implementation-defined 逻辑和/或 hook（例如 `after_create` 和/或 `before_run`）来填充或同步工作区。

### 9.4 工作区 Hook

支持的 hook：`hooks.after_create`、`hooks.before_run`、`hooks.after_run`、`hooks.before_remove`

执行契约：

- 在适合宿主操作系统的本地 shell 上下文中执行，工作区目录为 `cwd`。
- 在 POSIX 系统上，`sh -lc <script>`（或更严格的等价物如 `bash -lc <script>`）是符合规范的默认值。
- Hook 超时使用 `hooks.timeout_ms`；默认：`60000 ms`。
- 记录 hook 启动、失败和超时的日志。

失败语义：

- `after_create` 失败或超时对工作区创建是致命的。
- `before_run` 失败或超时对当前运行尝试是致命的。
- `after_run` 失败或超时仅记录日志并忽略。
- `before_remove` 失败或超时仅记录日志并忽略。

### 9.5 安全不变量

这是最重要的可移植性约束。

**不变量 1：仅在每个 issue 的工作区路径中运行 coding agent。**
- 启动 coding-agent 子进程前验证：`cwd == workspace_path`

**不变量 2：工作区路径 MUST 位于工作区根目录内。**
- 将两个路径规范化为绝对路径。
- 要求 `workspace_path` 以 `workspace_root` 为前缀目录。
- 拒绝工作区根目录外的任何路径。

**不变量 3：工作区 key 已清理。**
- 工作区目录名中仅允许 `[A-Za-z0-9._-]`。
- 将所有其他字符替换为 `_`。

## 10. Agent Runner 协议（Coding Agent 集成）

本节定义 Symphony 在集成 Codex app-server 时的语言中立职责。目标 Codex 版本的 Codex app-server 协议是协议 schema、消息负载、传输帧和方法名称的权威来源。

### 10.1 启动契约

子进程启动参数：

- 命令：`codex.command`
- 调用方式：`bash -lc <codex.command>`
- 工作目录：工作区路径

### 10.2 会话启动职责

启动 MUST 遵循目标 Codex app-server 契约。Symphony 额外要求客户端：

- 在每个 issue 工作区中启动 app-server 子进程。
- 在同一活动 thread 上为续行 turn 复用相同的 `thread_id`。
- 第一个 turn 使用渲染的 issue prompt 启动。
- 后续 worker 内续行 turn 使用续行指导而非重新发送原始 issue prompt。

### 10.3 流式 Turn 处理

完成条件：

- 目标协议 turn 完成信号 → 成功
- 目标协议 turn 失败信号 → 失败
- 目标协议 turn 取消信号 → 失败
- Turn 超时（`turn_timeout_ms`）→ 失败
- 子进程退出 → 失败

### 10.4 发出的运行时事件（上报至编排器）

app-server 客户端向编排器回调发出结构化事件。每个事件 SHOULD 包含：

- `event`（enum/string）
- `timestamp`（UTC 时间戳）
- `codex_app_server_pid`（如有）
- OPTIONAL `usage` map（token 计数）

重要事件示例：`session_started`、`startup_failed`、`turn_completed`、`turn_failed`、`turn_cancelled`、`turn_input_required`、`approval_auto_approved`、`notification` 等。

### 10.5 审批、工具调用和用户输入策略

审批、沙箱和用户输入行为是 implementation-defined。

策略要求：

- 每个实现 MUST 文档化其选择的审批、沙箱和运维确认态势。
- 审批请求和需用户输入事件 MUST NOT 使运行无限期停滞。

高信任行为示例：

- 自动审批命令执行审批。
- 自动审批文件变更审批。
- 将需用户输入的 turn 视为硬失败。

### 10.6 超时与错误映射

超时：

- `codex.read_timeout_ms`：启动和同步请求的请求/响应超时
- `codex.turn_timeout_ms`：总 turn 流超时
- `codex.stall_timeout_ms`：编排器基于事件不活动强制执行

### 10.7 Agent Runner 契约

`Agent Runner` 封装工作区 + prompt + app-server 客户端。

行为：

1. 为 issue 创建/复用工作区。
2. 从工作流模板构建 prompt。
3. 启动 app-server 会话。
4. 将 app-server 事件转发给编排器。
5. 任何错误，使 worker 尝试失败（编排器将重试）。

## 11. Issue Tracker 集成契约（Linear 兼容）

### 11.1 REQUIRED 操作

实现 MUST 支持以下 tracker 适配器操作：

1. `fetch_candidate_issues()` — 返回配置项目中处于配置活动状态的 issue。
2. `fetch_issues_by_states(state_names)` — 用于启动终态清理。
3. `fetch_issue_states_by_ids(issue_ids)` — 用于活动运行对账。

### 11.2 查询语义（Linear）

- `tracker.kind == "linear"`
- GraphQL endpoint（默认 `https://api.linear.app/graphql`）
- Auth token 通过 `Authorization` header 发送
- `tracker.project_slug` 映射到 Linear project `slugId`
- 候选 issue 分页 REQUIRED，默认 page size：`50`
- 网络超时：`30000 ms`

### 11.3 规范化规则

- `labels` → 小写字符串
- `blocked_by` → 从关系类型为 `blocks` 的反向关系派生
- `priority` → 仅 integer（非整数变为 null）
- `created_at` 和 `updated_at` → 解析 ISO-8601 时间戳

### 11.4 错误处理契约

RECOMMENDED 错误类别：`unsupported_tracker_kind`、`missing_tracker_api_key`、`missing_tracker_project_slug`、`linear_api_request`、`linear_api_status`、`linear_graphql_errors`、`linear_unknown_payload`、`linear_missing_end_cursor`。

编排器对 tracker 错误的行为：

- 候选获取失败：记录日志并跳过该 tick 的调度。
- 运行状态刷新失败：记录日志并保持活动 worker 运行。
- 启动终态清理失败：记录警告并继续启动。

### 11.5 Tracker 写操作（重要边界）

Symphony 不要求编排器中有一等的 tracker 写 API。

- Ticket 变更（状态转换、评论、PR 元数据）通常由 coding agent 使用工作流 prompt 定义的工具处理。
- 服务始终是调度器/运行器和 tracker 读取器。

## 12. Prompt 构建与上下文组装

### 12.1 输入

Prompt 渲染的输入：`workflow.prompt_template`、规范化的 `issue` 对象、OPTIONAL `attempt` integer。

### 12.2 渲染规则

- 严格变量检查渲染。
- 严格 filter 检查渲染。
- 将 issue 对象 key 转为字符串以兼容模板。
- 保留嵌套数组/map（labels、blockers）以便模板迭代。

### 12.3 重试/续行语义

`attempt` SHOULD 传递给模板，因为工作流 prompt 可以为以下情况提供不同指令：首次运行（`attempt` 为 null 或缺失）、前次会话成功后的续行运行、错误/超时/停滞后的重试。

### 12.4 失败语义

如果 prompt 渲染失败：立即使运行尝试失败。让编排器像其他 worker 失败一样处理并决定重试行为。

## 13. 日志、状态和可观测性

### 13.1 日志约定

Issue 相关日志的 REQUIRED 上下文字段：`issue_id`、`issue_identifier`

Coding-agent 会话生命周期日志的 REQUIRED 上下文：`session_id`

### 13.2 日志输出与 Sink

规范不规定日志写入位置。要求：运维人员 MUST 无需附加调试器即可看到启动/验证/调度失败。

### 13.3 运行时快照 / 监控接口（OPTIONAL 但 RECOMMENDED）

如果实现暴露同步运行时快照，SHOULD 返回：`running`（含 `turn_count`）、`retrying`、`codex_totals`（`input_tokens`、`output_tokens`、`total_tokens`、`seconds_running`）、`rate_limits`。

### 13.4 OPTIONAL 人类可读状态展示层

人类可读的状态展示层是 OPTIONAL 且 implementation-defined。如存在，SHOULD 仅从编排器状态/指标绘制，MUST NOT 成为正确性的 REQUIRED。

### 13.5 会话指标与 Token 核算

Token 核算规则：

- 优先使用绝对 thread 总计。
- 忽略 delta 风格负载。
- 对绝对总计，跟踪相对于最后报告总计的增量以避免重复计数。
- 在编排器状态中累积聚合总计。

### 13.6 人类化 Agent 事件摘要（OPTIONAL）

如果实现：视为仅观测性输出。不使编排器逻辑依赖人类化字符串。

### 13.7 OPTIONAL HTTP Server 扩展

定义一个 OPTIONAL 的用于可观测性和运维控制的 HTTP 接口。

扩展配置：

- `server.port`（integer，OPTIONAL）— 启用 HTTP server 扩展。`0` 请求临时端口。CLI `--port` 优先于 `server.port`。
- 实现 SHOULD 默认绑定 loopback（`127.0.0.1`）。

#### 13.7.1 人类可读仪表盘（`/`）

- 在 `/` 托管人类可读仪表盘。
- 文档 SHOULD 展示系统当前状态。

#### 13.7.2 JSON REST API（`/api/v1/*`）

在 `/api/v1/*` 下提供 JSON REST API，用于当前运行时状态和运维调试。

最低端点：

- `GET /api/v1/state` — 返回当前系统状态的摘要视图。
- `GET /api/v1/<issue_identifier>` — 返回 issue 特定的运行时/调试详情。
- `POST /api/v1/refresh` — 排队一个即时 tracker 轮询 + 对账周期。

## 14. 故障模型与恢复策略

### 14.1 故障类别

1. **工作流/配置故障** — 缺失 `WORKFLOW.md`、无效 YAML、不支持的 tracker kind、缺失凭证。
2. **工作区故障** — 目录创建失败、填充/同步失败、无效路径、hook 超时/失败。
3. **Agent 会话故障** — 启动握手失败、turn 失败/取消/超时、需用户输入、子进程退出、会话停滞。
4. **Tracker 故障** — API 传输错误、非 200 状态、GraphQL 错误、格式错误的负载。
5. **可观测性故障** — 快照超时、仪表盘渲染错误、日志 sink 配置失败。

### 14.2 恢复行为

- 调度验证失败：跳过新调度、保持服务存活、尽可能继续对账。
- Worker 故障：转为带指数退避的重试。
- Tracker 候选获取失败：跳过本 tick，下一 tick 重试。
- 对账状态刷新失败：保持当前 worker，下一 tick 重试。
- 仪表盘/日志故障：不使编排器崩溃。

### 14.3 部分状态恢复（重启）

当前设计有意将调度器状态保持在内存中。重启恢复意味着服务可以通过轮询 tracker 状态和复用保留的工作区来恢复有用操作。不意味着重试定时器、运行中的会话或活动 worker 状态在进程重启后保留。

重启后：

- 不从先前进程内存恢复重试定时器。
- 不假定运行中的会话可恢复。
- 服务通过以下方式恢复：启动终态工作区清理、新鲜轮询活动 issue、重新调度符合条件的工作。

### 14.4 运维干预点

运维可通过以下方式控制行为：

- 编辑 `WORKFLOW.md`（prompt 和大多数运行时设置）— 更改被自动检测和重新应用。
- 在 tracker 中更改 issue 状态：终态 → 运行中的会话被停止并清理工作区；非活动状态 → 运行中的会话被停止但不清理。
- 重启服务（用于进程恢复或部署，不作为应用工作流配置更改的正常路径）。

## 15. 安全与运维安全

### 15.1 信任边界假设

每个实现定义自己的信任边界。实现 SHOULD 明确声明是否面向受信环境、更严格环境或兼而有之。

### 15.2 文件系统安全要求

强制要求：

- 工作区路径 MUST 位于配置的工作区根目录下。
- Coding-agent cwd MUST 是当前运行的每个 issue 工作区路径。
- 工作区目录名 MUST 使用清理后的标识符。

### 15.3 Secret 处理

- 在工作流配置中支持 `$VAR` 间接引用。
- 不记录 API token 或 secret 环境值。
- 验证 secret 存在性但不打印。

### 15.4 Hook 脚本安全

工作区 hook 是来自 `WORKFLOW.md` 的任意 shell 脚本。Hook 是完全受信的配置。Hook 在工作区目录内运行。Hook 超时是 REQUIRED 以避免阻塞编排器。

### 15.5 Harness 加固指导

针对包含敏感数据或外部控制内容的仓库、issue tracker 和其他输入运行 Codex agent 可能是危险的。实现 SHOULD 明确评估自身风险概况并适当加固执行 harness。

可能的加固措施包括：收紧 Codex 审批和沙箱设置、添加外部隔离层（OS/容器/VM 沙箱、网络限制）、过滤哪些 Linear issue 有调度资格、缩窄 `linear_graphql` 工具范围。

## 16. 参考算法（语言无关）

### 16.1 服务启动

```text
function start_service():
  configure_logging()
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)
  state = { ... }  // 初始化编排器运行时状态
  validation = validate_dispatch_config()
  if validation is not ok: fail_startup(validation)
  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)
  event_loop(state)
```

### 16.2 轮询与调度 Tick

```text
on_tick(state):
  state = reconcile_running_issues(state)  // 先对账
  validation = validate_dispatch_config()
  if validation is not ok: skip dispatch, schedule next tick
  issues = tracker.fetch_candidate_issues()
  for issue in sort_for_dispatch(issues):
    if no_available_slots(state): break
    if should_dispatch(issue, state):
      state = dispatch_issue(issue, state, attempt=null)
  schedule_tick(state.poll_interval_ms)
```

### 16.3 活动运行对账

```text
function reconcile_running_issues(state):
  state = reconcile_stalled_runs(state)  // Part A: 停滞检测
  // Part B: Tracker 状态刷新
  refreshed = tracker.fetch_issue_states_by_ids(keys(state.running))
  for issue in refreshed:
    if terminal: terminate + cleanup workspace
    if active: update snapshot
    else: terminate without cleanup
```

### 16.4 调度一个 Issue

```text
function dispatch_issue(issue, state, attempt):
  worker = spawn_worker(...)
  state.running[issue.id] = { ... }  // 记录运行条目
  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)
```

### 16.5 Worker 尝试（工作区 + Prompt + Agent）

```text
function run_agent_attempt(issue, attempt, orchestrator_channel):
  workspace = create_for_issue(issue.identifier)
  run before_run hook
  session = start_session(workspace)
  循环执行 turn 直到: issue 不再活动 / 达到 max_turns
  stop_session, run after_run hook
```

### 16.6 Worker 退出与重试处理

- 正常退出 → 安排短暂续行重试（1 秒）
- 异常退出 → 指数退避重试
- 重试定时器触发 → 重新获取候选、检查资格、调度或释放

## 17. 测试与验证矩阵

验证 profile：

- `Core Conformance`：所有符合规范的实现 REQUIRED 的确定性测试。
- `Extension Conformance`：仅实现选择发布的 OPTIONAL 功能 REQUIRED。
- `Real Integration Profile`：生产使用前 RECOMMENDED 的环境依赖冒烟/集成检查。

（详细测试项涵盖：工作流和配置解析、工作区管理器和安全、Issue Tracker 客户端、编排器调度/对账/重试、Coding-Agent App-Server 客户端、可观测性、CLI 和宿主生命周期。）

## 18. 实现清单（完成定义）

### 18.1 REQUIRED（符合规范）

- 工作流路径选择（显式路径 + cwd 默认值）
- `WORKFLOW.md` 加载器（YAML front matter + prompt body 分割）
- 类型化配置层（默认值 + `$` 解析）
- 动态 `WORKFLOW.md` 监视/重载/重应用
- 轮询编排器（单一权威可变状态）
- Issue tracker 客户端（候选获取 + 状态刷新 + 终态获取）
- 工作区管理器（清理后的每 issue 工作区）
- 工作区生命周期 hook
- Coding-agent app-server 子进程客户端
- 严格 prompt 渲染
- 带续行重试的指数重试队列
- 对账（终态/非活动 tracker 状态停止运行）
- 终态 issue 工作区清理
- 结构化日志

### 18.2 RECOMMENDED 扩展

- HTTP server 扩展
- `linear_graphql` 客户端工具扩展
- TODO：跨进程重启持久化重试队列和会话元数据
- TODO：可配置的可观测性设置
- TODO：一等 tracker 写 API
- TODO：Linear 之外的可插拔 issue tracker 适配器

## 附录 A. SSH Worker 扩展（OPTIONAL）

描述一种常见扩展 profile：Symphony 保持一个中央编排器，但通过 SSH 在远程主机上执行 worker 运行。

扩展配置：

- `worker.ssh_hosts`（SSH 主机字符串列表，OPTIONAL）— 省略时本地运行。
- `worker.max_concurrent_agents_per_host`（正整数，OPTIONAL）— 跨 SSH 主机的共享每主机上限。

关键考虑：编排器仍为轮询、claim、重试和对账的唯一真相来源。`workspace.root` 在远程主机上解释。续行 turn 应留在同一主机和工作区。需考虑远程环境漂移、工作区局部性、路径和命令安全、启动和故障转移语义、主机健康和饱和度、清理和可观测性等问题。
