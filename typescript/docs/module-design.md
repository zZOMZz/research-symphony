# 核心模块设计思考

本文档详细说明每个核心模块在整体架构中的作用、设计考量和实现取舍。

---

## 1. types.ts — 领域模型

**作用**：定义系统中所有共享的数据结构，是所有模块的公共语言。

**设计思考**：

- 严格遵循 SPEC.md §4 中的实体定义，字段命名采用 snake_case 与 spec 保持一致（而非 TypeScript 惯用的 camelCase），降低 spec↔代码的对照成本
- `Issue` 是最核心的实体，被 tracker client（生产者）和 orchestrator/agent_runner（消费者）共同使用
- `RunningEntry` 包含了一个运行中 issue 的所有运行时状态，包括 token 计数、最后事件时间等——这些信息同时服务于调度决策（stall 检测）和可观测性（dashboard 展示）
- `ServiceConfig` 用嵌套 interface 而非单一扁平对象，对应 WORKFLOW.md front matter 的层级结构

**考虑的因素**：
- 类型安全 vs 灵活性：选择了严格的 interface 而非 `Record<string, any>`，虽然代码稍多但错误在编译期暴露
- 可选字段使用 `| null` 而非 `?`，因为 spec 明确区分了 "字段存在但值为空" 和 "字段可能不存在"

---

## 2. workflow.ts — 工作流加载器

**作用**：读取 `WORKFLOW.md`，分离 YAML front matter 和 Markdown prompt body，支持文件监听热更新。

**设计思考**：

- 这是整个系统的**配置入口**——所有运行时行为都从这个文件派生
- 实现了简单的内存缓存 (`cachedWorkflow`)，避免每次 `getSettings()` 都重新读文件
- `fs.watch` 监听文件变化触发重新加载，但加了 try-catch 保护——监听失败不阻塞启动

**考虑的因素**：
- 解析失败的处理：spec 要求 "Invalid reloads MUST NOT crash the service"，所以 `reloadWorkflow()` catch 了所有错误并返回 null，保留最后一次成功的配置
- 为什么不用 `chokidar`：`fs.watch` 够用且零额外依赖，这是一个运维工具不是开发工具

---

## 3. config.ts — 配置层

**作用**：将 workflow.config（raw YAML map）转换为强类型的 `ServiceConfig`，处理默认值、`$VAR` 环境变量解析、路径展开。

**设计思考**：

- **分层解析**：每个顶层 key（tracker、polling、workspace...）有独立的 parse 函数，一个 key 的解析错误不影响其他 key
- **`$VAR` 解析只在显式引用时生效**——环境变量不会全局覆盖 YAML 值（spec §6.1 明确要求）
- **路径展开**支持 `~` 和相对路径（相对于 WORKFLOW.md 所在目录解析）

**考虑的因素**：
- `validateDispatchConfig()` 是一个轻量级前置检查，不是完整验证——它只验证"能不能开始调度"所需的最小条件
- 为什么没有用 Zod/io-ts：这些库的验证错误信息对运维不够友好，且 config schema 相对稳定，手写解析的可控性更好

---

## 4. tracker/ — Issue Tracker 适配

**作用**：从外部 issue tracker 获取候选 issues、刷新 issue 状态、获取终态 issues。

**设计思考**：

- **接口抽象 (`TrackerClient`)**：三个方法对应三个使用场景：
  - `fetchCandidateIssues()` — 主循环拉取待调度 issues
  - `fetchIssueStatesByIds()` — reconciliation 检查运行中 issues 的最新状态
  - `fetchIssuesByStates()` — 启动时清理已终态的工作区
- **Linear 实现的关键细节**：
  - 分页是必须的（spec §11.2 要求），每页 50 条
  - `blockers` 从 `inverseRelations` 中 type=blocks 的关系提取
  - labels 统一转小写（spec §11.3）
  - GraphQL errors 与 HTTP errors 区分处理

**考虑的因素**：
- 分页中断保护：如果 `hasNextPage=true` 但 `endCursor` 为空，抛错而非无限循环
- 超时设置为 30s（spec 规定），使用 AbortController 实现

---

## 5. workspace.ts — 工作区管理

**作用**：为每个 issue 创建隔离的文件系统工作区，执行生命周期 hooks，确保路径安全。

**设计思考**：

这是 spec 中标注为 "最重要的可移植性约束" 的部分，核心是三个安全不变量：

1. **Coding agent 的 cwd 必须是 per-issue workspace path** — 不能跑在源码仓库里
2. **Workspace path 必须在 workspace root 内** — 防止目录遍历攻击
3. **目录名只允许 `[A-Za-z0-9._-]`** — 避免 shell 注入和文件系统问题

**Hooks 设计**：
- `after_create`：仅在目录新建时运行（已存在时复用），用于 git clone 等初始化
- `before_run`：每次 agent 运行前执行，用于 git pull 等同步操作
- `after_run`：运行后清理，失败不阻塞
- `before_remove`：删除前的归档等操作，失败不阻塞

**考虑的因素**：
- Hook 超时用子进程 SIGKILL 强制终止，避免挂起整个调度器
- 工作区创建失败时如果是新目录则清理残留（spec §9.3 要求）
- `validateWorkspacePath` 先做 `path.resolve` 再比较前缀，防止 `../` 逃逸

---

## 6. prompt.ts — Prompt 构建器

**作用**：使用 Liquid 模板引擎将 WORKFLOW.md 的 prompt body + issue 数据渲染为最终 prompt。

**设计思考**：

- **严格模式**：`strictVariables: true` + `strictFilters: true`——未知变量/过滤器立即报错而非静默忽略
- 模板输入只有两个顶层变量：`issue`（完整的 issue 对象）和 `attempt`（重试次数或 null）
- Issue 对象的 key 保持 string 类型（`issue.branch_name` 而非 `issue.branchName`），与 spec 定义一致

**考虑的因素**：
- 为什么用 Liquid 而非 Handlebars/Mustache：spec 明确说 "Liquid-compatible semantics are sufficient"
- DateTime 字段转为 ISO8601 string 传入模板，确保跨语言一致性

---

## 7. agent/ — Agent 后端适配

**作用**：抽象 coding agent 的启动、turn 执行、终止操作。

### codex_app_server.ts

这是最复杂的模块，实现了 Codex app-server 的完整 JSON-RPC 协议：

```
初始化：initialize → initialized
会话：  thread/start → 获取 thread_id
Turn：  turn/start → 流式处理事件 → turn/completed | turn/failed
```

**关键实现细节**：
- **审批自动处理**：命令执行、文件修改的审批请求自动以 "acceptForSession" 通过
- **User input 处理**：尝试找到 "Approve" 类选项自动选择，否则失败 turn
- **Tool call 分发**：支持 `linear_graphql` 动态工具，未知工具返回错误但不中断会话
- **超时分层**：`read_timeout_ms`（启动阶段）、`turn_timeout_ms`（执行阶段）、`stall_timeout_ms`（由 orchestrator 在外部检测）

### claude_code_backend.ts

相对简单的 CLI 集成：
- 使用 `--print --output-format stream-json` 获取结构化输出
- 通过 stdin 传入 prompt，stdout 读取 JSON stream
- 无需 thread/turn 概念——每次调用就是一个完整执行

**设计思考**：
- 两个 backend 的抽象粒度不同（Codex 有会话概念，Claude Code 没有），但统一到 `AgentSession.runTurn()` 接口
- `startSession` 对 Codex 是启动进程+握手+建线程，对 Claude Code 只是记录配置（进程在 runTurn 时创建）

---

## 8. agent_runner.ts — 执行编排

**作用**：组合 workspace、prompt、agent session 完成一个 issue 的多 turn 执行。

**核心循环**：

```
create workspace → before_run hook → start session
  ↓
  loop {
    build prompt → run turn → refresh issue state
    if (no longer active || max_turns reached) break
  }
  ↓
stop session → after_run hook
```

**设计思考**：
- 第一个 turn 使用完整渲染的 issue prompt，后续 continuation turn 只发简短的继续指令
- 每个 turn 完成后重新拉取 issue 状态，确保 tracker 中的状态变化能及时反映
- 使用 AbortSignal 支持外部取消（reconciliation 发现 issue 已终态时）

---

## 9. orchestrator.ts — 调度核心

**作用**：单一权威的调度循环，管理所有 issue 的生命周期状态。

**核心职责**：
1. **Poll**：定时拉取候选 issues
2. **Dispatch**：选择符合条件的 issues 派发给 worker
3. **Reconcile**：检查运行中 issues 的 tracker 状态，终止不再活跃的
4. **Retry**：异常退出 → 指数退避重试；正常退出 → 1s 延迟后检查是否需要继续

**调度排序**（spec §8.2）：
1. priority 升序（1 最高，null 最后）
2. created_at 最早优先
3. identifier 字典序兜底

**并发控制**：
- 全局上限 `max_concurrent_agents`
- 可选的 per-state 上限 `max_concurrent_agents_by_state`
- Todo 状态有 blocker 检查：任何 blocker 非终态则不调度

**Stall 检测**：
- 每次 tick 检查每个运行中 issue 的最后活动时间
- 超过 `stall_timeout_ms` → 终止 worker → 排入重试队列

**设计思考**：
- **单线程状态管理**：所有状态变更都在 orchestrator 的 tick/回调中发生，避免竞态
- **retry 与 continuation 分离**：正常退出的 issue 用 1s 短重试（检查是否还需要继续），失败用指数退避（避免频繁重试浪费资源）
- **claimed set 的意义**：防止 dispatch 和 retry 之间的时间窗口内重复调度同一个 issue

---

## 10. http_server.ts — 可观测性 HTTP 接口

**作用**：提供 Dashboard 和 JSON API 供运维人员查看系统状态。

**端点**：
- `GET /` — HTML Dashboard（5s 自动刷新）
- `GET /api/v1/state` — JSON 全局状态快照
- `GET /api/v1/:identifier` — 单个 issue 的详细状态
- `POST /api/v1/refresh` — 触发立即 poll

**设计思考**：
- Dashboard 使用 meta refresh 而非 WebSocket，保持实现简单
- API 只读（除了 /refresh），不影响调度正确性
- 错误响应统一使用 `{error: {code, message}}` 格式
