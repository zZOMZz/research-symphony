# 核心实现与最有价值的部分

## 一句话总结

Symphony 的核心价值是**将 "coding agent 执行 issue" 这件事从一次性脚本变成了可靠的、可观测的、自恢复的守护进程**。

---

## 核心实现：调度状态机

整个系统最关键的实现是 Orchestrator 中的**调度状态机**。它管理着每个 issue 从 "发现" 到 "完成" 的完整生命周期：

```
                  ┌──────────────────┐
                  │    Unclaimed     │ ← issue 在 tracker 中，但没有被 symphony 处理
                  └────────┬─────────┘
                           │ dispatch (poll tick 发现符合条件)
                           ▼
                  ┌──────────────────┐
                  │     Claimed      │ ← 已占位，防止重复调度
                  └────────┬─────────┘
                           │ worker spawned
                           ▼
         ┌────────────────────────────────────┐
         │              Running               │ ← worker 正在执行
         │  (tracked in running map)          │
         └──────┬────────────┬────────────┬───┘
                │            │            │
       worker   │   tracker  │   stall    │
       exits    │   terminal │   timeout  │
       normally │            │            │
                ▼            ▼            ▼
        ┌────────┐   ┌──────────┐  ┌──────────┐
        │ Retry  │   │ Released │  │  Retry   │
        │ (1s)   │   │ +cleanup │  │ (backoff)│
        └───┬────┘   └──────────┘  └────┬─────┘
            │                            │
            └──── retry timer fires ─────┘
                         │
                         ▼
              re-fetch candidates
              ├── still eligible → dispatch again
              ├── no longer active → release claim
              └── no slots → requeue with backoff
```

这个状态机的**精妙之处**在于：

1. **正常退出不等于完成**：worker 可能因为 max_turns 限制退出，但 issue 仍在 active 状态。1s 短重试让 orchestrator 重新检查，需要的话会开启新一轮执行。

2. **Reconciliation 是双向的**：
   - 运行中的 issue 在 tracker 上变成终态 → 立即停止 worker 并清理工作区
   - 运行中的 issue 变成非 active（比如被移到 "Backlog"）→ 停止 worker 但保留工作区

3. **重试的两种语义**：
   - Continuation retry（正常退出后）：delay = 1s，attempt = 1
   - Failure retry（异常退出后）：delay = min(10s × 2^(attempt-1), max_backoff)

---

## 最有价值的部分

### 1. 工作区隔离与安全

```typescript
export function validateWorkspacePath(workspacePath: string, workspaceRoot: string): void {
  const absWorkspace = path.resolve(workspacePath);
  const absRoot = path.resolve(workspaceRoot);

  if (absWorkspace === absRoot) {
    throw new WorkspaceError("workspace_equals_root", ...);
  }
  if (!absWorkspace.startsWith(absRoot + path.sep)) {
    throw new WorkspaceError("workspace_outside_root", ...);
  }
}
```

看起来简单，但这是**安全边界**。没有它，一个恶意的 issue identifier（如 `../../etc`）可能让 agent 在系统目录中执行命令。配合 `sanitizeIdentifier` 的正则替换，形成双重防护。

### 2. 可插拔的抽象层

```typescript
// 只需实现这个接口就能接入新的 tracker
interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;
  fetchIssuesByStates(states: string[]): Promise<...>;
}

// 只需实现这个接口就能接入新的 coding agent
interface AgentBackend {
  startSession(workspace: string, config: ServiceConfig): Promise<AgentSession>;
}
```

这两个接口是**扩展性的核心**。它们的方法签名是从实际使用场景中提取的（不是预先设计的），所以足够精简且每个方法都有明确的调用者。

### 3. Codex App-Server 协议实现

`agent/codex_app_server.ts` 是代码量最大的单一模块，也是与外部系统集成最复杂的部分。它处理了：

- JSON-RPC 请求/响应的 ID 匹配
- 流式事件的分类派发（turn 完成、审批请求、工具调用、通知...）
- 审批策略的自动响应
- 多种超时场景（启动超时、turn 超时、进程退出）

它的价值在于**将一个复杂的有状态协议封装为简单的 `startSession → runTurn → stopSession` 接口**，让上层代码（agent_runner）不需要关心协议细节。

### 4. Token 计量与增量计算

```typescript
// 使用绝对值 + 增量计算避免重复计数
const deltaInput = input - entry.last_reported_input_tokens;
if (deltaInput > 0) this.state.codex_totals.input_tokens += deltaInput;
entry.last_reported_input_tokens = input;
```

Codex 报告的是线程级累计 token 数，但 orchestrator 需要全局汇总。通过记录 "上次报告值" 计算增量，确保了：
- 同一个 session 的多次报告不会重复计数
- 进程重启后不会丢失已统计的量

### 5. 配置热更新

整个系统支持**不停机配置变更**：

- 修改 WORKFLOW.md → 自动检测 → 重新解析 → 下一个 tick 使用新配置
- 支持运行时更改：poll 间隔、并发上限、active/terminal 状态列表、prompt、hooks...
- 无效配置不会 crash 服务——保持最后已知的有效配置继续运行

这使得运维人员可以通过 git push 调整所有运行时行为，而不需要 SSH 到机器上重启进程。

---

## 从工程角度看价值

| 特性 | 没有 Symphony | 有 Symphony |
|------|--------------|------------|
| 执行方式 | 手动运行脚本或 cron | 持续运行的守护进程 |
| 隔离性 | 所有 agent 共享工作区 | 每个 issue 独立目录 |
| 失败恢复 | 需要人工重试 | 自动指数退避重试 |
| 并发控制 | 无/手动管理 | 全局+per-state 上限 |
| 可观测性 | 看日志文件 | 结构化日志 + HTTP API + Dashboard |
| 配置管理 | 环境变量散落各处 | 单一 WORKFLOW.md 版本管理 |
| 状态一致性 | 可能重复执行同一 issue | claimed set + reconciliation 保证唯一性 |

---

## 实现中的 Trade-offs

1. **内存状态 vs 持久化**：选择了内存状态+tracker 驱动恢复。好处是简单可靠，代价是重启后 retry 计时器丢失。对于大多数场景这是可接受的——重启后 poll 会重新发现 active issues。

2. **单进程 vs 分布式**：整个调度器是单进程的。好处是没有分布式锁、没有一致性问题。代价是受限于单机并发。对于管理 10-20 个并发 agent 绰绰有余。

3. **AbortController vs Worker Threads**：用 AbortController 做取消信号而非 Worker Threads 做真正隔离。好处是简单、共享内存状态容易。代价是一个失控的 agent 子进程可能需要 SIGKILL 才能清理。

4. **同步 vs 异步 tool executor**：`linear_graphql` 工具在当前实现中不支持真正的异步执行。这是一个已知的简化——在实际生产中可能需要在 tool call 时 await 一个 HTTP 请求。
